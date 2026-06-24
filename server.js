#!/usr/bin/env node
/**
 * Radio Streams Web Server — local MP3 jukebox
 *
 * Serves multiple MP3 folders under ~/RadioStations/ as selectable stations.
 * ESP32 fetches /api/esp to get a random track URL, plays it, and polls again.
 */

// Server clock in Asia/Shanghai — override at boot, before any Date is built.
// Server /etc/localtime stays UTC (no sudo), but app logic uses Beijing time
// everywhere so cron + Date math aligns with the 192 radio's expected schedule.
process.env.TZ = 'Asia/Shanghai';

const express = require('express');
const fs = require('fs');
const path = require('path');// Device readings storage (temperature + humidity per device per timestamp)
// Stored as JSON file: config/device_readings.json
// Format: [{device_id, ts (ISO), temperature, humidity, source}]
const DEVICE_READINGS_FILE = path.join(__dirname, 'config', 'device_readings.json');
const MAX_READINGS_PER_DEVICE = 24 * 60;  // ~ 1 reading/minute for 24h, plenty
let _deviceReadings = []; // in-memory cache
try { _deviceReadings = JSON.parse(fs.readFileSync(DEVICE_READINGS_FILE, 'utf-8')).device_readings || []; } catch (e) { _deviceReadings = []; }

function saveDeviceReadings() {
  try {
    fs.writeFileSync(DEVICE_READINGS_FILE, JSON.stringify({ device_readings: _deviceReadings }, null, 2), 'utf-8');
  } catch (e) { console.error('[readings] save failed:', e.message); }
}

function recordReading(device_id, temperature, humidity, source = 'device') {
  if (!device_id) return;
  if (temperature == null && humidity == null) return;
  _deviceReadings.push({
    device_id,
    ts: new Date().toISOString(),
    temperature: temperature == null ? null : Number(temperature),
    humidity: humidity == null ? null : Number(humidity),
    source,
  });
  // Trim by device: keep last MAX_READINGS_PER_DEVICE per device
  const byDevice = {};
  for (const r of _deviceReadings) {
    if (!byDevice[r.device_id]) byDevice[r.device_id] = [];
    byDevice[r.device_id].push(r);
  }
  const trimmed = [];
  for (const arr of Object.values(byDevice)) {
    if (arr.length > MAX_READINGS_PER_DEVICE) arr.splice(0, arr.length - MAX_READINGS_PER_DEVICE);
    trimmed.push(...arr);
  }
  trimmed.sort((a, b) => a.ts.localeCompare(b.ts));
  _deviceReadings = trimmed;
  saveDeviceReadings();
}

// Read temperature/humidity query params from /api/esp/* requests and
// record them. This is the ONLY way sensor data enters the system —
// POST /api/readings has been removed (see commit message).
// Both /api/esp and /api/esp/:deviceId use this helper so the behavior
// is identical regardless of which path the ESP32 firmware polls.
function recordEspSensors(req) {
  // Accept both long form (temperature=, humidity=) and short form (t=, h=).
  // ESP32 firmware uses ?t=&h= to keep request lines short; the long form
  // is for human curl and documentation.
  const tRaw = req.query.t ?? req.query.temperature;
  const hRaw = req.query.h ?? req.query.humidity;
  const t = tRaw != null && tRaw !== '' ? Number(tRaw) : null;
  const h = hRaw != null && hRaw !== '' ? Number(hRaw) : null;
  if (t == null && h == null) return null;
  // device_id precedence: explicit body > path param > client IP
  let id = req.params.deviceId
        || (req.body && req.body.device_id)
        || String(req.ip || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  recordReading(id, t, h, 'device');
  return { device_id: id, temperature: t, humidity: h };
}

// Auto-record QWeather readings once per hour (per device 'qweather')
let _lastWeatherRecordHour = null;
function maybeRecordWeather() {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  if (_lastWeatherRecordHour === hourKey) return;
  if (!currentLocalStation) return;
  getWeather().then(w => {
    if (!w || !w.now) return;
    const temp = w.now.temp;
    const humidity = w.now.humidity;
    if (temp == null && humidity == null) return;
    _lastWeatherRecordHour = hourKey;
    recordReading('qweather', temp, humidity, 'qweather');
  }).catch(() => {});
}

const os = require('os');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { exec, execSync } = require('child_process');
function execAsync(cmd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function execAsyncEnv(cmd, env, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf-8', env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function execSyncSafe(cmd, timeoutMs = 15000) {
  // Synchronous exec — blocks event loop, use only for short ops
  return execSync(cmd, { timeout: timeoutMs, encoding: 'utf-8' });
}

const PORT = process.env.PORT || 3000;

// Weather config — 和风天气, 余杭
const WEATHER_KEY = 'YOUR_QWEATHER_API_KEY_HERE';
const WEATHER_HOST = 'nn3aaqw4wr.re.qweatherapi.com';
const WEATHER_LOCATION = '101210106'; // 余杭
const STATE_FILE = path.join(__dirname, '.radio_state.json');

let currentVolume = 80; // 1-100
let currentLocalStation = null;
let ttsIntroEnabled = false;
const INTROS_DIR = path.join(os.homedir(), '.cache', 'radio_intros');
// Track played songs to avoid repetition in AI selection
const playedHistory = [];
const MAX_HISTORY = 999;

// Pre-generated intro buffers (songName -> Buffer)
// ESP32 has a 4s HTTP timeout, so /api/esp synchronously generates the
// intro and caches it here for the track endpoint to serve instantly.
const introBufferCache = {};
const MAX_INTRO_CACHE = 3;  // keep at most 3 intros in memory

// AI pre-selected song for next request (populated by background AI call)
let pendingSong = null;

const stations_map = {};

// Ensure intros temp directory exists
try { fs.mkdirSync(INTROS_DIR, { recursive: true }); } catch (e) {}

// ---------------------------------------------------------------
// State persistence — only volume survives restarts
// ---------------------------------------------------------------
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (data.volume && data.volume >= 1 && data.volume <= 100) {
        currentVolume = data.volume;
      }
      if (typeof data.ttsIntroEnabled === 'boolean') {
        ttsIntroEnabled = data.ttsIntroEnabled;
      }
    }
  } catch (e) { console.error('loadState error:', e.message); }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ volume: currentVolume, ttsIntroEnabled }));
  } catch (e) { console.error('saveState error:', e.message); }
}

// ---------------------------------------------------------------
// TTS Intro — generate dynamic song introductions with context
// ---------------------------------------------------------------
// No caching — every play gets a fresh AI-generated intro with
// current weather, time, and environment context.

function fetchWeatherData() {
  return new Promise((resolve) => {
    const base = `https://${WEATHER_HOST}`;
    const nowUrl = `${base}/v7/weather/now?location=${WEATHER_LOCATION}&key=${WEATHER_KEY}`;
    const forecastUrl = `${base}/v7/weather/7d?location=${WEATHER_LOCATION}&key=${WEATHER_KEY}`;
    Promise.all([
      fetchWeather(nowUrl),
      fetchWeather(forecastUrl),
    ]).then(([now, forecast]) => {
      if (now.code === '200' && forecast.code === '200') {
        resolve({
          temp: now.now.temp,
          text: now.now.text,
          humidity: now.now.humidity,
          tempMin: forecast.daily[0].tempMin,
          tempMax: forecast.daily[0].tempMax,
          textDay: forecast.daily[0].textDay,
          textNight: forecast.daily[0].textNight,
        });
      } else {
        resolve(null);
      }
    }).catch(() => resolve(null));
  });
}

function getTimePeriod() {
  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }));
  if (h < 6) return '凌晨';
  if (h < 9) return '早晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 21) return '傍晚';
  return '晚上';
}

function getWeatherDesc(w) {
  if (!w) return null;
  let parts = [`${w.text}，${w.temp}°C`];
  if (w.tempMin && w.tempMax) {
    parts.push(`全天${w.tempMin}~${w.tempMax}°C`);
  }
  if (w.humidity) parts.push(`湿度${w.humidity}%`);
  if (w.textDay && w.textNight && w.textDay !== w.textNight) {
    parts.push(`白天${w.textDay}，夜间${w.textNight}`);
  } else if (w.textDay) {
    parts.push(`白天夜间均${w.textDay}`);
  }
  return parts.join('，');
}

/**
 * Generate a fresh intro for a song: AI text + TTS + transcode.
 * Returns a Buffer of 44.1kHz stereo MP3 audio (or null on failure).
 * No caching — every call generates anew.
 */
async function generateIntro(songName, weatherData) {
  const timePeriod = getTimePeriod();
  const weatherStr = getWeatherDesc(weatherData);
  const contextParts = [`现在是${timePeriod}`];
  if (weatherStr) contextParts.push(weatherStr);
  const contextStr = contextParts.join('，');

  // 1) Generate intro text with AI (always fresh with weather/time context)
  let text = null;
  console.log(`[tts] AI generating intro for: ${songName} (${contextStr})`);
  try {
    const result = await execAsync(
      `mmx text chat --system ${JSON.stringify('你是一个电台DJ。根据歌名和当前天气时间生成一段15-20秒的中文播报文案，自然亲切，像对听众说话。把天气时间自然地融入播报中。不超过80个字。只说内容本身。')} --message ${JSON.stringify(`歌名：${songName}，当前：${contextStr}`)} --non-interactive --quiet --output text 2>/dev/null`,
      15000
    );
    const aiText = result.trim();
    if (aiText && aiText.length > 5) {
      text = aiText;
      console.log(`[tts] AI text: ${text.substring(0, 80)}`);
    } else {
      console.log(`[tts] AI text empty (len=${aiText.length})`);
    }
  } catch (e) {
    console.error(`[tts] AI text gen failed: ${e.message}`);
  }

  // Fallback if AI failed
  if (!text) {
    text = `接下来请欣赏《${songName}》`;
  }


// TTS intro gain — applies during lame re-encode step (after mono2stereo).
// 1.0 = unchanged, 1.20 = +20% (default). Tune if TTS is too soft relative to song.
const TTS_GAIN = 1.20;
  // 2) TTS + transcode
  return await synthesizeIntro(text, songName);
}

/**
 * Synthesize TTS from pre-generated text and transcode to 44.1kHz stereo MP3.
 * Returns a Buffer or null on failure.
 */
function synthesizeIntro(text, songName = '未知') {
  const tmpDir = path.join(os.tmpdir(), 'radio_intros');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
  const rawWav = path.join(tmpDir, `${Date.now()}_${Math.random().toString(36).slice(2,8)}.wav`);
  const stereoWav = rawWav + '_stereo.wav';
  const outMp3 = rawWav + '.mp3';

  // All exec calls wrapped in promise so they don't block the event loop
  return (async () => {
    try {
      console.log(`[tts] Synthesizing speech for: ${songName}`);
      await execAsync(
        `mmx speech synthesize --voice 'Chinese (Mandarin)_Male_Announcer' --format wav --text ${JSON.stringify(text)} --out ${JSON.stringify(rawWav)}`,
        15000
      );

      // Transcode
      const lameBin = path.join(__dirname, 'node_modules', 'node-lame', 'vendor', 'lame', 'linux-x64', 'lame');
      const libDir = path.join(__dirname, 'node_modules', 'node-lame', 'vendor', 'lame', 'linux-x64', 'lib');
      if (fs.existsSync(lameBin)) {
        const env = Object.assign({}, process.env, { LD_LIBRARY_PATH: libDir + ':' + (process.env.LD_LIBRARY_PATH || '') });
        const monoScript = path.join(__dirname, 'scripts', 'mono2stereo.js');
        await execAsync(`node "${monoScript}" "${rawWav}" "${stereoWav}"`, 10000);
        await execAsyncEnv(`"${lameBin}" --quiet --resample 44.1 -m s --scale ${TTS_GAIN} "${stereoWav}" "${outMp3}"`, env, 15000);
      } else {
        // No lame — use raw WAV
        fs.renameSync(rawWav, outMp3);
      }

      const buf = fs.readFileSync(outMp3);
      // Cleanup temp files
      try { fs.unlinkSync(rawWav); } catch (e) {}
      try { fs.unlinkSync(stereoWav); } catch (e) {}
      try { fs.unlinkSync(outMp3); } catch (e) {}
      console.log(`[tts] Intro generated: ${buf.length} bytes`);
      return buf;
    } catch (e) {
      console.error(`[tts] Failed to generate intro: ${e.message}`);
      // Cleanup on failure
      try { fs.unlinkSync(rawWav); } catch (e) {}
      try { fs.unlinkSync(stereoWav); } catch (e) {}
      try { fs.unlinkSync(outMp3); } catch (e) {}
      return null;
    }
  })();
}

// ---------------------------------------------------------------
// RadioStation — one folder of MP3s
// ---------------------------------------------------------------
const LOCAL_METAINT = 8192;
const STATIONS_DIR = process.env.STATIONS_DIR || '/home/zulin/Music/网易云收藏';

// Recursively walk a directory, returning absolute paths of all .mp3 files.
// Skips macOS resource-fork / metadata files (._* prefix) and any dotfile.
// Used by both station _loadFiles() and the /api/library route so they
// stay in sync. Returns paths sorted for stable ordering.
function walkMp3(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.error(`[walkMp3] readdir ${dir} failed: ${e.message}`);
      continue;
    }
    for (const ent of entries) {
      // Skip macOS metadata / hidden files (e.g. ._Childhood.mp3, .DS_Store)
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.mp3')) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

// Async walker for the 9p-mounted /mnt/music share. Same semantics as
// walkMp3, but uses fs.promises. NOTE: even with fs.promises, the underlying
// readdir is still synchronous at the kernel level for 9p mounts with
// `dirsync`. The real fix for non-blocking is to limit concurrency and add
// timeouts — see walkMp3One().
async function walkMp3Async(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      console.error(`[walkMp3Async] readdir ${dir} failed: ${e.message}`);
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.mp3')) {
        out.push(full);
      }
    }
    // Yield to event loop so HTTP handlers can run between directories.
    await new Promise(r => setImmediate(r));
  }
  out.sort();
  return out;
}

// Walk a single directory with a hard timeout. Used so that a 9p hang on
// one subdir doesn't lock up the whole station (and main thread). Returns
// [] on timeout.
//
// Implementation: fork a child process to run the synchronous walkMp3 in.
// The child gets a SIGKILL after timeoutMs regardless of state, so even
// if 9p deadlocks the syscall inside the child, the parent survives and
// gets a result (empty array) within the timeout.
function walkMp3Safe(rootDir, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    // Node's `-e CODE ARG1 ARG2` puts only `[node, ARG1, ARG2, ...]` in argv
    // (the `-e` and the code itself are consumed). So rootDir ends up at
    // argv[1], not argv[2]. (Verified empirically — for
    // `spawn(node, ['-e', code, rootDir])` argv.length === 2 and rootDir
    // is at index 1.)
    const code = `
      const fs = require('fs');
      const path = require('path');
      const rootDir = process.argv[1];
      if (!rootDir) { process.stdout.write('[]'); process.exit(0); }
      const out = [];
      const stack = [rootDir];
      try {
        while (stack.length) {
          const dir = stack.pop();
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
          catch (e) { continue; }
          for (const ent of entries) {
            if (ent.name.startsWith('.')) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile() && ent.name.toLowerCase().endsWith('.mp3')) out.push(full);
          }
        }
        out.sort();
        process.stdout.write(JSON.stringify(out));
      } catch (e) {
        process.stdout.write('[]');
      }
    `;
    const child = spawn(process.execPath, ['-e', code, rootDir], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[walkMp3Safe] ${rootDir}: hard timeout ${timeoutMs}ms, SIGKILL child`);
      try { child.kill('SIGKILL'); } catch {}
      resolve([]);
    }, timeoutMs);
    child.stdout.on('data', d => { buf += d.toString(); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const arr = JSON.parse(buf || '[]');
        resolve(Array.isArray(arr) ? arr : []);
      } catch {
        resolve([]);
      }
    });
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[walkMp3Safe] ${rootDir}: spawn error ${e.message}`);
      resolve([]);
    });
  });
}

class RadioStation {
  constructor(id, name, dir) {
    this.id = id;
    this.name = name;
    this.dir = dir;
    this.files = [];       // sorted list of file paths
    this.fileInfos = [];   // [{name, title, sizeMB, bitrate}]
    this.currentSong = '';
    this.currentPos = 0;   // bytes streamed into current song (after ID3 strip)
    this.currentTotal = 0; // total bytes of current song (after ID3 strip)
    this._playlist = null; // shuffled API playlist
    this._playIdx = 0;
    this._loadPromise = null;  // resolved once loadFiles() finishes
    // Do NOT call _loadFiles() here — the station directory can be on a
    // slow 9p share, and a synchronous scan would block the event loop for
    // minutes. Callers that need files (nextTrack, /api/library, /api/esp)
    // either await station.ready() or call reload() themselves.
  }

  // Async equivalent of the old _loadFiles(). Uses fs.promises so the
  // event loop keeps responding to HTTP requests even while walking a slow
  // 9p share. Yields between subdirectories for the same reason.
  //
  // Goes through the global 9p scan lock so concurrent callers (e.g. UI
  // opening /api/library while startup is still scanning) don't open
  // multiple readdir workers and deadlock 9p.
  loadFiles() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = withScanLock(() => this._loadFilesAsync());
    return this._loadPromise;
  }

  async _loadFilesAsync() {
    // Run the recursive walk in a forked child process so a 9p hang only
    // blocks the child, not the main HTTP-serving event loop. The child is
    // SIGKILL'd after 60s if it doesn't finish.
    let files;
    try {
      files = await walkMp3Safe(this.dir, 60000);
    } catch (e) {
      console.error(`[station] ${this.name}: walk error ${e.message}`);
      files = [];
    }
    this.files = files;
    // Build fileInfos without stat'ing every file — statSync on a 9p share
    // is slow and 19k stats have been observed to deadlock the 9p client.
    // sizeMB / title are computed lazily when actually needed.
    this.fileInfos = files.map(f => {
      const base = path.basename(f, '.mp3');
      const sameNamed = files.filter(x => path.basename(x, '.mp3') === base);
      const name = sameNamed.length > 1
        ? `${path.basename(path.dirname(f))}/${base}`
        : base;
      return { name, title: name, sizeMB: null, bitrate: 0, _path: f };
    });
    console.log(`[station] ${this.name}: ${this.fileInfos.length} songs from ${this.dir}`);
  }

  // Reload files from disk — used by /api/library/rescan to pick up newly
  // added MP3s without restarting the server process.
  async reload() {
    this._playlist = null;
    this._playIdx = 0;
    await this.loadFiles();
    return this.fileInfos.length;
  }

  _readBitrate(fp) {
    try {
      const fd = fs.openSync(fp, 'r');
      const b = Buffer.alloc(4);
      fs.readSync(fd, b, 0, 4, 0);
      fs.closeSync(fd);
      if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) {
        const ver = (b[1] >> 3) & 3;
        const bri = (b[2] >> 4) & 0x0F;
        const tbl = {3:[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0],2:[0,32,48,56,64,80,96,112,128,160,192,224,256,320,384,0],0:[0,32,48,56,64,80,96,112,128,160,192,224,256,320,384,0]};
        return (tbl[ver]||tbl[3])[bri] || 128;
      }
      return 128;
    } catch { return 128; }
  }

  _readTitle(fp) {
    try {
      const fd = fs.openSync(fp, 'r');
      const h = Buffer.alloc(10);
      fs.readSync(fd, h, 0, 10, 0);
      if (h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) { fs.closeSync(fd); return null; }
      const sz = ((h[6]&0x7f)<<21)|((h[7]&0x7f)<<14)|((h[8]&0x7f)<<7)|(h[9]&0x7f);
      const tag = Buffer.alloc(sz);
      fs.readSync(fd, tag, 0, sz, 10);
      fs.closeSync(fd);
      let p = 0;
      while (p+10 <= tag.length) {
        const fid = tag.slice(p,p+4).toString();
        const fs2 = (tag[p+4]<<24)|(tag[p+5]<<16)|(tag[p+6]<<8)|tag[p+7];
        if (fid === 'TIT2' && fs2 > 1) {
          const enc = tag[p+10]; const raw = tag.slice(p+11, p+10+fs2);
          if (enc === 0) return raw.toString('latin1').replace(/\0/g,'').trim();
          if (enc === 1||enc===2) return raw.toString('utf16le').replace(/\0/g,'').replace(/^\uFEFF/,'').trim();
          return raw.toString('utf-8').replace(/\0/g,'').trim();
        }
        p += 10+fs2;
        if (fid === '\x00\x00\x00\x00') break;
      }
    } catch {}
    return null;
  }

  _loadFiles() {
    try {
      const files = walkMp3(this.dir);
      this.files = files;
      this.fileInfos = files.map(f => {
        const stat = fs.statSync(f);
        // Display name: filename without .mp3. Disambiguate same-name files
        // across subdirs by appending the parent folder when collisions exist.
        const base = path.basename(f, '.mp3');
        const sameNamed = files.filter(x => path.basename(x, '.mp3') === base);
        const name = sameNamed.length > 1
          ? `${path.basename(path.dirname(f))}/${base}`
          : base;
        const title = this._readTitle(f) || name;
        const bitrate = this._readBitrate(f);
        return { name, title, sizeMB: (stat.size/1024/1024).toFixed(1), bitrate, _path: f };
      });
      console.log(`[station] ${this.name}: ${files.length} songs from ${this.dir} (recursive)`);
    } catch (e) {
      console.error(`[station] Error loading ${this.dir}: ${e.message}`);
      this.files = [];
      this.fileInfos = [];
    }
  }

  // Reload files from disk — used by /api/library/rescan to pick up newly
  // added MP3s without restarting the server process. Async — must NOT use
  // the synchronous walkMp3 + statSync path because that fires 19k stats
  // straight onto the 9p client and deadlocks the whole process.
  async reload() {
    this._playlist = null;
    this._playIdx = 0;
    await this.loadFiles();
    return this.fileInfos.length;
  }

  _stripId3(buf) {
    let off = 0;
    if (buf.length>10 && buf[0]===0x49 && buf[1]===0x44 && buf[2]===0x33) {
      off = 10 + (((buf[6]&0x7f)<<21) | ((buf[7]&0x7f)<<14) | ((buf[8]&0x7f)<<7) | (buf[9]&0x7f));
    }
    let end = buf.length;
    if (end>=128 && buf[end-128]===0x54 && buf[end-127]===0x41 && buf[end-126]===0x47) end -= 128;
    return buf.slice(off, end);
  }

  // Strip encoder padding junk after the last valid MP3 frame.
  // Some encoders pad with 0xAA / 0x55 / 0x00 to byte-align the file, and these
  // bytes show up as noise clicks on the I2S DAC after the music stops.
  // We trim trailing runs of common padding bytes from the end of the buffer.
  _stripPadding(buf) {
    let end = buf.length;
    while (end > 0) {
      const b = buf[end - 1];
      if (b === 0xAA || b === 0x55 || b === 0x00) end--;
      else break;
    }
    return buf.slice(0, end);
  }

  _cleanAudio(buf) {
    return this._stripPadding(this._stripId3(buf));
  }

  // Next track for /api/esp — Fisher–Yates shuffle, single pass per round
  nextTrack() {
    if (!this._playlist || this._playIdx >= this._playlist.length) {
      this._playlist = [...this.files];
      for (let i = this._playlist.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this._playlist[i], this._playlist[j]] = [this._playlist[j], this._playlist[i]];
      }
      this._playIdx = 0;
    }
    const fp = this._playlist[this._playIdx++];
    const name = path.basename(fp, '.mp3');
    this.currentSong = name;
    this.currentPos = 0;
    const fileBuf = this._stripId3(fs.readFileSync(fp));
    this.currentTotal = fileBuf.length;
    return { name, filepath: fp };
  }

  // Return current shuffled playlist order with now-playing index
  getPlaylist() {
    if (!this._playlist) return [];
    return this._playlist.map((fp, i) => ({
      name: path.basename(fp, '.mp3'),
      idx: i,
      current: path.basename(fp, '.mp3') === this.currentSong,
      next: i === this._playIdx && path.basename(fp, '.mp3') !== this.currentSong,
    }));
  }

  // Set next track by name — move _playIdx to point to this song
  setNextTrack(name) {
    if (!this._playlist) return false;
    const idx = this._playlist.findIndex(fp => path.basename(fp, '.mp3') === name);
    if (idx < 0) return false;
    this._playIdx = idx;
    return true;
  }

  // Long-lived stream for /audio/local/playlist
  serve(socket, {icy = true} = {}) {
    if (this.files.length === 0) { socket.end('No MP3 files'); return; }
    let aborted = false, paused = false;
    socket.on('close', () => { aborted = true; });
    socket.on('drain', () => { paused = false; process.nextTick(pump); });
    const metaInt = LOCAL_METAINT;
    const files = [...this.files];
    for (let i=files.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [files[i],files[j]]=[files[j],files[i]]; }
    let idx = 0, fileBuf = null, pos = 0, buf = Buffer.alloc(0);

    const makeMeta = (name) => {
      const m = Buffer.from(`StreamTitle='${(name||'').replace(/'/g,"\\'")}';`, 'utf-8');
      const l = Math.ceil((m.length+1)/16); const p = Buffer.alloc(l*16,0); m.copy(p);
      const h = Buffer.alloc(1); h[0]=l; return Buffer.concat([h,p]);
    };

    const flushMeta = (name) => {
      if (!icy) {
        if (buf.length > 0) { if (!socket.write(buf)) paused = true; buf = Buffer.alloc(0); }
        return;
      }
      const pad = metaInt - (buf.length % metaInt);
      if (pad > 0 && pad < metaInt) buf = Buffer.concat([buf, Buffer.alloc(pad, 0)]);
      if (buf.length > 0) { if (!socket.write(buf)) paused = true; buf = Buffer.alloc(0); }
      if (!paused) socket.write(makeMeta(name));
    };

    const loadNext = () => {
      if (aborted) return;
      if (idx >= files.length) idx = 0;
      const fp = files[idx++];
      const name = path.basename(fp, '.mp3');
      this.currentSong = name;
      this.currentPos = 0;
      console.log(`[${this.name}] ${name}`);
      if (buf.length > 0) flushMeta(path.basename(files[(idx-2+files.length)%files.length],'.mp3'));

      // TTS intro: send cached intro before song (for continuous stream)
      if (ttsIntroEnabled) {
        const introPath = getIntroPath(name);
        if (fs.existsSync(introPath)) {
          try {
            const introRaw = fs.readFileSync(introPath);
            const introBuf = this._stripId3(introRaw);
            if (introBuf.length > 0 && !aborted) {
              socket.write(introBuf);
            }
          } catch (e) {
            console.error(`[tts] stream intro failed: ${e.message}`);
          }
        } else {
          // Generate intro asynchronously — server will have it next time
          setImmediate(() => { ensureIntro(name); });
        }
      }

      try { fileBuf = this._stripId3(fs.readFileSync(fp)); pos = 0; this.currentTotal = fileBuf.length; } catch { setImmediate(loadNext); return; }
      pump();
    };

    const pump = () => {
      if (aborted || paused) return;
      if (!fileBuf) { setImmediate(loadNext); return; }
      while (pos < fileBuf.length) {
        const take = Math.min(metaInt, fileBuf.length-pos);
        buf = Buffer.concat([buf, fileBuf.slice(pos, pos+take)]);
        pos += take;
        this.currentPos = pos;
        while (buf.length >= metaInt) {
          const chunk = buf.slice(0, metaInt);
          buf = buf.slice(metaInt);
          if (!socket.write(chunk)) { paused = true; return; }
          if (icy) socket.write(Buffer.alloc(1, 0));
        }
        if (pos >= fileBuf.length) { fileBuf = null; setImmediate(loadNext); return; }
      }
    };
    loadNext();
  }
}

// ---------------------------------------------------------------
// Load all local stations — runs AFTER server.listen() so the HTTP port is
// up while stations are still being scanned. The /mnt/music share is mounted
// over 9p and a recursive scan of 20k+ files can take minutes; blocking
// listen() would make the whole server unreachable until then.
//
// We schedule the scan with setImmediate in the listen callback so HTTP
// starts accepting connections first, and the async walkMp3Async yields
// between directories so the rescan button (and other endpoints) stay
// responsive mid-scan.
// ---------------------------------------------------------------
function loadMainStation() {
  // Single-library mode (refactor 2026-06-21): the 25-station switcher is gone.
  // We mount STATIONS_DIR as ONE virtual station and let RadioStation do the
  // walk. ESP32 /api/esp still pulls a random track from this single pool.
  //
  // Same async/scanLock dance as before — slow STATIONS_DIR must not block
  // HTTP listen() so we schedule with setImmediate in the listen callback.
  (async () => {
    try {
      const single = new RadioStation('library', 'library', STATIONS_DIR);
      stations_map.library = single;
      currentLocalStation = single;
      await single.loadFiles();
      console.log(`[station] single library loaded ${single.fileInfos.length} songs from ${STATIONS_DIR}`);
    } catch (e) {
      console.error(`[station] library load failed: ${e.message}`);
    }
  })();
}

loadState();

// ---------------------------------------------------------------
// Pre-built playlist (定时批量预生成) — fast path for /api/esp
// ---------------------------------------------------------------
// .radio_playlist/current.json 由 scripts/generate_playlist.js 维护（cron 触发，
// 每天 07:00 / 21:00）。存在且未过期时，/api/esp 直接走 playlist 路径：
// AI 选歌 + TTS 都已经在批处理里做完，热路径只是 JSON 读取 + 文件 stat。
// 缺失/过期时 /api/esp 回退到旧的实时 AI 模式，并后台触发一次生成。
// ---------------------------------------------------------------
const PLAYLIST_ROOT = path.join(__dirname, '.radio_playlist');
const PLAYLIST_JSON = path.join(PLAYLIST_ROOT, 'current.json');
const INTRO_REL_DIR = 'intros';
const GENERATE_SCRIPT = path.join(__dirname, 'scripts', 'generate_playlist.js');

let _nextCursor = 0;            // current index in the pre-built playlist
let _nextPlaylist = null;
let _nextPlaylistStamp = null;
let _lastBgGenAttempt = 0;      // 节流：每 5 分钟最多后台触发一次生成

// Per-device cursors for /api/esp/<deviceId>
// Map<deviceId, {cursor, playlistStamp}>
const _deviceCursors = new Map();

function loadCurrentPlaylist() {
  // Re-read .radio_playlist/current.json on every call. Cheap (~few KB).
  // If the stamp changed (new playlist generated), reset the cursor.
  try {
    if (!fs.existsSync(PLAYLIST_JSON)) return null;
    const data = JSON.parse(fs.readFileSync(PLAYLIST_JSON, 'utf8'));
    if (data.generated_at !== _nextPlaylistStamp) {
      _nextPlaylistStamp = data.generated_at;
      _nextCursor = 0;
      console.log(`[playlist] Loaded new playlist: ${data.songs.length} songs, generated ${data.generated_at}`);
    }
    _nextPlaylist = data;
    return data;
  } catch (e) {
    _nextPlaylist = null;
    return null;
  }
}

function isPlaylistFresh(pl) {
  if (!pl || !pl.valid_until) return false;
  return new Date(pl.valid_until) > new Date();
}

function maybeGenerateInBackground(reason) {
  // 节流：避免 stale playlist 触发风暴
  const now = Date.now();
  if (now - _lastBgGenAttempt < 5 * 60 * 1000) return;
  _lastBgGenAttempt = now;

  if (!fs.existsSync(GENERATE_SCRIPT)) return;
  console.log(`[playlist] Triggering background generation (reason: ${reason})`);
  const child = exec(`node ${JSON.stringify(GENERATE_SCRIPT)}`, (err) => {
    if (err) console.error(`[playlist] Background generation failed: ${err.message}`);
    else console.log(`[playlist] Background generation done`);
  });
  child.stdout.on('data', d => process.stdout.write(`[playlist-bg] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[playlist-bg] ${d}`));
}

// 启动时检查一次：playlist 缺失或过期就提示，但不在启动时立即生成
// （留给第一次 /api/esp 命中时触发，避免拖慢 server.js 启动）
{
  const initial = loadCurrentPlaylist();
  if (!isPlaylistFresh(initial)) {
    console.log('[startup] No fresh playlist — will generate on first /api/esp miss');
  } else {
    console.log(`[startup] Using playlist from ${initial.generated_at} (valid until ${initial.valid_until})`);
  }
}

// ---------------------------------------------------------------
// Weather cache — shared between playlist fast path and fallback
// ---------------------------------------------------------------
let _weatherCache = null;
let _weatherCacheTime = 0;
const WEATHER_CACHE_TTL = 60_000;  // 1 minute

async function getWeather() {
  const now = Date.now();
  if (_weatherCache && now - _weatherCacheTime < WEATHER_CACHE_TTL) {
    return _weatherCache;
  }
  // Fire and cache; return null on fail (caller handles null)
  try {
    const w = await fetchWeatherData();
    if (w) {
      _weatherCache = w;
      _weatherCacheTime = now;
      return w;
    }
  } catch {}
  return _weatherCache;  // Return stale cache rather than nothing
}

// ---------------------------------------------------------------
// Express app
// ---------------------------------------------------------------
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
// Request logger — captures API request/response pairs.
const requestLog = [];
let logCounter = 0;
const MAX_LOG_ENTRIES = 300;
const EXCLUDE_PATTERNS = [
  '/api/devices', '/api/weather', '/api/time',
  '/api/source', '/api/playlist', '/api/status',
  '/api/log', '/favicon.ico',
];
function shouldLog(req) {
  var url = req.url;
  if (!url.startsWith('/api/') && url !== '/') return false;
  for (var i = 0; i < EXCLUDE_PATTERNS.length; i++) {
    if (url.startsWith(EXCLUDE_PATTERNS[i])) return false;
  }
  return true;
}
app.use(function(req, res, next) {
  if (!shouldLog(req)) return next();
  var entry = {
    id: ++logCounter, ts: new Date().toISOString(),
    method: req.method, url: req.url,
    ip: req.ip || req.connection.remoteAddress || 'unknown',
    query: Object.keys(req.query||{}).length ? req.query : undefined,
    body: req.body, response: null, status: null,
  };
  if (requestLog.length >= MAX_LOG_ENTRIES) requestLog.shift();
  requestLog.push(entry);
  var origJson = res.json.bind(res);
  var origSend = res.send.bind(res);
  res.json = function(body) { entry.response = { body: JSON.stringify(body).slice(0,3000), truncated: JSON.stringify(body).length>3000 }; entry.status = this.statusCode; return origJson(body); };
  res.send = function(body) { var s = typeof body==='string'?body:JSON.stringify(body); entry.response = { body: s.slice(0,3000), truncated: s.length>3000 }; entry.status = this.statusCode; return origSend(body); };
  next();
});

// /favicon.ico -- browsers auto-request it; return 204 instead of 404 to
// silence DevTools noise. We don't ship an icon yet.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Home page
app.get('/', (req, res) => {
  res.render('index');
});

// Song library page
app.get('/library', (req, res) => {
  res.render('library');
});

// Legacy URL aliases — some browsers cache old redirects / users have old
// bookmarks. Forward them to the new canonical paths instead of 404'ing.
app.get('/history', (req, res) => res.redirect(301, '/library'));
app.get('/log', function(req, res) { res.render('log'); });
app.get('/api/log', function(req, res) {
  res.json({
    count: requestLog.length,
    entries: requestLog.slice(-150).reverse().map(function(e) {
      return { id: e.id, ts: e.ts, method: e.method, url: e.url, ip: e.ip, status: e.status||0, body: e.body, response: e.response ? { body: e.response.body, truncated: e.response.truncated } : null };
    }),
  });
});
app.post('/api/log/clear', function(req, res) { requestLog.length = 0; res.json({ ok: true }); });
// ---------------------------------------------------------------
// Device readings (temperature + humidity)
// ---------------------------------------------------------------

// Page
app.get('/temps', function(req, res) { res.render('temps'); });

// List all known devices
app.get('/api/devices/list', function(req, res) {
  // Only devices that have a reading in the last 7 days, so the dropdown
  // doesn't accumulate old/test entries forever.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = new Set();
  for (const r of _deviceReadings) {
    if (new Date(r.ts).getTime() >= cutoff) recent.add(r.device_id);
  }
  const devices = [...recent].sort();
  res.json({ devices, count: devices.length });
});

// Query readings with optional filters
app.get('/api/readings', function(req, res) {
  const { device, days = '1' } = req.query;
  const cutoff = Date.now() - (Number(days) || 1) * 86400 * 1000;
  let result = _deviceReadings.filter(r => new Date(r.ts).getTime() >= cutoff);
  if (device && device !== 'all') result = result.filter(r => r.device_id === device);
  // Group by device for chart convenience
  const byDevice = {};
  for (const r of result) {
    if (!byDevice[r.device_id]) byDevice[r.device_id] = [];
    byDevice[r.device_id].push(r);
  }
  res.json({ count: result.length, readings: result, byDevice });
});

// Manual insert (used by ESP devices reporting their sensors; also accepts batch)
// POST /api/readings has been removed — temperature/humidity can ONLY
// be uploaded via /api/esp or /api/esp/:deviceId (query params).

// Hook into /api/esp/:deviceId — if request supplies sensor data via query or body, record it
// (Devices will call POST /api/readings separately if they want rich telemetry)
// Auto-record QWeather hourly too:
setInterval(maybeRecordWeather, 5 * 60 * 1000);  // check every 5min, dedupe by hour
// Run once on startup (after 10s grace so weather is initialized)
setTimeout(maybeRecordWeather, 10000);
app.get('/admin', (req, res) => res.redirect(301, '/dj'));

// Current shuffled playlist order
app.get('/api/playlist', (req, res) => {
  if (!currentLocalStation) {
    return res.json({ playlist: [], currentSong: null });
  }
  res.json({
    playlist: currentLocalStation.getPlaylist(),
    currentSong: currentLocalStation.currentSong,
  });
});

// ---------------------------------------------------------------
// /api/source — current playback source (library vs AI playlist)
// ---------------------------------------------------------------
// Returns which mode /api/esp is currently using, plus enough data for the
// home page to render appropriately. Web polls this every few seconds so the
// UI can switch between "library shuffle" and "AI playlist" displays when a
// scheduled DJ batch kicks in or expires.
// ---------------------------------------------------------------
app.get('/api/source', (req, res) => {
  const pl = loadCurrentPlaylist();
  const usePlaylist = isPlaylistFresh(pl) && pl.songs && pl.songs.length > 0;

  if (usePlaylist) {
    // Playlist mode — round-robin cursor from /api/esp fast path
    return res.json({
      mode: 'playlist',
      playlist: {
        generated_at: pl.generated_at,
        valid_until: pl.valid_until,
        weather: pl.weather,
        time_of_day: pl.time_of_day,
        hour: pl.hour,
        songs: pl.songs,
        current_index: 0,
        total: pl.songs.length,
        stats: pl.stats || null,
      },
      library: null,
    });
  }

  // Library mode — fallback when no playlist is ready. Under
  // feat/netease-only the "library" is just the netease-downloaded
  // songs, with no exclusion list (toggle endpoints were removed). We
  // flatten everything in /home/zulin/Music/网易云收藏/ as a fallback song pool.
  function getAllActiveSongs() {
    const NETEASE_DIR = '/home/zulin/Music/网易云收藏';
    const songs = [];
    if (!fs.existsSync(NETEASE_DIR)) return songs;
    for (const f of fs.readdirSync(NETEASE_DIR)) {
      if (!f.toLowerCase().endsWith('.mp3')) continue;
      const stem = f.replace(/\.mp3$/i, '');
      const fStat = fs.statSync(path.join(NETEASE_DIR, f));
      songs.push({ name: stem, sizeMB: (fStat.size / (1024 * 1024)).toFixed(1) });
    }
    songs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return songs;
  }

  const activeSongs = getAllActiveSongs();
  return res.json({
    mode: 'library',
    playlist: null,
    library: {
      total: activeSongs.length,
      items: activeSongs,
    },
  });
});

// Set next track for /api/esp
app.post('/api/select-next', express.json(), (req, res) => {
  const { name } = req.body || {};
  if (!name || !currentLocalStation) {
    return res.status(400).json({ ok: false, error: 'missing name' });
  }
  const ok = currentLocalStation.setNextTrack(name);
  res.json({ ok });
});

// Reshuffle playlist
app.post('/api/reshuffle', (req, res) => {
  if (!currentLocalStation || currentLocalStation.files.length === 0) {
    return res.status(400).json({ ok: false, error: 'no station' });
  }
  currentLocalStation._playlist = [...currentLocalStation.files];
  for (let i = currentLocalStation._playlist.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [currentLocalStation._playlist[i], currentLocalStation._playlist[j]] = [currentLocalStation._playlist[j], currentLocalStation._playlist[i]];
  }
  currentLocalStation._playIdx = 0;
  // 不重置 currentSong — ESP 可能正在播，不能丢状态
  res.json({ ok: true, count: currentLocalStation._playlist.length });
});

// ESP32 contract — playlist 快路径优先（零 AI 延迟），否则回退到实时 AI 模式
//
// Fast path:  .radio_playlist/current.json 存在且未过期
//            → 直接 round-robin 返回 stitched_url（intro+歌一体），ESP 单 URL 播放
// Fallback:  playlist 缺失/过期
//            → 走旧的实时 AI 选歌 + intro 缓存逻辑（保留兼容性）
//            → 后台触发一次 generate_playlist.js 补齐下一次播放
app.get('/api/esp', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  // ------------------------------------------------------------------
  // Fast path: playlist 模式 — 每个客户端独立指针
  // ------------------------------------------------------------------
  const pl = loadCurrentPlaylist();
  if (isPlaylistFresh(pl) && pl.songs && pl.songs.length > 0) {
    // Derive device ID from client IP (no ESP code change needed)
    const deviceId = req.ip || req.connection.remoteAddress || 'default';
    // 追加端口号区分同一 IP 的不同连接
    // （SSL/反向代理可能吞 req.ip，fallback 到 socket）
    const fullId = deviceId; // keep simple for now
    let dc = _deviceCursors.get(deviceId);
    console.log(`[api/esp] deviceId=${deviceId}, ip=${req.ip}, got_dc=${!!dc}, cursor=${dc?.cursor}`);
    const sensorInfo = recordEspSensors(req);
    if (sensorInfo) console.log(`[api/esp] sensor: ${JSON.stringify(sensorInfo)}`);
    if (!dc || dc.stamp !== _nextPlaylistStamp) {
      // First-ever request from this device (or new playlist → reset
      // all cursors). Always serve the very first song.
      dc = { cursor: 0, stamp: _nextPlaylistStamp, lastSeen: Date.now(), _lastAdvance: Date.now(), _firstServed: false };
      _deviceCursors.set(deviceId, dc);
      console.log(`[api/esp] NEW cursor for ${deviceId}, stamp=${_nextPlaylistStamp}`);
    }

    // First-ever request: serve as-is without advancing. Subsequent
    // requests within 5s debounce also return the same song; only
    // when the device re-polls after 5s+ do we step forward. This
    // prevents "first song skipped" when ESP32 boot fetches
    // /api/esp twice in quick succession.
    if (!dc._firstServed) {
      dc._firstServed = true;
      dc._lastAdvance = Date.now();
    } else if (Date.now() - dc._lastAdvance > 5000) {
      dc.cursor = (dc.cursor + 1) % pl.songs.length;
      dc._lastAdvance = Date.now();
    }

    const song = pl.songs[dc.cursor];
    dc.lastSeen = Date.now();

    const url = `${base}${song.stitched_url}`;
    console.log(`[api/esp] playlist ${song.name} (${dc.cursor}/${pl.songs.length}, generated ${pl.generated_at})`);

    // 记录到历史（兼容旧字段）
    playedHistory.push(song.name);
    if (playedHistory.length > MAX_HISTORY) playedHistory.shift();

    // Always return live weather, not the stale string from playlist generation
    let w = await getWeather();
    if (!w) {
      // Try one more time inline
      try {
        const resp = await fetch(`https://${WEATHER_HOST}/v7/weather/now?location=${WEATHER_LOCATION}&key=${WEATHER_KEY}`);
        const data = await resp.json();
        if (data && data.now && data.now.temp) {
          w = data;
        }
      } catch {}
    }
    const respWeather = w ? {
      temp: w.now?.temp || w.temp || '--',
      text: w.now?.text || w.text || '',
      humidity: w.now?.humidity || w.humidity || '--',
      tempMax: w.today?.tempMax || w.tempMax || '--',
      tempMin: w.today?.tempMin || w.tempMin || '--',
      textDay: w.today?.textDay || w.textDay || '',
      textNight: w.today?.textNight || w.textNight || '',
    } : {
      temp: pl.weather_temp || '--',
      text: pl.weather || '',
      humidity: pl.weather_humidity || '--',
      tempMax: pl.weather_temp_max || '--',
      tempMin: pl.weather_temp_min || '--',
    };

    return res.json({
      song: song.name,
      name: 'Playlist Mode',
      url,
      volume: currentVolume,
      weather: respWeather,
    });
  }

  // ------------------------------------------------------------------
  // Fallback: playlist 缺失/过期 → 实时 AI 模式 + 后台补一次生成
  // ------------------------------------------------------------------
  if (pl && pl.songs && pl.songs.length > 0) {
    // playlist 过期但文件还在：触发后台补一次
    maybeGenerateInBackground('playlist expired');
  } else {
    // playlist 完全缺失：第一次兜底时也触发
    maybeGenerateInBackground('no playlist on disk');
  }

  if (!currentLocalStation || currentLocalStation.files.length === 0) {
    return res.status(404).json({ error: 'no station or files available' });
  }

  // Fetch weather — wait up to 2s, then return even if not ready
  // (ESP32 has 10s timeout, mmx chat in background runs in parallel)
  const weatherData = await Promise.race([
    fetchWeatherData(),
    new Promise(r => setTimeout(() => r(null), 2000))
  ]);

  const timePeriod = getTimePeriod();
  const weatherStr = getWeatherDesc(weatherData);
  const allSongs = currentLocalStation.fileInfos.map(f => f.name);

  // Build available pool — prefer unplayed songs
  let available = allSongs.filter(s => !playedHistory.includes(s));
  if (available.length === 0) {
    playedHistory.length = 0;
    available = [...allSongs];
  }

  // AI selects the next song based on weather/time/mood
  // Runs in BACKGROUND so /api/esp returns fast (ESP32 has 5s timeout).
  // Result is picked up on the NEXT /api/esp call via `pendingSong` flag.
  if (ttsIntroEnabled && !pendingSong) {
    // Kick off async selection
    const songListStr = available.slice(0, 50).join('、');  // limit to 50 songs
    const ctx = `${timePeriod}，余杭`;
    (async () => {
      try {
        const result = await execAsync(
          `mmx text chat --system ${JSON.stringify('根据天气时间从歌单选最合适的歌，只返回歌名')} --message ${JSON.stringify(`天气：${ctx}\n歌单：${songListStr}`)} --non-interactive --quiet --output text 2>/dev/null`,
          20000
        );
        const aiSong = result.split('\n').map(l => l.trim()).find(l => l.length > 1);
        if (aiSong) {
          const exact = available.find(s => s === aiSong);
          const fuzzy = available.find(s => s.includes(aiSong) || (aiSong.length > 3 && aiSong.includes(s)));
          pendingSong = exact || fuzzy;
          if (pendingSong) console.log(`[ai-esp-bg] AI pre-selected: ${pendingSong}`);
        }
      } catch (e) {
        console.error(`[ai-esp-bg] AI selection failed: ${e.message}`);
      }
    })();
  }

  // Use AI pre-selected song if available, else random unplayed
  let selected;
  if (ttsIntroEnabled && pendingSong && available.includes(pendingSong)) {
    selected = pendingSong;
    pendingSong = null;
    console.log(`[ai-esp] Using AI pre-selected: ${selected}`);
  } else {
    selected = available[Math.floor(Math.random() * available.length)];
    console.log(`[ai-esp] Random unplayed: ${selected}`);
  }

  // Record in history
  playedHistory.push(selected);
  if (playedHistory.length > MAX_HISTORY) playedHistory.shift();

  // Set as next track
  currentLocalStation.setNextTrack(selected);

  // Pre-generate intro buffer in background so track endpoint can serve instantly
  // (ESP32 has 5-second HTTP timeout, so /api/esp must return fast)
  if (ttsIntroEnabled) {
    const songName = selected;
    (async () => {
      const set = introBufferCache._pending || (introBufferCache._pending = new Set());
      set.add(songName);
      try {
        // Fetch weather for the intro generation (this can take 1-2s)
        const wd = await fetchWeatherData();
        console.log(`[ai-esp] Background-generating intro for: ${songName}`);
        const start = Date.now();
        const buf = await generateIntro(songName, wd);
        if (buf) {
          // Evict oldest if over limit
          const keys = Object.keys(introBufferCache).filter(k => k !== '_pending');
          while (keys.length >= MAX_INTRO_CACHE) {
            const oldest = keys.shift();
            delete introBufferCache[oldest];
          }
          introBufferCache[songName] = buf;
          console.log(`[ai-esp] Background intro ready: ${songName} (${buf.length} bytes in ${Date.now() - start}ms, cache: ${keys.length + 1})`);
        }
      } catch (e) {
        console.error(`[ai-esp] Background intro failed: ${e.message}`);
      } finally {
        set.delete(songName);
      }
    })();
  }

  const url = `${base}/audio/local/track/${encodeURIComponent(selected)}`;

  // Build response with weather
  if (weatherData) {
    res.json({
      song: selected,
      url,
      volume: currentVolume,
      weather: weatherData,
    });
  } else {
    res.json({ song: selected, url, volume: currentVolume });
  }
});

// ---------------------------------------------------------------
// /api/esp/:deviceId — device-specific playlist cursor
// ---------------------------------------------------------------
// Each ESP device gets its own playback pointer, so multiple devices
// don't interfere with each other. Cursor persists per device until
// a new playlist is generated (all cursors reset on stamp change).
// ---------------------------------------------------------------
app.get('/api/esp/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  const sensorInfo = recordEspSensors(req);
  if (sensorInfo) console.log(`[esp/${deviceId}] sensor: ${JSON.stringify(sensorInfo)}`);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  const pl = loadCurrentPlaylist();
  if (!isPlaylistFresh(pl) || !pl.songs || pl.songs.length === 0) {
    // No playlist — fallback to shared /api/esp behavior
    return app.handle(req, res);
  }

  // Get or create per-device cursor
  let dc = _deviceCursors.get(deviceId);
  if (!dc || dc.stamp !== _nextPlaylistStamp) {
    // First-ever request from this device (or new playlist → reset
    // all cursors). Always serve the very first song of the new
    // playlist regardless of how long the device has been idle —
    // this prevents "I woke the device up and it skipped to song N"
    // after long sleep / WiFi reconnect cycles.
    dc = { cursor: 0, stamp: _nextPlaylistStamp, lastSeen: Date.now(), _lastAdvance: Date.now(), _firstServed: false };
    _deviceCursors.set(deviceId, dc);
    console.log(`[esp/${deviceId}] new cursor at 0`);
  }

  // Serve song[dc.cursor] as-is on the very first request after the
  // device (re)connected — do NOT advance the cursor here. Subsequent
  // requests within the 5s debounce also return the same song; only
  // when the device re-polls after 5s+ do we step forward. This
  // matches the ESP32 boot pattern of fetching /api/esp twice in
  // quick succession (weather fetch + audio start) without skipping
  // the first track.
  if (!dc._firstServed) {
    dc._firstServed = true;
    dc._lastAdvance = Date.now(); // refresh so the next request within 5s debounces
  } else if (Date.now() - dc._lastAdvance > 5000) {
    dc.cursor = (dc.cursor + 1) % pl.songs.length;
    dc._lastAdvance = Date.now();
  }

  const song = pl.songs[dc.cursor];

  const url = `${base}${song.stitched_url}`;
  console.log(`[esp/${deviceId}] ${song.name} (${dc.cursor}/${pl.songs.length})`);

  // Record to history
  playedHistory.push(song.name);
  if (playedHistory.length > MAX_HISTORY) playedHistory.shift();

  const w = _weatherCache;
  const respWeather = w || { text: pl.weather, time: pl.time_of_day };

  res.json({
    song: song.name,
    name: 'Playlist Mode',
    url,
    volume: currentVolume,
    weather: respWeather,
  });
});

// ---------------------------------------------------------------
// /api/devices — list all known ESP devices with playback status
// ---------------------------------------------------------------
app.get('/api/devices', (req, res) => {
  const pl = loadCurrentPlaylist();
  const devices = [];
  for (const [deviceId, dc] of _deviceCursors) {
    const songIdx = Math.max(0, (dc.cursor || 1) - 1);
    const currentSong = (pl && pl.songs && pl.songs[songIdx]) ? pl.songs[songIdx].name : '—';
    devices.push({
      id: deviceId,
      cursor: dc.cursor || 0,
      current_song: currentSong,
      last_seen: dc.lastSeen ? new Date(dc.lastSeen).toISOString() : null,
      active: dc.lastSeen ? (Date.now() - dc.lastSeen < 300000) : false,
    });
  }
  devices.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  res.json({ devices, total: devices.length, playlist_songs: pl ? pl.songs.length : 0 });
});

// Seek a device to a specific song position
app.post('/api/devices/:deviceId/seek', express.json(), (req, res) => {
  const deviceId = req.params.deviceId;
  const { position } = req.body || {};
  if (typeof position !== 'number' || position < 0) {
    return res.status(400).json({ ok: false, error: 'position must be >= 0' });
  }
  const pl = loadCurrentPlaylist();
  if (!pl || !pl.songs || position >= pl.songs.length) {
    return res.status(400).json({ ok: false, error: `position must be 0-${pl ? pl.songs.length - 1 : 0}` });
  }
  let dc = _deviceCursors.get(deviceId);
  if (!dc || dc.stamp !== _nextPlaylistStamp) {
    dc = { cursor: position, stamp: _nextPlaylistStamp, lastSeen: Date.now(), _lastAdvance: Date.now() };
    _deviceCursors.set(deviceId, dc);
  } else {
    dc.cursor = position;
    dc.lastSeen = Date.now();
    dc._lastAdvance = 0;  // 重置：下次 /api/esp 时会初始化 _lastAdvance = now，不会步进
    dc._started = 0;      // 重置：下次 /api/esp 像新设备一样处理
  }
  console.log(`[devices] ${deviceId} seek to ${position} (${pl.songs[position].name})`);
  res.json({ ok: true, deviceId, position, current_song: pl.songs[position].name });
});

// ---------------------------------------------------------------
// /api/next — returns the next pre-stitched track from the AI playlist
//
// The pre-generated playlist lives at .radio_playlist/current.json
// (symlinked by scripts/generate_playlist.js, refreshed every 2h).
// Each entry has a pre-stitched MP3 (intro + song) at /audio/playlist-stitched/...
// so ESP just plays ONE URL — no AI in the hot path, no client changes.
//
// Hot path latency: ~10-50ms (just JSON + file stat)
// ---------------------------------------------------------------
app.get('/api/next', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  const pl = loadCurrentPlaylist();
  if (!pl || !pl.songs || pl.songs.length === 0) {
    return res.status(503).json({
      error: 'no playlist ready',
      hint: 'run scripts/generate_playlist.js to generate one',
    });
  }
  if (!isPlaylistFresh(pl)) {
    return res.status(503).json({
      error: 'playlist expired',
      valid_until: pl.valid_until,
      hint: 'will regenerate on next /api/esp miss',
    });
  }

  // Round-robin through the playlist
  const song = pl.songs[_nextCursor % pl.songs.length];
  _nextCursor++;
  if (_nextCursor >= pl.songs.length) _nextCursor = 0;

  const url = `${base}${song.stitched_url}`;

  console.log(`[next] Serving ${song.name} (${_nextCursor}/${pl.songs.length} in playlist ${pl.generated_at})`);

  // Use cached weather (sync read, no API call)
  const w = _weatherCache;
  const respWeather = w || { text: pl.weather, time: pl.time_of_day };

  res.json({
    song: song.name,
    name: 'Playlist Mode',
    url,
    volume: currentVolume,
    weather: respWeather,
    playlist: {
      total: pl.songs.length,
      current: _nextCursor,  // 1-indexed next position
      valid_until: pl.valid_until,
    },
  });
});

// Static-serve pre-generated playlist intros and stitched tracks.
// Path: /audio/playlist-intro/<stamp>/<n>.mp3  →  .radio_playlist/<stamp>/intros/<n>.mp3
//        /audio/playlist-stitched/<stamp>/<n>.mp3  →  .radio_playlist/<stamp>/intros/<n>.stitched.mp3
function servePlaylistFile(req, res, type) {
  // Match: /audio/playlist-<type>/<stamp>/<file>
  // Stamp = YYYYMMDDHHMM (12 digits); accept up to 14 for legacy compatibility
  const m = req.url.match(new RegExp(`^\\/audio\\/playlist-${type}\\/([0-9]{12,14})\\/(.+)$`));
  if (!m || req.method !== 'GET') return false;
  const stamp = m[1];
  const file = m[2];
  // Prevent path traversal
  if (file.includes('..') || file.includes('/') || file.includes('\\')) {
    res.writeHead(400); res.end('bad path'); return true;
  }
  const filePath = type === 'stitched'
    ? path.join(PLAYLIST_ROOT, stamp, INTRO_REL_DIR, file.replace('.mp3', '.stitched.mp3'))
    : path.join(PLAYLIST_ROOT, stamp, INTRO_REL_DIR, file);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('not found'); return true;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=7200',  // 2h, matches playlist TTL
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({
    iso: now.toISOString(),
    local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    ts: now.getTime()
  });
});

// Volume — read current volume
app.get('/api/volume', (req, res) => {
  res.json({ volume: currentVolume });
});
app.post('/api/volume', express.json(), (req, res) => {
  const { volume } = req.body || {};
  const v = parseInt(volume);
  if (isNaN(v) || v < 1 || v > 100) {
    return res.status(400).json({ ok: false, error: 'volume must be 1-100' });
  }
  currentVolume = v;
  saveState();
  res.json({ ok: true, volume: currentVolume });
});

// Union of all text strings across local MP3 titles — used to build a compact
// embedded font that only needs to render the glyphs we actually use.
// Result is deterministic: only STATIC data (file names + ID3 titles), no live state.
app.get('/api/fonts', (req, res) => {
  const fields = new Set();
  const collect = (s) => s && typeof s === 'string' && s.split('').forEach(c => fields.add(c));

  // Single-library mode — iterate the one station
  const st = currentLocalStation;
  if (st) {
    collect(st.id);
    collect(st.name);
    for (const fi of st.fileInfos || []) {
      collect(fi.title);
      collect(fi.name);
    }
  }

  // Keep printable BMP characters only. Drop controls, surrogates (emoji flags etc),
  // and any non-BMP codepoints since LVGL font tooling typically only handles BMP.
  const printable = [...fields].filter(c => {
    const cp = c.codePointAt(0);
    if (cp < 0x20) return false;       // control
    if (cp === 0x7f) return false;     // DEL
    if (cp >= 0xD800 && cp <= 0xDFFF) return false;  // UTF-16 surrogate halves (emoji etc.)
    if (cp > 0xFFFF) return false;     // non-BMP
    return true;
  });

  res.json({
    count: printable.length,
    text: printable.join('')
  });
});

// ---------------------------------------------------------------
// Weather — 和风天气, 余杭
// ---------------------------------------------------------------
function fetchWeather(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') {
          zlib.gunzip(buf, (err, decoded) => {
            if (err) reject(err);
            else resolve(JSON.parse(decoded.toString()));
          });
        } else {
          resolve(JSON.parse(buf.toString()));
        }
      });
    }).on('error', reject);
  });
}

// 余杭今日天气
app.get('/api/weather', async (req, res) => {
  try {
    const base = `https://${WEATHER_HOST}`;
    const [now, forecast] = await Promise.all([
      fetchWeather(`${base}/v7/weather/now?location=${WEATHER_LOCATION}&key=${WEATHER_KEY}`),
      fetchWeather(`${base}/v7/weather/7d?location=${WEATHER_LOCATION}&key=${WEATHER_KEY}`),
    ]);

    if (now.code !== '200' || forecast.code !== '200') {
      return res.status(502).json({ error: 'weather API error' });
    }

    const today = forecast.daily[0];
    res.json({
      city: '余杭',
      updateTime: now.updateTime,
      now: {
        temp: now.now.temp,
        feelsLike: now.now.feelsLike,
        text: now.now.text,
        humidity: now.now.humidity,
        windDir: now.now.windDir,
        windScale: now.now.windScale,
      },
      today: {
        date: today.fxDate,
        tempMax: today.tempMax,
        tempMin: today.tempMin,
        textDay: today.textDay,
        textNight: today.textNight,
        windDirDay: today.windDirDay,
        windScaleDay: today.windScaleDay,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// TTS Intro — toggle and status
// ---------------------------------------------------------------
app.get('/api/tts-intro', (req, res) => {
  res.json({ enabled: ttsIntroEnabled });
});

app.post('/api/tts-intro', express.json(), (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'enabled must be boolean' });
  }
  ttsIntroEnabled = enabled;
  saveState();
  console.log(`[tts] ${enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ ok: true, enabled: ttsIntroEnabled });
});

// ---------------------------------------------------------------
// DJ Work Queue — web interface to scheduled playlist generation
// ---------------------------------------------------------------
// State lives in .radio_playlist/queue_state.json (see scripts/dj_queue.js).
// This server reads/writes that file. The actual generation runs in
// scripts/dj_worker.js (separate daemon).
// ---------------------------------------------------------------
const DJ_QUEUE = require('./scripts/dj_queue');

// Canonical route: /dj. /admin/dj kept as 301 alias for back-compat
// (bookmarks, old chat history, etc).
app.get('/dj', (req, res) => {
  res.render('admin_dj');
});
app.get('/admin/dj', (req, res) => res.redirect(301, '/dj'));

app.get('/api/dj/status', (req, res) => {
  const state = DJ_QUEUE.readState();
  const history = state.history || [];
  res.json({
    state: state.state,
    batch: state.batch,
    persona: state.persona || null,  // null when random/TBD
    started_at: state.started_at,
    updated_at: state.updated_at,
    progress: state.progress,
    result: state.result ? {
      generated_at: state.result.generated_at,
      valid_until: state.result.valid_until,
      weather: state.result.weather,
      persona: state.result.persona || null,
      song_count: state.result.songs ? state.result.songs.length : 0,
      error: state.result.error,
    } : null,
    history: history.slice(0, 20).map(h => ({
      ...h,
      // Old history entries won't have a persona (legacy data). Show '?' so
      // the UI knows to render a placeholder.
      persona: h.persona || null,
    })),
  });
});

app.post('/api/dj/trigger', express.json(), (req, res) => {
  const { batch, persona, scene, volume } = req.body || {};
  if (!['morning', 'evening', 'manual'].includes(batch)) {
    return res.status(400).json({ ok: false, error: 'batch must be morning|evening|manual' });
  }
  // scene is optional. When present, worker dispatches to scene_fetch.js
  // (NCM playlist search + adopt + download) instead of the AI path.
  // Validated against config/scenes/<scene>.json so a typo'd name
  // doesn't silently fall through to AI. 故意放在 config/scenes 而不是
  // hardcode 4 个：以后加新场景不用改 server。
  let sceneName = null;
  if (scene) {
    const scenePath = path.join(__dirname, 'config', 'scenes', `${scene}.json`);
    if (!fs.existsSync(scenePath)) {
      return res.status(400).json({
        ok: false,
        error: `scene "${scene}" not found (no config/scenes/${scene}.json)`,
      });
    }
    sceneName = scene;
  }
  // persona is optional. When null/missing, generate_playlist.js picks
  // a persona at random. When set, it must match a known id in
  // config/dj_vibes.json — we validate here so a typo'd name doesn't
  // silently no-op downstream.
  let personaId = null;
  if (persona) {
    const vibesPath = path.join(__dirname, 'config', 'dj_vibes.json');
    try {
      const vibes = JSON.parse(fs.readFileSync(vibesPath, 'utf8'));
      const valid = (vibes[batch]?.personas || []).map(p => p.id);
      if (!valid.includes(persona)) {
        return res.status(400).json({
          ok: false,
          error: `persona "${persona}" not valid for batch "${batch}"`,
          valid,
        });
      }
      personaId = persona;
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'cannot read vibes: ' + e.message });
    }
  }
  const state = DJ_QUEUE.readState();
  if (state.state === 'running') {
    return res.status(409).json({ ok: false, error: 'already running', current_batch: state.batch });
  }
  // Optional: set volume before triggering so the playlist plays at
  // the operator-configured level. Volume is 1..100; missing/invalid
  // values are silently ignored (caller has its own default of 4).
  let volApplied = null;
  if (volume != null) {
    const v = parseInt(volume, 10);
    if (!isNaN(v) && v >= 1 && v <= 100) {
      currentVolume = v;
      saveState();
      volApplied = v;
    }
  }
  DJ_QUEUE.trigger(batch, personaId, sceneName);
  console.log(`[dj] Manual trigger: ${batch}${personaId ? ` persona=${personaId}` : ' (random)'}${sceneName ? ` scene=${sceneName}` : ''}${volApplied != null ? ` volume=${volApplied}` : ''}`);
  res.json({ ok: true, batch, persona: personaId, scene: sceneName, message: `Trigger queued for ${batch}${sceneName ? ` (scene=${sceneName})` : ''}` });
});

app.post('/api/dj/cancel', (req, res) => {
  const state = DJ_QUEUE.readState();
  if (state.state !== 'running' && state.state !== 'cancelling') {
    return res.status(400).json({ ok: false, error: 'no running job' });
  }
  // 1. Touch cancel file — generate_playlist.js checks it between songs (graceful)
  const cancelFile = path.join(__dirname, '.radio_playlist', '.cancel');
  try { fs.writeFileSync(cancelFile, 'web cancel'); } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  // 2. Send SIGTERM directly to child process (state.pid is generate_playlist.js PID)
  //    This breaks out of long-running mmx calls faster than waiting for next-song check.
  if (state.pid) {
    try { process.kill(state.pid, 'SIGTERM'); } catch (e) {
      console.log(`[dj] Cancel SIGTERM to PID ${state.pid} failed: ${e.message}`);
    }
  }
  console.log(`[dj] Cancel requested (current job: ${state.batch})`);
  res.json({ ok: true, message: 'Cancel signal sent' });
});

// LLM batch-intros history — read the last N entries from
// llm_history.jsonl. The admin UI uses this to show "上一次 LLM
// 输入输出" even after queue_state.progress has been overwritten by
// the next scene-fetch cycle.
app.get('/api/dj/llm-history', (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50));
  const historyFile = path.join(__dirname, '.radio_playlist', 'llm_history.jsonl');
  try {
    if (!fs.existsSync(historyFile)) {
      return res.json({ entries: [] });
    }
    const raw = fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean);
    // Take the last N, parse, return newest-first
    const tail = raw.slice(-limit).reverse();
    const entries = tail.map((line, i) => {
      try {
        const e = JSON.parse(line);
        return {
          ts: e.ts,
          scene: e.scene,
          playlist_name: e.playlist_name,
          requested: e.requested,
          succeeded: e.succeeded,
          duration_ms: e.duration_ms,
          system: e.system || null,
          prompt: e.prompt,
          response: e.response,
          http_request: e.http_request || null,
          keywords: e.keywords || null,
          candidates: e.candidates || null,
          chosen_playlist: e.chosen_playlist || null,
          skipped_used: e.skipped_used || null,
          songs: e.songs || null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json({ entries });
  } catch (e) {
    res.json({ entries: [], error: e.message });
  }
});

// LLM intro prompts config — read/write config/intro_prompts.json
// so the operator can edit the system prompt, user template, scene
// hints, and fallback line from the admin UI. The file is read by
// build_playlist_from_result.js on every batch call.
const INTRO_PROMPTS_PATH = path.join(__dirname, 'config', 'intro_prompts.json');
// scene_hints values are {label, keywords[]} objects:
//   label    — Chinese tag fed into the LLM prompt as ${sceneHint}
//   keywords — netease playlist search terms used by
//              scripts/scene_playlist_search.js
const INTRO_PROMPTS_DEFAULTS = {
  system_template: '你是电台DJ。按 JSON 数组格式输出，不要任何思考过程或解释，不要 markdown 代码块。\n每首歌对应一句 15-20 字的中文播报词，自然亲切、语气贴合"${sceneHint}"。\n格式：[{"name":"歌名","intro":"..."}, ...]，顺序与下面列表完全一致。',
  user_template: '场景：${sceneHint}。\n今天天气：${weatherToday}\n明天天气：${weatherTomorrow}\n请结合天气氛围为下面 ${songs.length} 首歌各写一句 15-20 字的中文播报词：\n\n${songList}',
  scene_hints: {
    sport:  { label: '现在运动时间', keywords: ['运动', '健身', '跑步', '节奏感', '燃脂', 'Workout'] },
    morning:{ label: '早安',         keywords: ['早安', '起床', '清晨轻音乐', '晨间音乐', '早间音乐', 'Morning'] },
    night:  { label: '夜深了',       keywords: ['晚安', '助眠音乐', '深度睡眠', '睡眠音乐', '放松', 'Sleep'] },
    game:   { label: '游戏时间',     keywords: ['欢乐派对', '游戏BGM', '派对', '蹦跳', '互动游戏', 'Party'] },
    focus:  { label: '专注时刻',     keywords: ['专注', '学习', '工作BGM', '白噪音', '深度专注', 'Focus'] },
    sleep:  { label: '伴你入眠',     keywords: ['助眠音乐', '深度睡眠', '睡眠音乐', '放松', '晚安', 'Sleep'] },
  },
  fallback_intro: '接下来请欣赏《${name}》',
};

// Accept either new {label, keywords[]} or legacy bare-string
// scene_hint values. Return a normalized {label, keywords[]} object.
function normalizeSceneHint(v, fallbackLabel, fallbackKeywords) {
  if (v == null) return { label: fallbackLabel || '', keywords: (fallbackKeywords || []).slice(), volume: 4 };
  if (typeof v === 'string') return { label: v, keywords: (fallbackKeywords || []).slice(), volume: 4 };
  if (typeof v === 'object') {
    let volume = 4;
    if (typeof v.volume === 'number' && v.volume >= 1 && v.volume <= 100) {
      volume = Math.floor(v.volume);
    }
    return {
      label: typeof v.label === 'string' ? v.label : (fallbackLabel || ''),
      keywords: Array.isArray(v.keywords) ? v.keywords.slice() : (fallbackKeywords || []).slice(),
      volume,
    };
  }
  return { label: fallbackLabel || '', keywords: (fallbackKeywords || []).slice(), volume: 4 };
}

// Merge disk config with defaults so the admin UI always has a
// complete scene_hints map. Defaults fill in any scene that the
// saved config doesn't mention; saved label/keywords win when
// present.
function mergeIntroPromptConfig(saved) {
  const out = {
    system_template: (saved && typeof saved.system_template === 'string')
      ? saved.system_template
      : INTRO_PROMPTS_DEFAULTS.system_template,
    user_template: (saved && typeof saved.user_template === 'string')
      ? saved.user_template
      : INTRO_PROMPTS_DEFAULTS.user_template,
    fallback_intro: (saved && typeof saved.fallback_intro === 'string')
      ? saved.fallback_intro
      : INTRO_PROMPTS_DEFAULTS.fallback_intro,
    scene_hints: {},
  };
  const allKeys = new Set([
    ...Object.keys(INTRO_PROMPTS_DEFAULTS.scene_hints),
    ...Object.keys((saved && saved.scene_hints) || {}),
  ]);
  for (const k of allKeys) {
    const dflt = INTRO_PROMPTS_DEFAULTS.scene_hints[k];
    const savedHint = saved && saved.scene_hints ? saved.scene_hints[k] : undefined;
    out.scene_hints[k] = normalizeSceneHint(
      savedHint,
      dflt && dflt.label,
      dflt && dflt.keywords
    );
  }
  return out;
}

app.get('/api/dj/intro-prompts', (req, res) => {
  try {
    let saved = null;
    if (fs.existsSync(INTRO_PROMPTS_PATH)) {
      try { saved = JSON.parse(fs.readFileSync(INTRO_PROMPTS_PATH, 'utf8')); }
      catch (_) { /* malformed — treat as no saved config */ }
    }
    const merged = mergeIntroPromptConfig(saved);
    const defaults = {
      ...INTRO_PROMPTS_DEFAULTS,
      scene_hints: JSON.parse(JSON.stringify(INTRO_PROMPTS_DEFAULTS.scene_hints)),
    };
    res.json({
      config: merged,
      defaults,
      from_file: !!saved,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dj/intro-prompts', express.json({ limit: '64kb' }), (req, res) => {
  try {
    const incoming = req.body || {};
    // Load existing config so we can merge scene_hints with whatever
    // the operator didn't touch this round — prevents an empty form
    // wiping a previously-saved scene.
    let saved = null;
    if (fs.existsSync(INTRO_PROMPTS_PATH)) {
      try { saved = JSON.parse(fs.readFileSync(INTRO_PROMPTS_PATH, 'utf8')); }
      catch (_) { /* ignore */ }
    }
    const merged = mergeIntroPromptConfig(saved);

    if (typeof incoming.system_template === 'string') merged.system_template = incoming.system_template;
    if (typeof incoming.user_template === 'string')   merged.user_template   = incoming.user_template;
    if (typeof incoming.fallback_intro === 'string')  merged.fallback_intro  = incoming.fallback_intro;

    // Accept scene_hints in either new {label, keywords[]} format
    // or legacy bare-string format. Normalize and merge per-key:
    // an incoming entry overrides the on-disk value, but keys that
    // weren't included in the form are preserved from disk.
    if (incoming.scene_hints && typeof incoming.scene_hints === 'object' && !Array.isArray(incoming.scene_hints)) {
      for (const [k, v] of Object.entries(incoming.scene_hints)) {
        const dflt = INTRO_PROMPTS_DEFAULTS.scene_hints[k];
        merged.scene_hints[k] = normalizeSceneHint(
          v,
          dflt && dflt.label,
          dflt && dflt.keywords
        );
      }
    }

    fs.mkdirSync(path.dirname(INTRO_PROMPTS_PATH), { recursive: true });
    const tmp = INTRO_PROMPTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, INTRO_PROMPTS_PATH);
    res.json({ ok: true, config: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Schedule (cron) config — operator-editable list of timed triggers.
// Each entry is converted to one crontab line that POSTs to
// /api/dj/trigger. Hour is Beijing time; converted to UTC for cron.
// Cron writer is non-destructive: it preserves any existing crontab
// lines that don't carry the SCHEDULE_TAG marker.
const SCHEDULE_PATH = path.join(__dirname, 'config', 'schedule.json');
const SCHEDULE_TAG = '# radio_streams: schedule (auto)';

const SCHEDULE_DEFAULTS = {
  items: [
    { id: 'morning', label: '🌅 早安歌单', hour: 7,  minute: 0, batch: 'morning', scene: 'morning', enabled: true },
    { id: 'evening', label: '🌙 晚安歌单', hour: 21, minute: 0, batch: 'evening', scene: 'night',   enabled: true },
  ],
};

function readSchedule() {
  try {
    if (!fs.existsSync(SCHEDULE_PATH)) return JSON.parse(JSON.stringify(SCHEDULE_DEFAULTS));
    const raw = fs.readFileSync(SCHEDULE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return JSON.parse(JSON.stringify(SCHEDULE_DEFAULTS));
    return parsed;
  } catch (e) {
    return JSON.parse(JSON.stringify(SCHEDULE_DEFAULTS));
  }
}

function writeSchedule(cfg) {
  fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Beijing → UTC: server is UTC (system clock). For cron we want
// "fire at Beijing hour H, minute M" which means UTC (H-8) % 24.
// We tag TZ=Asia/Shanghai into the cron line itself so the operator
// sees local time when reading crontab -l.
function beijingToUtc(hour, minute) {
  const utcHour = (hour - 8 + 24) % 24;
  return { hour: utcHour, minute };
}

// Render one crontab line for a schedule item. Cron fires with
// TZ=Asia/Shanghai so we can write the local time directly; this
// sidesteps the Beijing→UTC drift issue if the host ever moves
// off UTC. Falls back to UTC-converted form if for some reason
// we want pure UTC.
function renderCronLine(item) {
  const { hour: utcHour, minute } = beijingToUtc(item.hour, item.minute);
  const cronTime = `${minute} ${utcHour} * * *`;
  const payload = JSON.stringify({ batch: item.batch, scene: item.scene, volume: item.volume || 4 });
  const cronLog = path.join(__dirname, '.radio_playlist', 'cron.log');
  // TZ tag ensures the cron daemon interprets the hour as Beijing,
  // not the host's UTC. cron + process.env.TZ works on Ubuntu cron.
  return `${cronTime} TZ=Asia/Shanghai /usr/bin/curl -fsS -X POST http://127.0.0.1:3000/api/dj/trigger -H 'Content-Type: application/json' -d '${payload}' >> ${cronLog} 2>&1  ${SCHEDULE_TAG} (${item.id})`;
}

// Rewrite the user's crontab, replacing only lines with SCHEDULE_TAG.
// Preserves every other line (worker_healthcheck, @reboot, etc.).
function rewriteCrontab(items) {
  // Read existing crontab
  let existing = '';
  try { existing = execSyncSafe('crontab -l 2>/dev/null'); } catch (_) {}

  // Strip our tag lines AND old 192fm curl-trigger lines (no tag, just
  // /api/dj/trigger curl pattern) so we never double-schedule.
  const isOurs = (l) =>
    l.includes(SCHEDULE_TAG) ||
    /\/usr\/bin\/curl.*\/api\/dj\/trigger/.test(l);
  const lines = existing.split('\n').filter(l => !isOurs(l) && l !== '');
  // Add new lines for enabled items
  const newLines = items
    .filter(it => it.enabled !== false)
    .map(renderCronLine);

  const combined = [...lines, ...newLines, ''].join('\n');
  // Write back via stdin pipe — cron reads from stdin when given `-`
  try {
    execSyncSafe(`bash -c 'printf %s "${combined.replace(/"/g, '\\"')}" | crontab -'`);
  } catch (e) {
    // Fallback: write to temp file, then crontab that file
    const tmpFile = '/tmp/.crontab-192fm';
    fs.writeFileSync(tmpFile, combined);
    execSyncSafe(`crontab ${tmpFile}`);
    fs.unlinkSync(tmpFile);
  }
  return newLines;
}

app.get('/api/schedule', (req, res) => {
  try {
    const cfg = readSchedule();
    // Also report current crontab state — operator can see what's
    // actually installed vs. what's in the config file.
    let actual = [];
    try {
      const cur = execSyncSafe('crontab -l 2>/dev/null');
      actual = cur.split('\n').filter(l => l.includes(SCHEDULE_TAG));
    } catch (_) {}

    // Next-run calculation per enabled item
    const now = new Date();
    const itemsWithNext = cfg.items.map(item => {
      if (item.enabled === false) {
        return { ...item, next_run: null };
      }
      const next = new Date(now);
      next.setHours(item.hour, item.minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return {
        ...item,
        next_run: next.toISOString(),
        next_run_beijing: next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      };
    });

    res.json({
      config: cfg,
      actual_crontab_lines: actual,
      items: itemsWithNext,
      server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      server_local_now: now.toISOString(),
      server_beijing_now: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/schedule', express.json({ limit: '16kb' }), (req, res) => {
  try {
    const incoming = req.body || {};
    if (!Array.isArray(incoming.items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }
    // Validate every item
    const validated = [];
    for (const it of incoming.items) {
      const hour = parseInt(it.hour, 10);
      const minute = parseInt(it.minute, 10);
      if (isNaN(hour) || hour < 0 || hour > 23) return res.status(400).json({ error: `bad hour: ${it.hour}` });
      if (isNaN(minute) || minute < 0 || minute > 59) return res.status(400).json({ error: `bad minute: ${it.minute}` });
      if (!['morning', 'evening', 'manual'].includes(it.batch)) {
        return res.status(400).json({ error: `bad batch: ${it.batch}` });
      }
      const scene = it.scene || null;
      // Optional: validate scene exists
      if (scene && !fs.existsSync(path.join(__dirname, 'config', 'scenes', `${scene}.json`))) {
        return res.status(400).json({ error: `unknown scene: ${scene}` });
      }
      // Optional: validate volume (1..100, default 4)
      let volume = parseInt(it.volume, 10);
      if (isNaN(volume) || volume < 1 || volume > 100) volume = 4;
      validated.push({
        id: typeof it.id === 'string' && it.id ? it.id : `item-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        label: typeof it.label === 'string' ? it.label : `${it.batch} ${it.scene || ''}`,
        hour, minute,
        batch: it.batch,
        scene: scene,
        enabled: it.enabled !== false,
        volume,
      });
    }
    const cfg = { items: validated };
    writeSchedule(cfg);
    const newLines = rewriteCrontab(validated);
    res.json({ ok: true, items: validated, installed_lines: newLines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Convenience: re-install crontab from current config without
// changing config (e.g. after manual crontab edits get clobbered).
app.post('/api/schedule/install', (req, res) => {
  try {
    const cfg = readSchedule();
    const newLines = rewriteCrontab(cfg.items);
    res.json({ ok: true, installed_lines: newLines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------
// DJ Vibe Configuration — GET/POST config/dj_vibes.json
// ---------------------------------------------------------------
const VIBES_CONFIG_PATH = path.join(__dirname, 'config', 'dj_vibes.json');

app.get('/api/dj/vibes', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(VIBES_CONFIG_PATH, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/dj/personas — flat list of all (batch, persona) combos for the
// 92DJ panel. The UI uses this to render the persona card grid and
// validate clicks before triggering. We only return public-facing fields
// (id, name, batch, label); the prompt bodies stay private to /api/dj/vibes.
app.get('/api/dj/personas', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(VIBES_CONFIG_PATH, 'utf8'));
    const out = [];
    for (const [batch, vibe] of Object.entries(data)) {
      for (const p of (vibe.personas || [])) {
        out.push({
          id: p.id,
          name: p.name,
          batch,
          label: vibe.label || batch,
        });
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dj/vibes', express.json(), (req, res) => {
  const body = req.body;
  if (!body || !body.morning || !body.evening || !body.manual) {
    return res.status(400).json({ ok: false, error: 'must include morning/evening/manual' });
  }
  for (const key of ['morning', 'evening', 'manual']) {
    if (!body[key].system || typeof body[key].system !== 'string') {
      return res.status(400).json({ ok: false, error: `${key}.system required (string)` });
    }
  }
  try {
    const tmp = VIBES_CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
    fs.renameSync(tmp, VIBES_CONFIG_PATH);
    console.log(`[vibes] Config saved`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------
// Async so we can await each station's loadFiles() — critical when /mnt/music
// is a slow 9p share. The walkMp3 inside loadFiles yields to the event loop,
// keeping other endpoints responsive even mid-scan.
// ---------------------------------------------------------------
// /api/library — 网易云收藏 (the only thing shown on /library now).
//
// Returns every downloaded song in /home/zulin/Music/网易云收藏 with the NCM
// playlist it was sourced from (so the UI can group by playlist_name
// and show "this song came from 听了心情会好的歌" etc).
//
//   { songs: [{
//       name, title, artist, sizeMB, mtime,
//       playlist_id, playlist_name, downloaded_at,
//       play_url
//     }],
//     total: N,
//     index_age_seconds: 0  // how stale the playlist_index is, 0 = just-read
//   }
//
// Source of truth: .radio_playlist/library_index.json. Each entry is
// {title, artist, playlist_id, playlist_name, downloaded_at}; we join
// it with the actual .mp3 files on disk by (title, artist) and fall
// back to file mtime if no index entry matches.
//
// The 9p stat-on-12k-files problem from the previous design doesn't
// apply here: 网易云收藏 holds 993 files (not 19k) and stat is fast.
// ---------------------------------------------------------------
const LIBRARY_INDEX_FILE = path.join(__dirname, '.radio_playlist', 'library_index.json');
const NETEASE_DIR = '/home/zulin/Music/网易云收藏';

function _readIndexSync() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_INDEX_FILE, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

app.get('/api/library', async (req, res) => {
  try {
    // 1. Load index → keyed by (title::artist) for O(1) join.
    const index = _readIndexSync();
    const byKey = new Map();
    for (const e of (index.entries || [])) {
      const k = `${e.title || ''}::${e.artist || ''}`;
      // If the same song appears multiple times (re-downloaded under
      // different playlist contexts), keep the entry whose playlist
      // attribution is non-null; ties broken by recency. This way
      // cache-hit re-records (which we now do, see netease_dl.js)
      // eventually settle on the most recent attribution.
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, e); continue; }
      const prevHas = !!(prev.playlist_id || prev.playlist_name);
      const curHas = !!(e.playlist_id || e.playlist_name);
      if (curHas && (!prevHas || e.downloaded_at > prev.downloaded_at)) {
        byKey.set(k, e);
      } else if (!prevHas && e.downloaded_at > prev.downloaded_at) {
        byKey.set(k, e);
      }
    }

    // 2. Walk 网易云收藏 dir.
    let entries = [];
    try {
      entries = fs.readdirSync(NETEASE_DIR, { withFileTypes: true });
    } catch (e) {
      return res.json({ songs: [], total: 0, index_age_seconds: 0 });
    }

    const songs = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.mp3')) continue;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(NETEASE_DIR, ent.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }

      const stem = ent.name.replace(/\.mp3$/i, '');
      const lastDash = stem.lastIndexOf(' - ');
      const title = lastDash > 0 ? stem.slice(0, lastDash) : stem;
      const artist = lastDash > 0 ? stem.slice(lastDash + 3) : '';

      const k = `${title}::${artist}`;
      const ix = byKey.get(k);

      songs.push({
        name: ent.name,
        title,
        artist,
        sizeMB: +(st.size / 1024 / 1024).toFixed(2),
        mtime: st.mtime.toISOString(),
        // From index when available; otherwise tag as "未分组" so the
        // UI can show a clear bucket for unattributed songs (rather
        // than dropping them or hiding them under a fake playlist).
        playlist_id: ix?.playlist_id ?? null,
        playlist_name: ix?.playlist_name ?? null,
        downloaded_at: ix?.downloaded_at ?? st.mtime.toISOString(),
        play_url: `/audio/local/track/${encodeURIComponent(stem)}`,
      });
    }

    // Newest first — matches the "what was downloaded most recently"
    // mental model that drives the 92DJ workflow.
    songs.sort((a, b) => b.downloaded_at.localeCompare(a.downloaded_at));

    res.json({
      songs,
      total: songs.length,
      index_size: (index.entries || []).length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Keep /api/library/:id around for backward compat (was used by the
// previous v2 design that listed every station). It now just redirects
// callers to /api/library.
app.get('/api/library/:id', (req, res) => {
  return res.redirect(301, '/api/library');
});

// Global lock so a startup scan and a rescan can't both hammer 9p at once.
// 9p (mounted with dirsync) can hang under concurrent readdir pressure, so
// we serialize all walkMp3InWorker activity. Whichever caller loses the race
// just bails and tells the client to retry.
let _scanning = false;
let _scanQueue = Promise.resolve();

// Run an async fn under the global 9p scan lock. All callers (startup
// background load, rescan) go through this — concurrency = 1.
function withScanLock(fn) {
  const next = _scanQueue.then(async () => {
    _scanning = true;
    try { return await fn(); } finally { _scanning = false; }
  });
  // Swallow errors in the chain so one failure doesn't poison the next.
  _scanQueue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// NeteaseCloudMusicApi proxy endpoints (branch feat/netease-only)
// ---------------------------------------------------------------------------
// These let the 92DJ panel and any future web UI search + preview 网易云
// tracks without us bundling the NCM client in the browser. They proxy
// through to the NCM sidecar running on NETEASE_API (default :3001) and
// rewrite the response into the shape our UI already uses.
//
// The endpoints are intentionally anonymous (no login cookie) — same as
// our generate_playlist.js flow. VIP-only tracks will return with a null
// `url` and the UI is expected to show a disabled "VIP" badge.
const NETEASE_API_BASE = process.env.NETEASE_API || 'http://127.0.0.1:3001';
const NETEASE_TIMEOUT_MS = 8000;

async function neteaseProxy(path, res) {
  const url = `${NETEASE_API_BASE}${path}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(NETEASE_TIMEOUT_MS) });
    if (!r.ok) return res.status(502).json({ error: `netease upstream HTTP ${r.status}` });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    log.error && log.error('[netease]', e.message);
    res.status(504).json({ error: `netease upstream timeout: ${e.message.slice(0, 100)}` });
  }
}

// Search netease — UI can call this to suggest songs to add to a playlist
//   GET /api/netease/search?q=小星星&limit=10
app.get('/api/netease/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
  neteaseProxy(`/search?keywords=${encodeURIComponent(q)}&limit=${limit}`, res);
});

// Resolve a single song by id (used by play endpoint below to fetch URL)
//   GET /api/netease/song/:id
app.get('/api/netease/song/:id', (req, res) => {
  neteaseProxy(`/song/detail?ids=${encodeURIComponent(req.params.id)}`, res);
});

// Get playable URL for a song id — returns either the real CDN URL or
// { url: null } for VIP/geo-blocked. The UI should handle the null case.
//   GET /api/netease/play/:id
app.get('/api/netease/play/:id', (req, res) => {
  neteaseProxy(`/song/url?id=${encodeURIComponent(req.params.id)}&br=320000`, res);
});

// Get playlist tracks (mostly used to test the integration from the panel)
//   GET /api/netease/playlist/:id
app.get('/api/netease/playlist/:id', (req, res) => {
  neteaseProxy(`/playlist/detail?id=${encodeURIComponent(req.params.id)}`, res);
});

// Proxy playlist cover/metadata — useful for the UI to show album art
//   GET /api/netease/album/:id
app.get('/api/netease/album/:id', (req, res) => {
  neteaseProxy(`/album?id=${encodeURIComponent(req.params.id)}`, res);
});

// ---------------------------------------------------------------
// HTTP server intercept — raw file serving
// ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/audio/local/playlist' && req.method === 'GET') return handleLocalRadioPlay(req, res);

  // Playlist static files (pre-generated intros and stitched tracks)
  if (servePlaylistFile(req, res, 'stitched')) return;
  if (servePlaylistFile(req, res, 'intro')) return;

  // Track endpoint: stream the raw file (no ID3 stripping, no transcoding, no ICY).
  // Uses HTTP/1.1 with keep-alive so browsers can seek/Range-request properly.
  // Unicode-normalize for filename comparison (macOS uses NFD, Linux uses NFC).
// ESP might receive a URL with macOS-encoded name while 105 stores NFC names.
function unicodeNormalize(s) {
  return s.normalize ? s.normalize('NFC') : s;
}

// Pre-compute a normalized lookup table for all songs on disk.
// Recomputed lazily via TTL to avoid drift after MP3 additions.
const _lookupCache = { at: 0, map: null };
const LOOKUP_TTL_MS = 30 * 1000;
function buildSongLookup() {
  // Returns Map<normalizedName, absolutePath>
  // Single-library mode — walk STATIONS_DIR directly (no nested station dirs).
  const map = new Map();
  const STATIONS_ROOT = process.env.STATIONS_ROOT || STATIONS_DIR;
  if (!fs.existsSync(STATIONS_ROOT)) return map;
  for (const f of fs.readdirSync(STATIONS_ROOT)) {
    if (!f.toLowerCase().endsWith('.mp3')) continue;
    const base = f.slice(0, -4);  // strip .mp3
    const norm = unicodeNormalize(base);
    if (!map.has(norm)) map.set(norm, path.join(STATIONS_ROOT, f));  // first match wins
  }
  return map;
}
function getSongLookup() {
  if (!_lookupCache.map || Date.now() - _lookupCache.at > LOOKUP_TTL_MS) {
    _lookupCache.map = buildSongLookup();
    _lookupCache.at = Date.now();
  }
  return _lookupCache.map;
}

const trackMatch = req.url.match(/^\/audio\/local\/track\/(.+)$/);
  if (trackMatch && req.method === 'GET') {
    let name;
    try {
      name = decodeURIComponent(trackMatch[1]);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: malformed URI');
      return;
    }
    // Search across ALL stations — the song may exist in another station
    // than currentLocalStation (ESP keeps stale URL after user switches stations).
    // Also handles NFD/NFC filename mismatch (macOS uses NFD, Linux uses NFC).
    const lookup = getSongLookup();
    const normName = unicodeNormalize(name);
    let fp = lookup.get(normName);
    if (!fp && currentLocalStation) {
      // Fallback: try current station's dir directly
      const candidate = path.join(currentLocalStation.dir, name + '.mp3');
      if (fs.existsSync(candidate)) fp = candidate;
    }
    if (!fp) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Track not found'); return;
    }
    const stat = fs.statSync(fp);
    const fileSize = stat.size;
    const range = req.headers['range'];

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');

    // When TTS intro is enabled, skip Range support — we serve intro+song
    // as one blob so the browser gets the full intro before the song.
    // Also skip when no station is set.
    if (!range || ttsIntroEnabled) {
      // Full-file path: strip ID3v2 header, ID3v1 trailer, and encoder padding
      // (0xAA / 0x55 / 0x00 runs after the last valid MP3 frame). These are the
      // most common source of "clicking / pop / hiss at the end of a track"
      // symptoms on I2S DACs, since the decoder happily treats non-frame bytes
      // as audio until it re-syncs.
      let clean;
      try {
        clean = currentLocalStation._cleanAudio(fs.readFileSync(fp));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Read error'); return;
      }

      // TTS intro prepend — use pre-generated buffer if available
      if (ttsIntroEnabled) {
        let introBuf = null;

        // 1) Fast path: pre-generated buffer from /api/esp
        if (introBufferCache[name]) {
          introBuf = introBufferCache[name];
          delete introBufferCache[name];
          console.log(`[tts] Using pre-generated buffer for: ${name}`);
        } else if (introBufferCache._pending && introBufferCache._pending.has(name)) {
          // 2) Buffer is still generating — wait up to 25 seconds for it
          // (intro gen = mmx text + mmx speech + lame transcode, can take 5-15s under load)
          console.log(`[tts] Waiting for pending buffer: ${name}`);
          const waitStart = Date.now();
          while (introBufferCache._pending.has(name) && Date.now() - waitStart < 25000) {
            await new Promise(r => setTimeout(r, 100));
          }
          if (introBufferCache[name]) {
            introBuf = introBufferCache[name];
            delete introBufferCache[name];
            console.log(`[tts] Got buffer after ${Date.now() - waitStart}ms wait`);
          }
        }

        // 3) Slow path: generate on-the-fly (web preview only)
        // ESP32 has 15s timeout — generating here would block >5s, so skip for ESP
        if (!introBuf) {
          // Detect ESP request: HTTP/1.0 (no keepalive) from audio_http_stream
          const isEsp = req.httpVersion === '1.0' || (req.headers['user-agent'] || '').includes('esp');
          if (isEsp) {
            console.log(`[tts] ESP request, no buffer ready — skipping intro, sending song only`);
          } else {
            console.log(`[tts] Web request, generating on-the-fly for: ${name}`);
            const weatherData = await fetchWeatherData();
            introBuf = await generateIntro(name, weatherData);
          }
        }

        if (introBuf) {
          clean = Buffer.concat([introBuf, clean]);
        }
      }

      res.statusCode = 200;
      res.setHeader('Content-Length', clean.length);
      res.end(clean);
      return;
    }

    // Range requests for raw file (only when TTS is off)
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end   = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (start >= 0 && end < fileSize && start <= end) {
        res.statusCode = 206;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(fp, { start, end }).pipe(res);
        return;
      }
    }
  }

  app(req, res);
});

function handleLocalRadioPlay(req, res) {
  if (!currentLocalStation || currentLocalStation.files.length === 0) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('No station selected'); return;
  }
  const socket = res.socket;
  if (!socket || socket.destroyed || !socket.writable) return;
  res._header = ''; res._headerSent = true; res.headersSent = true;
  const currentSong = currentLocalStation.currentSong || 'loading...';
  let h = `HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\nX-Current-Song: ${currentSong}\r\nAccess-Control-Allow-Origin: *\r\n\r\n`;
  socket.write(h);
  currentLocalStation.serve(socket, {icy: false});
}

server.listen(PORT, () => {
  console.log(`\n  🎵 Local MP3 Jukebox running at http://localhost:${PORT}`);
  console.log(`  📂 Stations: ${STATIONS_DIR} (loading in background)`);
  // Start the (potentially long) station scan after the port is bound.
  loadMainStation();
});
