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
const STATIONS_DIR = '/mnt/music';
const STATE_FILE = path.join(PROJECT_ROOT, '.radio_state.json');
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
    '/home/zulin/.nvm/versions/node/v20.20.2/bin/mmx',
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

function findSongFile(name) {
  if (!fs.existsSync(STATIONS_DIR)) return null;
  for (const station of fs.readdirSync(STATIONS_DIR)) {
    const p = path.join(STATIONS_DIR, station, `${name}.mp3`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadAllTracks() {
  // Scan all stations for MP3 files, exclude songs unchecked in 曲目库
  if (!fs.existsSync(STATIONS_DIR)) {
    log('WARNING: STATIONS_DIR not found, using placeholder list');
    return ['Always With Me', 'Summer', 'Rain & Summer'];
  }

  // Load excluded list
  const excludedFile = path.join(PLAYLIST_ROOT, 'excluded_songs.json');
  let excluded = new Set();
  try {
    if (fs.existsSync(excludedFile)) {
      excluded = new Set(JSON.parse(fs.readFileSync(excludedFile, 'utf8')));
    }
  } catch (e) {
    log('warn: cannot read excluded_songs.json:', e.message);
  }

  const tracks = new Set();
  for (const station of fs.readdirSync(STATIONS_DIR)) {
    const stationDir = path.join(STATIONS_DIR, station);
    let stat;
    try { stat = fs.statSync(stationDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(stationDir)) {
      if (!f.toLowerCase().endsWith('.mp3')) continue;
      const name = path.basename(f, '.mp3');
      if (!excluded.has(name)) tracks.add(name);
    }
  }
  const list = [...tracks];
  log(`Scanned ${list.length} active tracks (${excluded.size} excluded) from ${STATIONS_DIR}`);
  return list;
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

  // 2. Load context — MiniMax-M3 handles 262 tracks (1M context), no truncation needed
  const allTracks = loadAllTracks();
  const recent = loadRecentHistory();
  const timeOfDay = getTimePeriod(hour);
  const trackPool = allTracks;

  const weather = (await fetchWeatherFromServer()) || '天气未知';
  log('Context:', `${timeOfDay} ${hour}:00, weather="${weather}", recent=${recent.length} songs, available=${allTracks.length}`);

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
  const systemTemplate = vibe.system
    .replace(/\{timeOfDay\}/g, timeOfDay)
    .replace(/\{hour\}/g, String(hour))
    .replace(/\{location\}/g, LOCATION)
    .replace(/\{weather\}/g, weather)
    .replace(/\{count\}/g, String(SONGS_PER_PLAYLIST));

  // Report track count early
  reportProgress({ progress: {
    phase: 'selecting',
    track_count: allTracks.length,
    total: SONGS_PER_PLAYLIST,
  } });

  const selectionPrompt = `${systemTemplate}

避开近期已播：${recent.slice(-15).join('、') || '无'}

示例输出歌名并不是真的歌名：
千与千寻 | 雨滴滴答答敲在窗玻璃上，川川趴在窗边看外面灰蒙蒙的天。这首歌就像雨天里的一把小伞，可以撑着它跳进小水坑里啪嗒啪嗒踩水玩！
Summer | 窗外的阳光暖洋洋的，小鸟在树枝上叽叽喳喳。这首歌像一阵带着花香的风，吹到脸上痒痒的、暖暖的，让人想出去跑一跑！

歌曲列表：
${trackPool.map((t, i) => `${i + 1}. ${t}`).join('\n')}

只输出 ${SONGS_PER_PLAYLIST} 行，格式：歌名 | 播报文案。
不要任何解释、不要编号、不要 Markdown。每首一行。`;

  log('--- PROMPT (first 500 chars) ---');
  log(selectionPrompt.slice(0, 500));
  log(`... (${trackPool.length}/${allTracks.length} tracks, ${selectionPrompt.length} chars)`);
  log('--- PROMPT END ---');

  if (checkCancelled() || cancelled) { log('Cancelled before AI selection'); process.exit(130); }
  reportProgress({ progress: {
    phase: 'ai_text',
    current: 0,
    track_count: allTracks.length,
    ai_candidates: trackPool.length,
    ai_status: '正在发送歌曲列表给 AI...',
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

  // 4. Parse AI response — accept CSV (歌名,文案) or legacy pipe (歌名 | 文案)
// Skip lines that look like markdown table rows, headers, or numbered lists
  const songs = [];
  const seen = new Set();  // dedupe
  for (const rawLine of aiResp.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip markdown-ish lines
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('---')) continue;
    // Try pipe format first (歌名 | 文案), then CSV (歌名,文案)
    // Line number prefix is optional (the AI might or might not add "1. ")
    let m = line.match(/^(?:\d+\.\s*)?(.+?)\s*\|\s*(.+?)\s*$/);
    if (!m) m = line.match(/^(?:\d+\.\s*)?(.+?)\s*,\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    const intro = m[2].trim();
    // Reject intros that are too short (<10 chars = LLM not following format)
    if (intro.length < 10) continue;
    // Strip leading numbers/spaces the LLM might still include ("1. 歌名,文案")
    const cleanName = name.replace(/^\d+\.\s*/, '').trim();
    // Must match a known track (exact or fuzzy — AI sometimes drops parenthetical suffixes)
    let match = allTracks.find(t => t === cleanName);
    if (!match) {
      // Fuzzy: AI wrote "千与千寻" but the real name is "千与千寻(神隐少女)"
      match = allTracks.find(t => t.includes(cleanName) && cleanName.length >= 2);
    }
    if (!match) continue;
    if (seen.has(match)) continue;
    seen.add(match);
    songs.push({ name: match, intro });
    if (songs.length >= SONGS_PER_PLAYLIST) break;
  }
  if (songs.length === 0) {
    log('No valid songs parsed from AI response, aborting');
    log('Raw AI response (first 500 chars):', aiResp.slice(0, 500));
    reportProgress({ state: 'failed', result: { error: 'No valid songs parsed' } });
    process.exit(1);
  }
  log(`Parsed ${songs.length} songs`);
  reportProgress({
    progress: {
      total: songs.length,
      phase: 'first_intro',
      current: 0,
      selected_count: songs.length,
      selected_songs: songs.map(s => s.name),
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
      : `你是一个床头小广播，给 5 岁小男孩川川讲故事。现在是${timeOfDay}${hour}点，川川在${LOCATION}。天气：${weather}。\n\n第一首要播的歌是《${firstSong.name}》。请你写一段 250-350 字的播报词，温暖亲切。\n开头叫一声"川川"。\n自然地包含现在的天气和时间。\n介绍一下这首歌像什么。\n语气温暖有画面感。\n最后说"准备好了吗？我们开始吧——"引出歌曲。\n\n只输出文案，不要任何格式。`;
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
    const { name, intro } = songs[i];
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
    const songPath = findSongFile(name);
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