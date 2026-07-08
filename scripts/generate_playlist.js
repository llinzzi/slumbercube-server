#!/usr/bin/env node
/**
 * generate_playlist.js — 定时批量预生成播放列表
 *
 * 由 cron 每天 07:00 和 21:00 触发。生成未来 14 小时的播放列表：
 *   1. AI (mmx text chat) 从全曲库选 10 首歌（基于天气+时间+近期历史）
 *   2. AI 为每首歌写 15-25 字的中文播报文案
 *   3. TTS 生成 intro MP3 (mmx speech, Chinese (Mandarin)_Male_Announcer)
 *   4. 转码到 44.1kHz stereo MP3 (node-lame)
 *   5. 拼接 intro + song = stitched.mp3（ESP 单 URL 直播）
 *   6. 落盘到 .radio_playlist/YYYYMMDD-HHMM/
 *   7. 原子切换 .radio_playlist/current.json 符号链接
 *
 * ESP32 在 playlist 有效期内命中 .radio_playlist/current.json 时直接拿
 * stitched_url，零 AI 延迟（热路径 <5ms）。playlist 缺失时 server.js
 * 会回退到实时 AI 模式并后台触发本脚本。
 *
 * 用法:  node scripts/generate_playlist.js
 *       或 npm run generate-playlist
 */

const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execAsync = util.promisify(exec);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLAYLIST_ROOT = path.join(PROJECT_ROOT, '.radio_playlist');
const PLAYLIST_JSON = path.join(PLAYLIST_ROOT, 'current.json');
const PLAYLIST_LINK = path.join(PLAYLIST_ROOT, 'current');
const INTRO_REL_DIR = 'intros';
const STATIONS_DIR = process.env.STATIONS_DIR || path.join(os.homedir(), 'Music', '电台');
const STATE_FILE = path.join(PROJECT_ROOT, '.radio_state.json');
const RECOMMENDED_FILE = path.join(PLAYLIST_ROOT, 'recommended_songs.json');
const SERVER_URL = process.env.RADIO_SERVER_URL || 'http://127.0.0.1:3000';

// Location and batch-specific vibes — loaded from config/dj_vibes.json
const LOCATION = '杭州余杭';
const BATCH_VIBES = (() => {
  const configPath = path.join(PROJECT_ROOT, 'config', 'dj_vibes.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[playlist] WARNING: cannot load ${configPath}, using defaults:`, e.message);
    return {
      morning: {
        label: '清晨叫醒',
        system: `你是杭州余杭一家咖啡馆的晨间 DJ。\n现在时间：{timeOfDay}{hour}点。{location}。{weather}。\n选 {count} 首歌放给一早来的客人听。\n\n风格：轻快、清新。文案 12-20 字。`,
      },
      evening: {
        label: '晚安收束',
        system: `你是杭州余杭一家咖啡馆的晚间 DJ。\n现在时间：{timeOfDay}{hour}点。{location}。{weather}。\n选 {count} 首歌作为今天的收尾。\n\n风格：安静、温暖。文案 12-20 字。`,
      },
      manual: {
        label: '手动触发',
        system: `你是杭州余杭一家咖啡馆的 DJ。\n现在时间：{timeOfDay}{hour}点。{location}。{weather}。\n选 {count} 首最合适的歌。文案 12-20 字。`,
      },
    };
  }
})();

// Worker integration — when run via dj_worker, these env vars are set:
//   DJ_BATCH=morning|evening|manual
//   DJ_PROGRESS_FILE=/path/to/queue_state.json
//   DJ_CANCEL_FILE=/path/to/.cancel  (exists => abort)
// In standalone mode (npm run generate-playlist), all are unset → silent.
const DJ_BATCH = process.env.DJ_BATCH || null;
const DJ_PROGRESS_FILE = process.env.DJ_PROGRESS_FILE || null;
const DJ_CANCEL_FILE = process.env.DJ_CANCEL_FILE || null;

const SONGS_PER_PLAYLIST = 20;
const PLAYLIST_TTL_HOURS = 14;  // 覆盖 07:00→21:00 / 21:00→次日 11:00 两段
const TTS_VOICE = 'Chinese (Mandarin)_Male_Announcer';

// ---------------------------------------------------------------------------
// Tool paths — 自动探测（兼容 macOS 开发机 + 105 Linux 服务器）
// ---------------------------------------------------------------------------
function detectMmxBin() {
  if (process.env.MMX_BIN && fs.existsSync(process.env.MMX_BIN)) return process.env.MMX_BIN;
  const candidates = [
    '/opt/homebrew/bin/mmx',
    '/usr/local/bin/mmx',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    const found = require('child_process').execSync('which mmx', { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {}
  return 'mmx';  // 兜底走 PATH
}

function detectLameBin() {
  // 优先用项目内 node-lame 的 vendored lame（与 server.js 现有做法一致）
  const vendored = path.join(PROJECT_ROOT, 'node_modules', 'node-lame', 'vendor', 'lame', 'linux-x64', 'lame');
  if (fs.existsSync(vendored)) return vendored;
  try {
    const found = require('child_process').execSync('which lame', { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {}
  return 'lame';
}

const MMX_PATH = detectMmxBin();
const LAME_BIN = detectLameBin();
const LAME_LIB_DIR = path.join(PROJECT_ROOT, 'node_modules', 'node-lame', 'vendor', 'lame', 'linux-x64', 'lib');
const MONO2STEREO_PATH = path.join(PROJECT_ROOT, 'scripts', 'mono2stereo.js');

function log(...args) { console.log(`[playlist ${new Date().toISOString()}]`, ...args); }

// ---------------------------------------------------------------------------
// Worker integration helpers
// ---------------------------------------------------------------------------
function reportProgress(partial) {
  // Merge partial state into DJ_PROGRESS_FILE if running under worker.
  // Silent no-op when standalone (npm run generate-playlist).
  if (!DJ_PROGRESS_FILE) return;
  try {
    let current = {};
    if (fs.existsSync(DJ_PROGRESS_FILE)) {
      current = JSON.parse(fs.readFileSync(DJ_PROGRESS_FILE, 'utf8'));
    }
    // Deep merge: keep fields from current.progress that aren't in partial.progress
    if (partial.progress && current.progress) {
      partial.progress = Object.assign({}, current.progress, partial.progress);
    }
    const next = Object.assign({}, current, partial, {
      updated_at: new Date().toISOString(),
    });
    const tmp = DJ_PROGRESS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, DJ_PROGRESS_FILE);
  } catch (e) {
    // Never let reporting failure kill the generation
  }
}

function checkCancelled() {
  // Returns true if user requested cancellation. Cheap file existence check.
  if (!DJ_CANCEL_FILE) return false;
  try {
    return fs.existsSync(DJ_CANCEL_FILE);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// MiniMax Anthropic-compatible API — direct HTTP, no mmx CLI
const ANTHROPIC_BASE = 'https://api.minimaxi.com/anthropic/v1/messages';
const ANTHROPIC_KEY = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mmx', 'config.json'), 'utf8'));
    return cfg.api_key || null;
  } catch { return null; }
})();
const ANTHROPIC_MODEL = 'MiniMax-M3';  // 1M context, handles 262 tracks easily

async function anthropicChat(prompt, timeoutMs = 180000) {
  if (!ANTHROPIC_KEY) {
    log('anthropic: no API key found in ~/.mmx/config.json');
    return null;
  }
  try {
    const body = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const result = await new Promise((resolve, reject) => {
      const https = require('https');
      const req = https.request(ANTHROPIC_BASE, {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString();
            const data = JSON.parse(raw);
            if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
            else resolve(data);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    // Parse Anthropic response format
    const text = (result.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    log(`anthropic: OK (${text.length} chars, ${result.usage?.output_tokens || '?'} tokens)`);
    return text || null;
  } catch (e) {
    log('anthropic failed:', e.message.slice(0, 500));
    return null;
  }
}

// MiniMax TTS API — direct HTTP POST, no mmx CLI
const TTS_BASE = 'https://api.minimaxi.com/v1/t2a_v2';
const TTS_MODEL = 'speech-02-turbo';

async function ttsApi(text, outPath, timeoutMs = 30000) {
  // mmx CLI handles the API auth quirks on 105; keep using it for speech
  try {
    await execAsync(
      `${MMX_PATH} speech synthesize --text ${JSON.stringify(text)} --voice ${JSON.stringify(TTS_VOICE)} --out ${JSON.stringify(outPath)} 2>&1`,
      { timeout: timeoutMs }
    );
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 1000;
  } catch (e) {
    log('mmx speech failed:', e.message.slice(0, 200));
    return false;
  }
}

async function transcodeToStereo(srcPath, dstPath) {
  // mmx 返回 32kHz mono MP3；ESP32 I2S mixer 需要 44.1kHz stereo MP3
  const tmpWav = srcPath + '.wav';
  const tmpStereo = srcPath + '.st.wav';
  try {
    const env = Object.assign({}, process.env, {
      LD_LIBRARY_PATH: LAME_LIB_DIR + ':' + (process.env.LD_LIBRARY_PATH || ''),
    });
    // 1. decode mp3 -> wav
    await execAsync(`${LAME_BIN} --decode ${JSON.stringify(srcPath)} ${JSON.stringify(tmpWav)}`, {
      env, timeout: 30000,
    });
    // 2. mono -> stereo (channel duplication)
    await execAsync(`node ${JSON.stringify(MONO2STEREO_PATH)} ${JSON.stringify(tmpWav)} ${JSON.stringify(tmpStereo)}`, {
      timeout: 15000,
    });
    // 3. encode wav -> mp3 44.1kHz stereo 128kbps
    await execAsync(
      `${LAME_BIN} -b 128 -m s --resample 44.1 ${JSON.stringify(tmpStereo)} ${JSON.stringify(dstPath)}`,
      { env, timeout: 30000 }
    );
    return fs.existsSync(dstPath) && fs.statSync(dstPath).size > 1000;
  } catch (e) {
    log('transcode failed:', e.message.slice(0, 200));
    return false;
  } finally {
    [tmpWav, tmpStereo].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

// Recursive walk of a directory, returning absolute paths of all .mp3 files.
// Skips macOS resource forks (._* prefix) and any dotfile. Returns paths
// sorted for stable ordering. Defined here (not in server.js) because
// generate_playlist.js runs as a standalone child process spawned by
// dj_worker — it can't import server.js (which would also start the HTTP
// listener on import).
function walkMp3(rootDir) {
  const out = [];
  const stack = [rootDir];
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
  return out;
}

function findSongFile(name) {
  if (!fs.existsSync(STATIONS_DIR)) return null;
  for (const station of fs.readdirSync(STATIONS_DIR)) {
    const p = path.join(STATIONS_DIR, station, `${name}.mp3`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// NeteaseCloudMusicApi integration (branch feat/netease-only)
// ---------------------------------------------------------------------------
// The sidecar process must be running on this port (see README).
// All requests are anonymous — no
// login cookie, no VIP. Anonymous requests can still resolve search,
// playlist detail, and 320kbps song URLs for free content.
const NETEASE_API = process.env.NETEASE_API || 'http://127.0.0.1:3001';
const NETEASE_DOWNLOAD_DIR = process.env.NETEASE_DOWNLOAD_DIR || path.join(os.homedir(), 'Music', '网易云收藏');
const NETEASE_REQUEST_TIMEOUT = 8000;  // ms — search + song/url each have budget

// Sanitize a song name for use as a filename. Chinese chars are kept;
// we just strip path separators and control chars. Length cap prevents
// runaway names from breaking ext4 (max 255 bytes).
function sanitizeFilename(s) {
  return s
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// GET /search?keywords=... → returns first hit's id, or null
async function neteaseSearch(name, artist) {
  const q = encodeURIComponent(`${name} ${artist}`.trim());
  const url = `${NETEASE_API}/search?keywords=${q}&limit=5`;
  const r = await fetch(url, { signal: AbortSignal.timeout(NETEASE_REQUEST_TIMEOUT) });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const j = await r.json();
  const songs = j?.result?.songs || [];
  if (songs.length === 0) return null;
  // Prefer an exact name+artist match. NCM API 4.x uses `artists` (plural)
  // and `duration` (ms) — field names changed from the legacy 0.x API.
  const exact = songs.find(s =>
    s.name === name && s.artists?.some(a => a.name === artist)
  );
  const target = exact || songs[0];
  return {
    id: target.id,
    name: target.name,
    artist: target.artists?.[0]?.name || artist,
    duration: target.duration || 0,
  };
}

// GET /song/url?id=...&br=320000 → returns the actual MP3 CDN URL
async function neteaseGetSongUrl(id) {
  const url = `${NETEASE_API}/song/url?id=${id}&br=320000`;
  const r = await fetch(url, { signal: AbortSignal.timeout(NETEASE_REQUEST_TIMEOUT) });
  if (!r.ok) throw new Error(`song/url HTTP ${r.status}`);
  const j = await r.json();
  const item = j?.data?.[0];
  if (!item?.url) return null;  // VIP-only or geo-blocked
  return { url: item.url, size: item.size, br: item.br };
}

// Download a URL to a local file. We pipe through fetch → stream so we
// don't buffer the whole MP3 in memory (some tracks are 30MB).
async function downloadToFile(remoteUrl, destPath) {
  const r = await fetch(remoteUrl, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const ws = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    r.body.pipeTo(new WritableStream({
      write(chunk) { ws.write(Buffer.from(chunk)); },
      close() { ws.end(); },
    })).then(resolve, reject);
  });
  await new Promise((resolve) => ws.on('finish', resolve));
  return fs.statSync(destPath).size;
}

// Combined helper used by main(). Resolves (name, artist) on netease
// and downloads the 320kbps MP3 to NETEASE_DOWNLOAD_DIR. Returns the
// absolute file path on success, or null if any step failed (search
// miss, VIP-only, network error). Failures are logged but never throw
// — caller decides what to do.
async function neteaseSearchAndDownload(name, artist) {
  try {
    const hit = await neteaseSearch(name, artist);
    if (!hit) {
      log(`  [netease] no search result for "${name} - ${artist}"`);
      return null;
    }
    const urlInfo = await neteaseGetSongUrl(hit.id);
    if (!urlInfo) {
      log(`  [netease] no 320k URL for id=${hit.id} (${name} - ${artist}, likely VIP)`);
      return null;
    }
    // Filename: "{name} - {artist}.mp3" (sanitized). If file already
    // exists with the same name, we reuse it — re-running the same
    // batch is idempotent and avoids hammering netease's CDN.
    const safeName = sanitizeFilename(`${hit.name} - ${hit.artist}`);
    const destPath = path.join(NETEASE_DOWNLOAD_DIR, `${safeName}.mp3`);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100_000) {
      log(`  [netease] reusing cached file: ${destPath}`);
      return destPath;
    }
    const size = await downloadToFile(urlInfo.url, destPath);
    log(`  [netease] downloaded ${(size / 1024).toFixed(0)} KB → ${destPath}`);
    return destPath;
  } catch (e) {
    log(`  [netease] error for "${name} - ${artist}": ${e.message.slice(0, 150)}`);
    return null;
  }
}

function loadAllTracks() {
  // Scan all stations for MP3 files, exclude songs unchecked in 曲目库
  if (!fs.existsSync(STATIONS_DIR)) {
    log('WARNING: STATIONS_DIR not found, using placeholder list');
    return ['Always With Me', 'Summer', 'Rain & Summer'];
  }

  // Load excluded list (曲目库取消勾选)
  const excludedFile = path.join(PLAYLIST_ROOT, 'excluded_songs.json');
  let excluded = new Set();
  try {
    if (fs.existsSync(excludedFile)) {
      excluded = new Set(JSON.parse(fs.readFileSync(excludedFile, 'utf8')));
    }
  } catch (e) {
    log('warn: cannot read excluded_songs.json:', e.message);
  }

  // Load previously recommended songs — these won't be sent to AI again
  let recommended = new Set();
  try {
    if (fs.existsSync(RECOMMENDED_FILE)) {
      recommended = new Set(JSON.parse(fs.readFileSync(RECOMMENDED_FILE, 'utf8')));
    }
  } catch (e) {
    log('warn: cannot read recommended_songs.json:', e.message);
  }

  // Build candidate pool:
  //   - walkMp3() recursively scans each station (subfolders included)
  //   - same filename across stations stays distinct via the basename key
  //     (Set would otherwise collapse them and hide everything except
  //     first-seen — e.g. 宫崎骏电台 千与千寻.mp3 vs 车载必备 千与千寻.mp3)
  //   - recommended/excluded filter the basename, not the key
  // We also build a `basename -> [{station, fullPath}]` index so later
  // (when AI picks a song by name) we can pick any file with that name.
  const tracks = new Set();
  const byName = new Map();   // basename -> [{station, fullPath}]
  for (const station of fs.readdirSync(STATIONS_DIR)) {
    const stationDir = path.join(STATIONS_DIR, station);
    let stat;
    try { stat = fs.statSync(stationDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const allFiles = walkMp3(stationDir);
    for (const f of allFiles) {
      const filename = path.basename(f, '.mp3');
      if (excluded.has(filename) || recommended.has(filename)) continue;
      tracks.add(filename);
      if (!byName.has(filename)) byName.set(filename, []);
      byName.get(filename).push({ station, fullPath: f });
    }
  }
  const list = [...tracks];
  log(`Scanned ${list.length} active basenames (${excluded.size} excluded, ${recommended.size} previously recommended) from ${STATIONS_DIR}`);
  // Stash the index for the caller to resolve AI picks → actual file paths.
  return { basenames: list, byName };
}

function loadRecentHistory() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return state.playedHistory || [];
    } catch {}
  }
  return [];
}

async function fetchWeatherFromServer() {
  // 调用 server.js 的 /api/weather 端点（统一使用和风天气，avoid重复配置）
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 5 ${SERVER_URL}/api/weather`,
      { timeout: 7000 }
    );
    const j = JSON.parse(stdout);
    if (j.error) return null;
    const now = j.now || {};
    const today = j.today || {};
    const parts = [];
    if (j.city) parts.push(j.city);
    if (now.text) parts.push(now.text);
    if (now.temp) parts.push(`${now.temp}°C`);
    if (today.tempMin && today.tempMax) parts.push(`全天${today.tempMin}~${today.tempMax}°C`);
    return parts.length ? parts.join('，') : null;
  } catch (e) {
    log('weather fetch failed:', e.message.slice(0, 100));
    return null;
  }
}

function getTimePeriod(hour) {
  if (hour < 6) return '凌晨';
  if (hour < 9) return '早晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 21) return '傍晚';
  return '晚上';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('=== Playlist generation started ===');
  log(`tools: lame=${LAME_BIN}`);

  // Initial state — worker reads this to mark "running"
  reportProgress({
    state: 'running',
    batch: DJ_BATCH,
    started_at: new Date().toISOString(),
    progress: {
      total: SONGS_PER_PLAYLIST,
      current: 0,
      phase: 'selecting',
      current_song: null,
      succeeded: 0,
      failed: 0,
    },
  });

  // SIGTERM/SIGINT handler — graceful cancel
  let cancelled = false;
  function handleSignal(sig) {
    if (cancelled) return;  // already cancelling
    cancelled = true;
    log(`Received ${sig}, will cancel after current song...`);
    reportProgress({ state: 'cancelling' });
  }
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // 1. Create playlist dir — use Asia/Shanghai throughout (server may be UTC)
  const now = new Date();
  const cnFmt = (opt) => now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false, ...opt });
  const sy = parseInt(cnFmt({ year: 'numeric' }));
  const sm = parseInt(cnFmt({ month: '2-digit' }));
  const sd = parseInt(cnFmt({ day: '2-digit' }));
  const sh = parseInt(cnFmt({ hour: '2-digit' }));
  const smin = parseInt(cnFmt({ minute: '2-digit' }));
  const stamp = `${sy}${String(sm).padStart(2,'0')}${String(sd).padStart(2,'0')}${String(sh).padStart(2,'0')}${String(smin).padStart(2,'0')}`;
  const hour = sh;
  const playlistDir = path.join(PLAYLIST_ROOT, stamp);
  const introsDir = path.join(playlistDir, INTRO_REL_DIR);
  fs.mkdirSync(introsDir, { recursive: true });

  // 2. Load context — NEW (netease-only branch feat/netease-only):
  //    We NO LONGER scan /mnt/music. The LLM generates song names from
  //    its own knowledge ("凭空"), and we resolve each pick via the
  //    NeteaseCloudMusicApi sidecar running on localhost:3001. Every
  //    successfully downloaded track lands in NETEASE_DOWNLOAD_DIR,
  //    so subsequent runs re-discover them as a real station if we ever
  //    re-enable local scanning.
  //
  //    Previous design sampled 600 basenames from a 14k local library,
  //    which made the AI's choices heavily biased by what we already
  //    own. Going netease-only means the AI can pick any song it knows
  //    about, and we fetch the actual audio on demand.
  const recent = loadRecentHistory();
  const timeOfDay = getTimePeriod(hour);

  const weather = (await fetchWeatherFromServer()) || '天气未知';
  log('Context:', `${timeOfDay} ${hour}:00, weather="${weather}", recent=${recent.length} songs, source=netease-only`);

  // Also capture structured weather for fallback
  let weatherStructured = null;
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 5 ${SERVER_URL}/api/weather`,
      { timeout: 7000 }
    );
    const j = JSON.parse(stdout);
    if (!j.error && j.now) {
      weatherStructured = {
        temp: j.now.temp,
        tempMin: j.today?.tempMin,
        tempMax: j.today?.tempMax,
        humidity: j.now.humidity,
        text: j.now.text,
      };
    }
  } catch {} // non-fatal

  // 3. AI song selection — template from BATCH_VIBES
  const batchKey = (DJ_BATCH && BATCH_VIBES[DJ_BATCH]) ? DJ_BATCH : 'manual';
  const vibe = BATCH_VIBES[batchKey];
  // Pick a persona for this batch (4 roles: mom/dad/deer_sister/grandpa).
  // The selection persists across the AI prompt and the first-song intro
  // — if we used a different persona for each, the playlist intro would
  // feel disjointed. The DJ_BATCH env also accepts "mom"/"dad"/...
  // directly, which is how the panel will pin a host.
  const personaList = vibe.personas || [];
  const requestedPersonaId = process.env.DJ_PERSONA || null;
  const persona = requestedPersonaId
    ? personaList.find(p => p.id === requestedPersonaId) || personaList[0]
    : personaList[Math.floor(Math.random() * personaList.length)] || null;
  const personaAddon = persona?.system_addon || '';
  const personaIntroAddon = persona?.intro_addon || '';
  log(`Persona: ${persona?.id || 'default'} (${persona?.name || 'n/a'})`);

  const systemTemplate = vibe.system
    .replace(/\{timeOfDay\}/g, timeOfDay)
    .replace(/\{hour\}/g, String(hour))
    .replace(/\{location\}/g, LOCATION)
    .replace(/\{weather\}/g, weather)
    .replace(/\{count\}/g, String(SONGS_PER_PLAYLIST))
    + personaAddon;

  // Report track count early (0 because we no longer scan local library)
  reportProgress({ progress: {
    phase: 'selecting',
    track_count: 0,
    total: SONGS_PER_PLAYLIST,
  } });

  // netease-only prompt — LLM generates song picks from its own knowledge.
  // We do NOT feed it any candidate list. Output format is now
  // "歌名 | 歌手 | 播报文案" (3 fields pipe-separated) so we can hand
  // the (歌名, 歌手) pair to NeteaseCloudMusicApi /search and reliably
  // resolve the right track — the previous 2-field "歌名 | 文案" format
  // required fuzzy-matching against the local library, which doesn't
  // exist anymore.
  const selectionPrompt = `${systemTemplate}

示例输出（每行三栏，用 | 分隔）：
小星星 | 贝乐虎儿歌 | 窗外的小星星一闪一闪的，川川躺在床上看着天花板，跟着节拍小声哼唱。
两只老虎 | 贝乐虎儿歌 | 两只小老虎蹦蹦跳跳，川川的脚丫也在被子里跟着节奏踩呀踩。
Summer | 久石让 | 窗外的阳光像蜂蜜一样黏在川川的睫毛上，暖洋洋的，忍不住想打个哈欠。

只输出 ${SONGS_PER_PLAYLIST} 行，每行严格三栏：歌名 | 歌手 | 播报文案。
- 歌名必须真实存在，不要编造
- 歌手填主要演唱者，单一姓名
- 播报文案 12-25 字，温暖有画面感
- 不要任何解释、不要编号、不要 Markdown。每首一行。`;

  log('--- PROMPT (full, netease-only mode) ---');
  log(selectionPrompt);
  log('--- PROMPT END ---');
  log(`(prompt size: ${selectionPrompt.length} chars)`);

  if (checkCancelled() || cancelled) { log('Cancelled before AI selection'); process.exit(130); }
  reportProgress({ progress: {
    phase: 'ai_text',
    current: 0,
    track_count: 0,
    ai_candidates: 0,  // no local candidates anymore
    ai_status: `正在让 ${persona?.name || 'AI'} 凭空选歌...`,
    persona: persona ? { id: persona.id, name: persona.name } : null,
  } });

  const aiResp = await anthropicChat(selectionPrompt);
  if (!aiResp) {
    log('AI selection failed, aborting');
    reportProgress({ state: 'failed', result: { error: 'AI selection failed' } });
    process.exit(1);
  }
  log('AI selected songs');

  // Report AI raw response preview
  const aiLines = aiResp.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  reportProgress({ progress: {
    phase: 'ai_text',
    ai_status: `AI 已返回 ${aiLines.length} 行，正在解析...`,
    ai_raw_lines: aiLines.length,
    ai_raw_preview: aiLines.slice(0, 5).map(l => l.replace(/^[\d\.\s]*/, '').split('|')[0]?.trim() || l).filter(Boolean),
  } });
  log('--- AI RESPONSE (full) ---');
  log(aiResp);
  log('--- AI RESPONSE END ---');
  log('');

  // 4. Parse AI response — 3-field format: 歌名 | 歌手 | 播报文案
  // Skip lines that look like markdown table rows, headers, or numbered lists
  const aiRawRows = [];
  for (const rawLine of aiResp.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('---')) continue;
    // Strip optional leading "1. " numbering
    const cleaned = line.replace(/^\d+\.\s*/, '');
    // Split on | — expect exactly 3 fields
    const parts = cleaned.split('|').map(s => s.trim());
    if (parts.length < 3) continue;
    const [name, artist, intro] = parts;
    if (!name || !artist || intro.length < 8) continue;
    aiRawRows.push({ name, artist, intro });
  }
  log(`Parsed ${aiRawRows.length} AI rows (need up to ${SONGS_PER_PLAYLIST})`);
  if (aiRawRows.length === 0) {
    log('No valid AI rows, aborting');
    reportProgress({ state: 'failed', result: { error: 'No valid AI rows' } });
    process.exit(1);
  }

  // Report AI selection preview
  reportProgress({ progress: {
    phase: 'ai_text',
    ai_status: `AI 返回 ${aiRawRows.length} 行，正在去网易搜歌...`,
    ai_raw_lines: aiRawRows.length,
    ai_raw_preview: aiRawRows.slice(0, 5).map(r => `${r.name} - ${r.artist}`),
  } });
  log('--- AI PICKS ---');
  for (const r of aiRawRows) log(`  ${r.name} | ${r.artist} | ${r.intro}`);
  log('--- END ---');

  // 4b. netease search + download — for each AI pick, find the real
  // track on 网易云 and download the 320kbps MP3 to NETEASE_DOWNLOAD_DIR.
  // The downloaded file becomes the new "songPath" the rest of the
  // pipeline expects.
  //
  // 累计下载满 SONGS_PER_PLAYLIST 首完整歌曲为止。遇到 30 秒试听片段
  // （VIP/付费歌曲对非 VIP 用户的退化版）就跳过继续遍历 AI 返回的剩余行。
  // AI 通常返 30-40 行，前 60 行足够富余；如果还不够，记 partial outcome。
  const downloadedSongs = [];
  let trialSkipped = 0;
  for (let i = 0; i < aiRawRows.length; i++) {
    if (checkCancelled() || cancelled) {
      log(`Cancelled at netease pick ${i + 1}/${aiRawRows.length}`);
      break;
    }
    if (downloadedSongs.length >= SONGS_PER_PLAYLIST) {
      log(`Reached ${SONGS_PER_PLAYLIST} full songs, stopping at AI row ${i + 1}/${aiRawRows.length} (trial-clips skipped so far: ${trialSkipped})`);
      break;
    }
    const { name, artist, intro } = aiRawRows[i];
    const idx = i + 1;
    reportProgress({ progress: {
      phase: 'netease',
      current: idx,
      current_song: `${name} - ${artist}`,
      phase_status: `正在搜 ${idx}/${aiRawRows.length}: ${name} - ${artist}`,
    } });
    try {
      const filePath = await neteaseSearchAndDownload(name, artist);
      if (filePath) {
        downloadedSongs.push({ name, intro, filePath, station: '网易云收藏' });
        log(`  ✓ [${idx}] ${name} - ${artist} → ${filePath}`);
      } else {
        trialSkipped++;
        log(`  ↷ [${idx}] ${name} - ${artist} (skipped: trial clip or VIP-only, trying next)`);
      }
    } catch (e) {
      trialSkipped++;
      log(`  ✗ [${idx}] ${name} - ${artist} (error: ${e.message.slice(0, 100)})`);
    }
  }
  const songs = downloadedSongs;  // alias for downstream
  if (songs.length === 0) {
    log('No songs successfully resolved on netease, aborting');
    reportProgress({ state: 'failed', result: { error: 'All netease picks failed' } });
    process.exit(1);
  }
  log(`Resolved ${songs.length}/${aiRawRows.length} songs via netease (${trialSkipped} trial-clips skipped)`);
  reportProgress({
    progress: {
      total: songs.length,
      phase: 'first_intro',
      current: 0,
      selected_count: songs.length,
      selected_songs: songs.map(s => `${s.name} (${s.station})`),
    },
  });

  // 5. Generate special 300-char intro for the first song — use vibe config
  if (songs.length > 0) {
    log('Generating extended intro for first song...');
    reportProgress({ progress: { phase: 'first_intro' } });
    const firstSong = songs[0];
    const introPromptBase = (vibe.intro_prompt || '').length > 10
      ? vibe.intro_prompt
          .replace(/\{timeOfDay\}/g, timeOfDay)
          .replace(/\{hour\}/g, String(hour))
          .replace(/\{location\}/g, LOCATION)
          .replace(/\{weather\}/g, weather)
          .replace(/\{song_name\}/g, firstSong.name)
          + personaIntroAddon  // append persona voice to intro prompt
      : `你是一个床头小广播，给 5 岁小男孩川川讲故事。现在是${timeOfDay}${hour}点，川川在${LOCATION}。天气：${weather}。\n\n第一首要播的歌是《${firstSong.name}》。请你写一段 250-350 字的播报词，温暖亲切。\n开头叫一声"川川"。\n自然地包含现在的天气和时间。\n介绍一下这首歌像什么。\n语气温暖有画面感。\n最后说"准备好了吗？我们开始吧——"引出歌曲。\n\n只输出文案，不要任何格式。${personaIntroAddon}`;
    const firstIntro = await anthropicChat(introPromptBase, 60000);
    if (firstIntro && firstIntro.length > 100) {
      songs[0] = { ...firstSong, intro: firstIntro };
      log(`First song intro updated: ${firstIntro.length} chars`);
    } else {
      log(`First song intro generation failed, keeping original (${(firstIntro||'').length} chars)`);
    }
  }

  // 6. Generate intro for each song
  const playlist = [];
  let failed = 0;
  for (let i = 0; i < songs.length; i++) {
    if (checkCancelled() || cancelled) {
      log(`Cancelled at song ${i + 1}/${songs.length}`);
      break;
    }
    const { name, intro, filePath: songPathFromIndex } = songs[i];
    const idx = i + 1;
    const introFile = path.join(introsDir, `${idx}.mp3`);
    const ttsRaw = path.join(introsDir, `${idx}.raw.mp3`);
    const stitchedFile = path.join(introsDir, `${idx}.stitched.mp3`);

    log(`[${idx}/${songs.length}] ${name} → "${intro}"`);
    reportProgress({ progress: { current: idx, current_song: name, phase: 'tts' } });

    // TTS
    const ttsOk = await ttsApi(intro, ttsRaw);
    if (!ttsOk) {
      log(`  ✗ speech failed for "${name}", skipping`);
      failed++;
      reportProgress({ progress: { failed } });
      continue;
    }

    // 转码
    reportProgress({ progress: { phase: 'transcoding' } });
    const stereoOk = await transcodeToStereo(ttsRaw, introFile);
    try { fs.unlinkSync(ttsRaw); } catch {}
    if (!stereoOk) {
      log(`  ✗ transcode failed for "${name}", skipping`);
      failed++;
      reportProgress({ progress: { failed } });
      continue;
    }

    // 拼接 intro + song
    reportProgress({ progress: { phase: 'stitching' } });
    // Prefer the full path we already resolved via trackIndex. Fall back to
    // findSongFile() (recursive, top-level scan) for backwards compat.
    let songPath = songPathFromIndex;
    if (!songPath) {
      songPath = findSongFile(name);
    }
    if (!songPath) {
      log(`  ⚠ song file not found for "${name}", skipping stitch`);
      failed++;
      reportProgress({ progress: { failed } });
      continue;
    }
    try {
      const introBuf = fs.readFileSync(introFile);
      const songBuf = fs.readFileSync(songPath);
      // For the first song, just stitch intro + song (no preamble)
      fs.writeFileSync(stitchedFile, Buffer.concat([introBuf, songBuf]));
    } catch (e) {
      log(`  ✗ stitch failed: ${e.message.slice(0, 100)}`);
      failed++;
      reportProgress({ progress: { failed } });
      continue;
    }

    playlist.push({
      index: idx,
      name,
      intro_text: intro,
      intro_file: `${INTRO_REL_DIR}/${idx}.mp3`,
      intro_url: `/audio/playlist-intro/${stamp}/${idx}.mp3`,
      track_url: `/audio/local/track/${encodeURIComponent(name)}`,
      stitched_url: `/audio/playlist-stitched/${stamp}/${idx}.mp3`,
    });
    log(`  ✓ ${name} (${(fs.statSync(stitchedFile).size / 1024).toFixed(0)} KB stitched)`);
  }

  if (playlist.length === 0) {
    log('No intros generated successfully, aborting (leaving current.json untouched)');
    reportProgress({ state: 'failed', result: { error: 'All songs failed' } });
    process.exit(1);
  }

  // 6. Write playlist.json (atomic: .tmp -> rename)
  const finalState = (cancelled || checkCancelled()) ? 'cancelled' : 'done';
  const playlistData = {
    generated_at: now.toISOString(),
    valid_until: new Date(now.getTime() + PLAYLIST_TTL_HOURS * 3600 * 1000).toISOString(),
    weather,
    weather_temp: weatherStructured?.temp || '--',
    weather_temp_min: weatherStructured?.tempMin || '--',
    weather_temp_max: weatherStructured?.tempMax || '--',
    weather_humidity: weatherStructured?.humidity || '--',
    time_of_day: timeOfDay,
    hour,
    persona: persona ? { id: persona.id, name: persona.name } : null,
    songs: playlist,
    current_index: 0,
    stats: { requested: songs.length, succeeded: playlist.length, failed },
  };

  const finalPlaylistJson = path.join(playlistDir, 'playlist.json');
  const tmpJson = finalPlaylistJson + '.tmp';
  fs.writeFileSync(tmpJson, JSON.stringify(playlistData, null, 2));
  fs.renameSync(tmpJson, finalPlaylistJson);
  log(`Wrote playlist.json: ${playlist.length}/${songs.length} succeeded, ${failed} failed`);

  // 7. Atomic swap: point "current" symlink to new dir
  try { fs.unlinkSync(PLAYLIST_LINK); } catch {}
  try { fs.unlinkSync(PLAYLIST_JSON); } catch {}
  fs.symlinkSync(finalPlaylistJson, PLAYLIST_JSON);  // current.json → playlist.json
  log(`Symlinked current.json → ${stamp}/playlist.json`);

  // 8. Save recommended songs — never send these to AI again
  if (playlist.length > 0 && finalState !== 'cancelled') {
    try {
      let existing = [];
      if (fs.existsSync(RECOMMENDED_FILE)) {
        existing = JSON.parse(fs.readFileSync(RECOMMENDED_FILE, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      }
      const newSongs = playlist.map(s => s.name);
      // Merge, dedupe
      const merged = [...new Set([...existing, ...newSongs])];
      // Keep only last 500 to avoid the file growing forever
      if (merged.length > 500) merged.splice(0, merged.length - 500);
      const tmpR = RECOMMENDED_FILE + '.tmp';
      fs.writeFileSync(tmpR, JSON.stringify(merged));
      fs.renameSync(tmpR, RECOMMENDED_FILE);
      log(`Saved ${newSongs.length} recommended songs (${merged.length} total known)`);
    } catch (e) {
      log('warn: could not save recommended songs:', e.message);
    }
  }

  // Report final state (with full playlist data so web can show results)
  reportProgress({
    state: finalState,
    progress: {
      total: songs.length,
      current: songs.length,
      phase: 'done',
      succeeded: playlist.length,
      failed,
    },
    result: {
      generated_at: playlistData.generated_at,
      valid_until: playlistData.valid_until,
      weather,
      songs: playlist,
      stamp,
    },
  });

  // 8. Cleanup old playlists (keep last 5 days)
  try {
    const dirs = fs.readdirSync(PLAYLIST_ROOT)
      .filter(d => /^\d{12}$/.test(d))
      .sort()
      .reverse();
    const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
    for (const d of dirs) {
      const dirStamp = new Date(
        `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(8,10)}:00:00Z`
      ).getTime();
      if (dirStamp < cutoff && dirs.indexOf(d) > 0) {
        fs.rmSync(path.join(PLAYLIST_ROOT, d), { recursive: true, force: true });
        log(`Cleaned old playlist: ${d}`);
      }
    }
  } catch (e) {
    log('cleanup warning:', e.message.slice(0, 100));
  }

  log(`=== Playlist generation complete (${playlist.length} songs, state=${finalState}) ===`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});