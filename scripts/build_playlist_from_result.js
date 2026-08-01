#!/usr/bin/env node
/**
 * build_playlist_from_result.js — convert a finished scene_fetch's
 * downloaded songs into a stitched, intro-narrated playlist that the
 * ESP can play.
 *
 * Triggered automatically by dj_worker.js after a scene_fetch exits 0.
 * Reads queue_state.json → result.songs[] (the NCM-downloaded files
 * that scene_fetch just put on disk), then for each song:
 *   1. Generate a short intro line via mmx text chat (scene + name)
 *   2. TTS the intro line (mmx speech, Male_Announcer voice)
 *   3. Transcode mmx's 32kHz mono MP3 → 44.1kHz stereo MP3
 *   4. Stitch intro + song → intros/<idx>.stitched.mp3
 *   5. Write playlist.json
 *   6. Atomically symlink current.json → playlist.json
 *
 * Unlike generate_playlist.js this script:
 *   - Does NOT call anthropic to select songs (the scene_fetch already
 *     chose them via NCM search)
 *   - Does NOT generate a 250-char 川川 narrative (those are persona
 *     specific; this script emits short scene-aware intros that work
 *     for any listener)
 *   - Does NOT use playedHistory (the scene_fetch already skipped used
 *     playlists upstream)
 *
 * Idempotent: re-running overwrites the playlist. Safe.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { exec } = require('child_process');
const os = require('os');

// ---------------------------------------------------------------
// Central runtime settings — shared with server.js. Read from
// config/settings.json, fall back to hardcoded defaults if missing.
// Returns deep-cloned DEFAULT_SETTINGS so callers can mutate freely.
// ---------------------------------------------------------------
const SETTINGS_FILE = path.join(__dirname, '..', 'config', 'settings.json');
const DEFAULT_SETTINGS = {
  weather: {
    // Empty by default — resolved at request time from
    // config/settings.json (configured via /settings UI) or the
    // server's /api/weather endpoint.
    apiKey: 'YOUR_QWEATHER_API_KEY_HERE',
    host:   '',  // Your QWeather API host (sign up at https://dev.qweather.com/)
  },
  minimax: {
    apiKey:         '',
    llmProvider:    'minimax',
    deepseekApiKey: '',
    deepseekBase:   'https://api.deepseek.com/chat/completions',
    deepseekModel:  'deepseek-v4-flash',
    anthropicBase:  'https://api.minimaxi.com/anthropic/v1/messages',
    anthropicModel: 'MiniMax-M3',
    ttsEnabled:     true,
    ttsBase:        'https://api.minimaxi.com/v1/t2a_v2',
    ttsModel:       'speech-02-turbo',
    ttsVoiceId:     'male-qn-qingse',
  },
  library: {
    stationsDir: process.env.STATIONS_DIR || path.join(os.homedir(), 'Music', '网易云收藏'),
  },
};

function loadSettings() {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      for (const k of Object.keys(out)) {
        if (d[k] && typeof d[k] === 'object') Object.assign(out[k], d[k]);
      }
    }
  } catch (e) { /* ignore — use defaults */ }
  return out;
}

const SETTINGS = loadSettings();
// Weather is now unified — we fetch from the local server's /api/weather
// endpoint, which uses an in-memory 1-min cache. Saves a QWeather roundtrip
// per scene-fetch and means changing the city/host in the Settings UI
// takes effect for the next build without server restart (and worker).
const SERVER_BASE = process.env.RADIO_STREAMS_URL || 'http://127.0.0.1:3000';

const ANTHROPIC_KEY     = SETTINGS.minimax.apiKey || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mmx', 'config.json'), 'utf-8')).api_key; } catch { return null; } })();
const ANTHROPIC_BASE    = SETTINGS.minimax.anthropicBase;
const ANTHROPIC_MODEL   = SETTINGS.minimax.anthropicModel;
const LLM_PROVIDER      = SETTINGS.minimax.llmProvider;
const LLM_BASE          = LLM_PROVIDER === 'deepseek' ? SETTINGS.minimax.deepseekBase : ANTHROPIC_BASE;
const LLM_MODEL         = LLM_PROVIDER === 'deepseek' ? SETTINGS.minimax.deepseekModel : ANTHROPIC_MODEL;
const TTS_BASE          = SETTINGS.minimax.ttsBase;
const TTS_MODEL         = SETTINGS.minimax.ttsModel;
const TTS_VOICE_ID      = SETTINGS.minimax.ttsVoiceId;
const TTS_ENABLED       = SETTINGS.minimax.ttsEnabled !== false;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLAYLIST_ROOT = path.join(PROJECT_ROOT, '.radio_playlist');
const PLAYLIST_LINK = PLAYLIST_ROOT; // current.json lives directly here

// ---------- paths & tool detection (mirrors generate_playlist.js) ----------
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
  return 'mmx';
}

function detectLameBin() {
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
const TTS_VOICE = 'Chinese (Mandarin)_Male_Announcer';
// Boost TTS intro audio so it's not drowned out by the song. Applied during
// the lame re-encode step via --scale. 1.0 = unchanged, 1.20 = +20% (default).
const TTS_GAIN = 1.20;

// ----------------------------------------------------------------
// Intro-prompt config — editable from the admin UI. Persisted to
// config/intro_prompts.json on disk so changes survive restarts.
// Falls back to these hard-coded defaults if the file is missing.
// ----------------------------------------------------------------
const INTRO_PROMPTS_PATH = path.join(PROJECT_ROOT, 'config', 'intro_prompts.json');
const INTRO_PROMPTS_DEFAULTS = {
  system_template: `你是电台DJ。按 JSON 数组格式输出，不要任何思考过程或解释，不要 markdown 代码块。
每首歌对应一句 15-20 字的中文播报词，自然亲切、语气贴合"\${sceneHint}"。
格式：[{"name":"歌名","intro":"..."}, ...]，顺序与下面列表完全一致。`,
  user_template: '【当天天气概况】：今天 ${weatherToday}。明天 ${weatherTomorrow}。\n【场景】：${sceneHint}\n【日期】：${todayDate}\n【星期】：${weekday}\n\n请为下面 ${songs.length} 首歌各写**一段**播报词（不许多写！不要额外的开场/收尾段！每首歌对应一段！）：\n\n- 第 1 首《${songs[0].name}》：110-160 字的\"开场白\"（**必须包含歌名《${songs[0].name}》**）。开场白可以包含今天的天气、穿衣服指南、日期、放假信息等（如果是早安场景）。如果场景不是早安，开场白可以提一下日期/天气/场景氛围。\n\n- 第 2 到第 ${songs.length - 1} 首：每首 22-38 字的单句播报词。**每段必须包含该首歌的原名**（歌名必须出现在句子中间或末尾，不要单独成行），一个画面或动作，不用形容词堆叠。\n\n- 第 ${songs.length} 首《${songs[songs.length - 1].name}》（最后一首）：18-30 字的简短收尾。**必须包含歌名《${songs[songs.length - 1].name}》**。\n\n铁律：\n- 总共**只输出 ${songs.length} 段**，每首歌一段，不多写！\n- 每段只含一首歌的歌名\n- 每个播报词中，歌名只能出现一次\n- 不用感叹号、不用 emoji、不用网络梗\n- 输出格式：每首歌一段连续文本（不要分两行），段与段之间用一个空行隔开。整篇输出用纯文本，不要代码块。\n\n【${songs.length}首歌曲名称列表】：\n${songList}\n',
  // Used by scripts/scene_playlist_search.js — pre-NCM-search keyword generator.
  // When the LLM is reachable, this replaces the fixed scene.keywords[] with
  // context-aware fresh terms (avoiding recent repeats).
  keyword_generator: {
    system_template: '你是网易云电台的搜索词策划。根据用户给定的场景描述、最近用过的搜索词和已选过的歌单 ID，生成 3-5 个**新**搜索词，避免重复。',
    user_template: '场景：\${sceneHint}\n日期：\${todayDate} \${weekday}\n天气：今天 \${weatherToday}，明天 \${weatherTomorrow}\n\n最近 \${historyCount} 次本场景的搜索历史（避免重复这些关键词 + 已选过的歌单）：\n\${history}\n\n要求：\n1. 输出 3-5 个**新**搜索词（中文为主，可以 1-2 个英文补充）\n2. 围绕场景「\${sceneHint}」，贴近当代生活/情绪\n3. 避免与历史关键词重复\n4. 输出格式：严格 JSON 数组，例 ["词1","词2","词3"]，不要任何解释、不要 markdown 代码块',
  },
  // Used by scripts/scene_playlist_search.js — post-NCM-search playlist selector.
  // When the LLM picks one, scene_fetch.js prefers that over score-sort[0].
  playlist_selector: {
    system_template: '你是电台 DJ。从候选歌单里选一个最契合场景描述的。如果有「最近用过的歌单」列表，必须排除它们。',
    user_template: '场景：\${sceneHint}\n日期：\${todayDate} \${weekday}\n\n候选歌单（共 \${candidateCount} 个，按播放量粗排）：\n\${candidates}\n\n最近 \${historyCount} 次本场景已选过的歌单 ID（**禁止重复**）：\n\${recentPlaylistIds}\n\n要求：\n1. 输出**仅一个**候选的 playlist_id\n2. 如果候选都不合适（场景完全对不上），输出 "SKIP"\n3. 优先选：歌单名契合场景 > 曲目数适中（30-150 首最理想，太多容易走样）> 播放量参考\n4. 输出格式：严格 JSON，例 {"playlist_id":"12345"} 或 {"playlist_id":"SKIP"}，不要任何解释、不要 markdown 代码块',
  },
  // scene_hints now holds per-scene editor config:
  //   label    — short Chinese tag fed into the LLM prompt as ${sceneHint}
  //   keywords — netease playlist search terms used by
  //              scripts/scene_playlist_search.js to find candidate
  //              playlists for this scene. Migrated from
  //              config/scenes/<scene>.json's old `keywords` field;
  //              that field is now ignored by the search script.
  scene_hints: {
    sport:  { label: '现在运动时间', keywords: ['运动', '健身', '跑步', '节奏感', '燃脂', 'Workout'] },
    morning:{ label: '早安',         keywords: ['早安', '起床', '清晨轻音乐', '晨间音乐', '早间音乐', 'Morning'] },
    night:  { label: '夜深了',       keywords: ['晚安', '助眠音乐', '深度睡眠', '睡眠音乐', '放松', 'Sleep'] },
    game:   { label: '游戏时间',     keywords: ['欢乐派对', '游戏BGM', '派对', '蹦跳', '互动游戏', 'Party'] },
    focus:  { label: '专注时刻',     keywords: ['专注', '学习', '工作BGM', '白噪音', '深度专注', 'Focus'] },
    sleep:  { label: '伴你入眠',     keywords: ['助眠音乐', '深度睡眠', '睡眠音乐', '放松', '晚安', 'Sleep'] },
  },
  // Per-song fallback line — used when the LLM batch returned an
  // invalid intro for this song (length 0, length > 80, parse fail).
  // Available placeholder: ${name}
  fallback_intro: '接下来请欣赏《${name}》',
};

function loadIntroPromptConfig() {
  try {
    const raw = fs.readFileSync(INTRO_PROMPTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so a partial file still works.
    //
    // scene_hints values can be one of:
    //   (a) new format: { label, keywords[] }   ← preferred
    //   (b) legacy format: "label string"       ← accepted, treated
    //       as { label: <string>, keywords: [] }. The scene will still
    //       feed its label into the LLM, but the search script will
    //       fall back to scenes/*.json for keywords until the admin
    //       UI saves new data through.
    //
    // Per-scene merge: take the default's keywords[] as the floor
    // when the saved config omits them, but never overwrite a
    // saved label or keywords with default values.
    const merged = {};
    const allKeys = new Set([
      ...Object.keys(INTRO_PROMPTS_DEFAULTS.scene_hints),
      ...Object.keys(parsed.scene_hints || {}),
    ]);
    for (const k of allKeys) {
      const dflt = INTRO_PROMPTS_DEFAULTS.scene_hints[k];
      const saved = parsed.scene_hints ? parsed.scene_hints[k] : undefined;
      if (typeof saved === 'string') {
        merged[k] = { label: saved, keywords: (dflt && dflt.keywords) || [] };
      } else if (saved && typeof saved === 'object') {
        merged[k] = {
          label: saved.label != null ? saved.label : (dflt && dflt.label) || k,
          keywords: Array.isArray(saved.keywords) ? saved.keywords : (dflt && dflt.keywords) || [],
        };
      } else if (dflt) {
        merged[k] = { ...dflt };
      }
    }
    return {
      system_template: parsed.system_template || INTRO_PROMPTS_DEFAULTS.system_template,
      user_template: parsed.user_template || INTRO_PROMPTS_DEFAULTS.user_template,
      scene_hints: merged,
      fallback_intro: parsed.fallback_intro || INTRO_PROMPTS_DEFAULTS.fallback_intro,
    };
  } catch (e) {
    // File missing or malformed — return defaults
    return JSON.parse(JSON.stringify(INTRO_PROMPTS_DEFAULTS));
  }
}

// Pull just the human-readable label out of scene_hints, accepting
// either the new {label, keywords} object or a legacy bare string.
// Returns the scene key as a last-resort fallback.
function getSceneLabel(sceneHints, sceneKey) {
  const v = sceneHints && sceneHints[sceneKey];
  if (v == null) return sceneKey;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.label) return v.label;
  return sceneKey;
}

// ----------------------------------------------------------------
// MiniMax Anthropic-compatible API — direct HTTPS POST, no mmx CLI.
// Mirrors the implementation in generate_playlist.js. mmx text chat
// wraps the same endpoint but mangles structured JSON output
// (strips newlines, truncates around think tags, etc) — for our
// intros-by-batch use case the raw API is much more reliable.
// ----------------------------------------------------------------


// ---------------------------------------------------------------
// Qweather 7d — only needed for ${weatherToday}/${weatherTomorrow}
// placeholders in the user template. Mirrors the host/key from
// server.js (configurable via /settings UI) but stays a self-contained copy
// because build_playlist_from_result.js is run standalone and
// importing server.js would drag in Express + Express state.
// ---------------------------------------------------------------


// Fetch weather from the local server (which has the in-memory cache
// and the city/host config). Returns the daily[] array, or null on
// any error. 5s timeout so a hung server doesn't stall the build.
function fetchWeather7d() {
  return new Promise((resolve) => {
    const req = require('http').get(`${SERVER_BASE}/api/weather`, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        log(`weather: server returned ${res.statusCode}`);
        return resolve(null);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j && Array.isArray(j.daily) && j.daily.length >= 2) {
            resolve(j.daily);
          } else {
            log('weather: response missing daily[]');
            resolve(null);
          }
        } catch (e) {
          log('weather: parse error:', e.message);
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', (e) => { log('weather: fetch error:', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); log('weather: timeout'); resolve(null); });
  });
}

// Compress one daily entry into a short Chinese weather line for
// the LLM prompt, e.g. "小雨，24~31°C". When textDay == textNight
// collapse to one label so the prompt isn't redundant.
function formatWeatherLine(day) {
  if (!day) return '';
  const label = (day.textDay && day.textDay !== day.textNight)
    ? `${day.textDay}转${day.textNight}`
    : (day.textDay || '');
  const range = (day.tempMin && day.tempMax)
    ? `${day.tempMin}~${day.tempMax}°C`
    : '';
  return [label, range].filter(Boolean).join('，');
}

// Chinese date/weekday helpers for ${todayDate} / ${weekday} template vars
// Chinese date/weekday helpers for the ${todayDate} / ${weekday} template
// vars. The 192 server runs in UTC, so we use Intl.DateTimeFormat to
// project the moment into Asia/Shanghai (UTC+8) before formatting.
// Without this, a trigger that fires at 23:00 UTC (= 07:00 next day
// Beijing) would still show the UTC date (26) instead of the Beijing
// date (27).
function getChinaDate() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}年${m}月${d}日`;
}
const WEEKDAY_NAMES_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const EN_WEEKDAY_MAP = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};
function getChinaWeekday() {
  const weekdayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'long',
  }).format(new Date());
  return WEEKDAY_NAMES_CN[EN_WEEKDAY_MAP[weekdayStr]] || WEEKDAY_NAMES_CN[0];
}

// anthropicChat now delegates to the shared helper (scripts/lib/llm_helper.js)
process.env.LLM_HELPER_TAG = 'build-llm';
const llmHelper = require('./lib/llm_helper');
async function anthropicChat(system, user, opts = {}) {
  return llmHelper.anthropicChat(system, user, {
    timeoutMs: opts.timeoutMs || opts.timeoutMs === 0 ? opts.timeoutMs : 120000,
    max_tokens: 4000,
    temperature: 0.7,
  });
}

function log(...args) { console.log(`[build-from-result ${new Date().toISOString()}]`, ...args); }

function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// ---------- mmx text chat: BATCH intro generation ----------
// Send all 20 song names + artists to the LLM at once and ask for a
// JSON array of intros back (one per song). This is dramatically
// faster than one-mmx-call-per-song (~7s × 20 = 140s vs ~10-15s for
// a single batch call) and keeps the intros stylistically consistent
// across the playlist.
//
// Returns { introMap: Map<name, introText>, prompt: string, response: string }
// Songs that the LLM skipped or returned invalid intros for are NOT
// in the map; the caller falls back to a fixed line per song.
async function generateIntrosBatch(songs, scene, promptCfg, log) {
  // Read prompt templates + scene hints from config/intro_prompts.json
  // (editable from the admin UI). The caller passes in the already-
  // loaded config so the build loop below can use the same fallback
  // line for songs the LLM skipped.
  const sceneHint = getSceneLabel(promptCfg.scene_hints, scene);

  // Compact numbered list keeps the prompt short and unambiguous
  // about which intro goes with which song.
  const songList = songs.map((s, i) =>
    `${i + 1}. 《${s.name}》 - ${s.artist || '未知'}`
  ).join('\n');

  // Fetch today's + tomorrow's weather in parallel with prompt
  // assembly. Both placeholders resolve to an empty string when
  // the API fails — the LLM prompt stays valid either way.
  const daily = await fetchWeather7d();
  const weatherToday    = daily ? formatWeatherLine(daily[0]) : '';
  const weatherTomorrow = daily ? formatWeatherLine(daily[1]) : '';
  const todayDate       = getChinaDate();
  const weekday         = getChinaWeekday();
  if (!daily) log('  weather fetch failed — placeholders will be empty');

  const systemPrompt = promptCfg.system_template
    .replace(/\$\{sceneHint\}/g, sceneHint);
  const firstSongName = (songs[0] && songs[0].name) || '';
  const lastSongName  = (songs[songs.length - 1] && songs[songs.length - 1].name) || '';
  const userPrompt = promptCfg.user_template
    .replace(/\$\{sceneHint\}/g, sceneHint)
    .replace(/\$\{songs\.length - 1\}/g, String(songs.length - 1))
    .replace(/\$\{songs\.length\}/g, String(songs.length))
    .replace(/\$\{songs\[0\]\.name\}/g, firstSongName)
    .replace(/\$\{songs\[songs\.length - 1\]\.name\}/g, lastSongName)
    .replace(/\$\{songList\}/g, songList)
    .replace(/\$\{weatherToday\}/g, weatherToday)
    .replace(/\$\{weatherTomorrow\}/g, weatherTomorrow)
    .replace(/\$\{todayDate\}/g, todayDate)
    .replace(/\$\{weekday\}/g, weekday);

  try {
    // Direct HTTPS POST to the Anthropic-compatible endpoint. We
    // intentionally bypass `mmx text chat` here: mmx strips newlines,
    // wraps output, and once dropped our 19-intro JSON payload to 0
    // bytes (probably from over-aggressive truncation around the
    // model's own  tags). The raw API gives us clean JSON.
    const text = await anthropicChat(systemPrompt, userPrompt, 90000);
    // For the admin UI: surface the *actual* HTTP body we sent to
    // MiniMax, so operators can see exactly what went over the wire
    // (Anthropic-compatible format with `system` and `messages[]`).
    const anthropicHttpRequest = JSON.stringify({
      url: LLM_BASE,
      headers: LLM_PROVIDER === 'deepseek' ? {
        authorization: 'Bearer <redacted>',
        'content-type': 'application/json',
      } : {
        'x-api-key': '<redacted>',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: LLM_PROVIDER === 'deepseek' ? {
        model: LLM_MODEL,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      } : {
        model: LLM_MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
    }, null, 2);
    if (!text) {
      log('  anthropic returned null');
      return { introMap: new Map(), prompt: userPrompt, response: '', httpRequest: anthropicHttpRequest };
    }
    // Persist the response for the admin UI's LLM detail panel
    // before stripping — operators may want to see the raw reasoning.
    const raw = text;
    // Strip chain-of-thought leaks + markdown fences before parsing.
    let clean = raw
      .replace(/<\s*think[\s\S]*?<\s*\/\s*think\s*>/g, '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '');
    clean = clean.trim();
    // Try parse JSON first
    let parsed = null;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      // Fallback: the new prompt asks for paragraph-format output
      // (each song's intro is a paragraph separated by blank lines).
      // We split on blank lines, attribute each paragraph to the
      // corresponding song by position, and wrap as [{name, intro}].
      log(`  LLM JSON parse failed: ${parseErr.message.slice(0, 100)} — trying paragraph fallback`);
      const paragraphs = clean.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      // Skip a leading intro/instruction paragraph if it doesn't start with 《
      // Smart strategy: for each song, find the paragraph that contains its
      // name. If count doesn't match, try to attribute by song name lookup.
      const targetCount = songs.length;
      let useParas = null;

      // Strategy 1: exact match (paragraph count == song count)
      if (paragraphs.length === targetCount) {
        useParas = paragraphs;
      }
      // Strategy 2: count is songs + N, drop first N non-song paragraphs
      else if (paragraphs.length >= targetCount) {
        // For each song, find the first unused paragraph containing the song
        // name. Try patterns in this order:
        //   (a) «name» (preferred — LLM was told to use 《》 wrappers)
        //   (b) bare name anywhere in the paragraph (handles names with nested 《》)
        const matched = [];
        const usedIdx = new Set();
        for (const song of songs) {
          const escName = song.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const patWrap = new RegExp('《\\s*' + escName + '\\s*》');
          const patBare = new RegExp(escName);
          let found = -1;
          // (a) prefer wrapped match
          for (let i = 0; i < paragraphs.length; i++) {
            if (usedIdx.has(i)) continue;
            if (patWrap.test(paragraphs[i])) { found = i; break; }
          }
          // (b) fall back to bare name
          if (found < 0) {
            for (let i = 0; i < paragraphs.length; i++) {
              if (usedIdx.has(i)) continue;
              if (patBare.test(paragraphs[i])) { found = i; break; }
            }
          }
          if (found >= 0) {
            matched.push(paragraphs[found]);
            usedIdx.add(found);
          } else {
            matched.push(null);
          }
        }
        if (matched.filter(Boolean).length === targetCount) {
          log('  paragraph fallback: song-name attribution succeeded');
          useParas = matched;
        } else {
          log(`  paragraph fallback: attribution got ${matched.filter(Boolean).length}/${targetCount}`);
          // Strategy 3: for each missing song, try the longest distinctive
          // token from the name as a fingerprint
          for (let i = 0; i < matched.length; i++) {
            if (matched[i] !== null) continue;
            const song = songs[i];
            const stripped = song.name.replace(/[《》「」『」"]/g, '');
            const tokens = stripped.split(/[\s\-_()\[\]（）【】]/).filter(t => t.length >= 3);
            if (tokens.length === 0) continue;
            const fp = tokens.sort((a, b) => b.length - a.length)[0];
            for (let j = 0; j < paragraphs.length; j++) {
              if (usedIdx.has(j)) continue;
              if (paragraphs[j].includes(fp)) {
                matched[i] = paragraphs[j];
                usedIdx.add(j);
                log(`  Strategy 3 recovered song ${i+1} via token "${fp}" in paragraph ${j}`);
                break;
              }
            }
          }
          if (matched.filter(Boolean).length === targetCount) {
            log('  paragraph fallback: Strategy 3 (token match) succeeded');
            useParas = matched;
          }
        }
            }
      if (useParas) {
        parsed = useParas.map((p, i) => {
          if (p == null) {
            return { name: songs[i].name, intro: promptCfg.fallback_intro.replace('${name}', songs[i].name) };
          }
          // Strip leading numbered prefixes (e.g. "1. ", "1、")
          let cleaned = p
          .replace(/^\s*【[^】]+】\s*/, '')
          .replace(/^\s*第\s*\d+\s*首[：:\s]*/, '')
          .replace(/^\s*\d+[\.\u3001\u3002)\u3010]\s*/, '')
          .trim();
          // Glue song name back if model split it: '《song》\nrest'
          const splitMatch = cleaned.match(/^(《[^》]+》)\s*\n\s*(.+)$/s);
          if (splitMatch) cleaned = splitMatch[1] + splitMatch[2];
          return { name: songs[i].name, intro: cleaned };
        });
        log(`  paragraph fallback succeeded: ${parsed.length} intros`);
      } else {
        log(`  paragraph fallback failed: ${paragraphs.length} paragraphs vs ${songs.length} songs (could not align)`);
        log(`  raw text: ${clean.slice(0, 200)}`);
        return { introMap: new Map(), prompt: userPrompt, response: raw, httpRequest: anthropicHttpRequest };
      }
    }
    if (!Array.isArray(parsed)) {
      log('  LLM returned non-array');
      return { introMap: new Map(), prompt: userPrompt, response: raw, httpRequest: anthropicHttpRequest };
    }
    const out = new Map();
    for (let i = 0; i < songs.length && i < parsed.length; i++) {
      const item = parsed[i];
      const name = songs[i].name;
      // Accept either a structured object {name, intro} (the format
      // we ask for in the system prompt) or a bare string intro.
      // The latter happens when the operator has edited the system
      // prompt to a looser form like "just write a broadcast line
      // per song" — we still want to attribute the intro to the
      // right song, so the song's position in the input list
      // determines the pairing.
      let intro;
      if (typeof item === 'string') {
        intro = item.trim();
      } else if (item && typeof item === 'object') {
        // Accept any of {intro, text, announcement} — `announcement`
        // is what current user templates tend to ask for, since
        // "intro" sounded too narrow when prompts allow up to 200-char
        // first-song commentaries.
        intro = (item.intro || item.announcement || item.text || '').toString().trim();
      } else {
        continue;
      }
      intro = intro.replace(/^["「']|["」']$/g, '');
      // Length window was 4-80 but the night/morning prompts ask the
      // LLM for a 100-200 char first-song commentary and 30-50 chars
      // for the rest. Cap at 250 (allows for natural drift above 200)
      // and floor at 4 (still rejects empty / 1-char responses).
      if (intro.length >= 4 && intro.length <= 250) {
        out.set(name, intro);
      } else {
        log(`  intro rejected for "${name}" (len=${intro.length}): ${intro.slice(0, 30)}`);
      }
    }
    return { introMap: out, prompt: userPrompt, response: raw, httpRequest: anthropicHttpRequest };
  } catch (e) {
    log(`  batch anthropic chat failed: ${e.message.slice(0, 200)}`);
    return { introMap: new Map(), prompt: '', response: '', httpRequest: anthropicHttpRequest };
  }
}
// ----------------------------------------------------------------
// MiniMax TTS HTTP API — direct POST, no mmx CLI.
// Docs: https://api.minimaxi.com/v1/t2a_v2
// The response is a JSON envelope {"data": {"audio": "<hex>"}, ...}
// where `audio` is hex-encoded MP3 bytes (16kHz mono by default).
// ----------------------------------------------------------------


async function ttsApi(text, outPath, timeoutMs = 30000) {
  if (!ANTHROPIC_KEY) {
    // Reuse the same key (the TTS API authenticates with the same
    // minimax bearer token; ANTHROPIC_KEY is misleadingly named).
    log('tts: no API key found in ~/.mmx/config.json');
    return false;
  }
  try {
    const body = JSON.stringify({
      model: TTS_MODEL,
      text,
      stream: false,
      voice_setting: {
        voice_id: TTS_VOICE_ID,
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    });
    const result = await new Promise((resolve, reject) => {
      const url = new URL(TTS_BASE);
      const req = require('https').request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'authorization': `Bearer ${ANTHROPIC_KEY}`,
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
            if (data.base_resp && data.base_resp.status_code !== 0) {
              reject(new Error(`tts ${data.base_resp.status_code}: ${data.base_resp.status_msg}`));
            } else {
              resolve(data);
            }
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    // MiniMax TTS v2 returns hex-encoded audio in data.audio
    const audioHex = result?.data?.audio;
    if (!audioHex) {
      log('  tts: empty audio in response');
      return false;
    }
    const audioBuf = Buffer.from(audioHex, 'hex');
    fs.writeFileSync(outPath, audioBuf);
    return fs.statSync(outPath).size > 1000;
  } catch (e) {
    log('tts failed:', e.message.slice(0, 200));
    return false;
  }
}

// Transcode a downloaded NCM song to the same parameters as the TTS
// intro (128kbps 44100Hz stereo), so the stitched file has consistent
// encoding throughout. Without this, the ESP32 decoder may fail at the
// transition point when the song has different bitrate/sample-rate/channel
// (common: 320kbps 48kHz mono from NCM vs 128kbps 44.1kHz stereo intro).
async function normalizeSongToMatchIntro(srcPath, dstPath) {
  const tmpWav = srcPath + '.norm.wav';
  try {
    const env = Object.assign({}, process.env, {
      LD_LIBRARY_PATH: LAME_LIB_DIR + ':' + (process.env.LD_LIBRARY_PATH || ''),
    });
    log(`    normalizing song → 128kbps 44.1kHz stereo…`);
    // Decode to PCM, then re-encode with LAME -m s (forced stereo).
    // LAME handles mono→stereo internally, so no separate mono2stereo
    // step is needed — and this avoids the "Input is not mono" error
    // on songs that are already stereo.
    await execAsync(`${LAME_BIN} --decode ${JSON.stringify(srcPath)} ${JSON.stringify(tmpWav)}`, { env, timeout: 60000 });
    await execAsync(`${LAME_BIN} -b 128 -m s --resample 44.1 ${JSON.stringify(tmpWav)} ${JSON.stringify(dstPath)}`, { env, timeout: 60000 });
    return fs.existsSync(dstPath) && fs.statSync(dstPath).size > 1000;
  } catch (e) {
    log('    song normalize failed:', e.message.slice(0, 200));
    return false;
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

async function transcodeToStereo(srcPath, dstPath) {
  const tmpWav = srcPath + '.wav';
  const tmpStereo = srcPath + '.st.wav';
  try {
    const env = Object.assign({}, process.env, {
      LD_LIBRARY_PATH: LAME_LIB_DIR + ':' + (process.env.LD_LIBRARY_PATH || ''),
    });
    await execAsync(`${LAME_BIN} --decode ${JSON.stringify(srcPath)} ${JSON.stringify(tmpWav)}`, { env, timeout: 30000 });
    await execAsync(`node ${JSON.stringify(MONO2STEREO_PATH)} ${JSON.stringify(tmpWav)} ${JSON.stringify(tmpStereo)}`, { timeout: 15000 });
    await execAsync(`${LAME_BIN} -b 128 -m s --resample 44.1 --scale ${TTS_GAIN} ${JSON.stringify(tmpStereo)} ${JSON.stringify(dstPath)}`, { env, timeout: 30000 });
    return fs.existsSync(dstPath) && fs.statSync(dstPath).size > 1000;
  } catch (e) {
    log('  transcode failed:', e.message.slice(0, 200));
    return false;
  } finally {
    [tmpWav, tmpStereo].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

// ---------- main ----------
// Report build progress back to the admin panel. We mutate the same
// queue_state.json that scene_fetch wrote, so the admin UI can see a
// continuous progress bar across the whole trigger→play pipeline.
//
// `stateFile` is read from process.env.DJ_PROGRESS_FILE when called
// from dj_worker (preferred), or falls back to the default path when
// run standalone. Defined at module level so buildOneSong can call it
// without a circular dependency back through main().
const STATE_FILE_DEFAULT = path.join(PLAYLIST_ROOT, 'queue_state.json');
// Persist full prompt + raw response + parsed intros to:
//   1) queue_state.progress.llm  (live view, used while build is running)
//   2) .radio_playlist/llm_history.jsonl  (append-only history so the
//      admin UI can show the LAST 10 LLM calls even after the state
//      file is overwritten by a subsequent trigger)
function reportBuildProgress(progress) {
  const stateFile = process.env.DJ_PROGRESS_FILE || STATE_FILE_DEFAULT;
  if (!stateFile) return;
  try {
    let cur = {};
    if (fs.existsSync(stateFile)) {
      cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    cur.progress = Object.assign({}, cur.progress || {}, progress);
    // IMPORTANT: fields like `llm` (the batch intros prompt/response)
    // are written ONCE at the start of the build but persist across
    // every subsequent per-song tick. Re-spread them so they aren't
    // wiped out when a later tick sends a partial progress object.
    if (progress.llm) {
      cur.progress.llm = progress.llm;
      // Mirror to the persistent llm_history.jsonl so the admin UI
      // can show previous LLM calls after queue_state has been
      // overwritten by a later scene-fetch / build cycle.
      try {
        const historyFile = path.join(PLAYLIST_ROOT, 'llm_history.jsonl');
        // Strip the parsed Map (Object.fromEntries was used in main;
        // we re-strip here just to be safe) — only persist prompt +
        // response + a flat summary, not the full 20-entry map.
        const entry = {
          ts: new Date().toISOString(),
          scene: progress.scene || (cur.result && cur.result.scene) || 'unknown',
          playlist_name: (cur.result && cur.result.playlist_name) || null,
          requested: progress.llm.requested,
          succeeded: progress.llm.succeeded,
          duration_ms: progress.llm.duration_ms,
          system: progress.llm.system || null,
          prompt: progress.llm.prompt,
          response: progress.llm.response,
          http_request: progress.llm.http_request || null,
          // Scene-fetch context — copied from progress so the admin
          // UI can show the full trigger context (keywords, NCM
          // candidates, chosen playlist + song list) alongside the
          // LLM call in a single history entry.
          keywords: (cur.progress && cur.progress.keywords) || null,
          candidates: (cur.progress && cur.progress.candidates) || null,
          chosen_playlist: (cur.progress && cur.progress.chosen_playlist) || null,
          skipped_used: (cur.progress && cur.progress.skipped_used) || null,
          songs: (cur.progress && cur.progress.songs) || null,
        };
        fs.appendFileSync(historyFile, JSON.stringify(entry) + '\n');
      } catch (e) {
        log('llm_history append failed:', e.message.slice(0, 100));
      }
    }
    cur.state = 'running';
    cur.batch = cur.batch || 'manual';
    cur.updated_at = new Date().toISOString();
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    log('reportBuildProgress failed:', e.message.slice(0, 100));
  }
}

// Build a single song (TTS + transcode + stitch + push to playlist).
// Intro text comes pre-baked from generateIntrosBatch() — we don't
// ask the LLM per song anymore. Throws on hard failure; caller
// catches & counts.
async function buildOneSong(song, idx, total, scene, stamp, introsDir, playlist, introText) {
  const name = song.name;
  const introFile = path.join(introsDir, `${idx}.mp3`);
  const ttsRaw = path.join(introsDir, `${idx}.raw.mp3`);
  const stitchedFile = path.join(introsDir, `${idx}.stitched.mp3`);

  log(`[${idx}/${total}] ${name}`);
  log(`  intro: "${introText}"`);

  const songPath = song.filePath;
  if (!songPath || !fs.existsSync(songPath)) {
    throw new Error(`song file missing: ${songPath}`);
  }

  if (!TTS_ENABLED) {
    const sizeKb = Math.round(fs.statSync(songPath).size / 1024);
    const trackName = path.basename(songPath, path.extname(songPath));
    const trackUrl = `/audio/local/track/${encodeURIComponent(trackName)}`;
    log(`  ✓ TTS disabled, using original track (${sizeKb} KB)`);
    playlist.push({
      index: idx,
      name,
      intro_text: '',
      intro_file: null,
      intro_url: null,
      track_url: trackUrl,
      stitched_url: trackUrl,
      size_kb: sizeKb,
    });
    return;
  }

  const ttsOk = await ttsApi(introText, ttsRaw);
  if (!ttsOk) throw new Error('tts failed');

  const stereoOk = await transcodeToStereo(ttsRaw, introFile);
  try { fs.unlinkSync(ttsRaw); } catch {}
  if (!stereoOk) throw new Error('transcode failed');

  // Normalize the song to match the intro's encoding (128kbps 44.1kHz
  // stereo). Direct concatenation of differently-encoded MP3s causes
  // ESP32 decoder sync loss at the transition point when parameters
  // differ (NCM CDN serves 320kbps 48kHz mono; the intro is 128kbps
  // 44.1kHz dual-channel from LAME).
  const songNormalized = path.join(introsDir, `${idx}.song.mp3`);
  const songOk = await normalizeSongToMatchIntro(songPath, songNormalized);
  if (!songOk) throw new Error('song normalize failed');

  const introBuf = fs.readFileSync(introFile);
  const songBuf = fs.readFileSync(songNormalized);
  fs.writeFileSync(stitchedFile, Buffer.concat([introBuf, songBuf]));
  try { fs.unlinkSync(songNormalized); } catch {}
  const sizeKb = Math.round(fs.statSync(stitchedFile).size / 1024);
  log(`  ✓ stitched (${sizeKb} KB)`);

  playlist.push({
    index: idx,
    name,
    intro_text: introText,
    intro_file: `intros/${idx}.mp3`,
    intro_url: `/audio/playlist-intro/${stamp}/${idx}.mp3`,
    track_url: `/audio/local/track/${encodeURIComponent(path.basename(songPath, path.extname(songPath)))}`,
    stitched_url: `/audio/playlist-stitched/${stamp}/${idx}.mp3`,
    size_kb: sizeKb,
  });
}

async function main() {
  const STATE_FILE = process.env.DJ_PROGRESS_FILE || path.join(PLAYLIST_ROOT, 'queue_state.json');
  if (!fs.existsSync(STATE_FILE)) {
    log('no queue_state.json — nothing to do');
    process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const result = state.result || {};
  let songs = result.songs || [];
  if (!songs.length) {
    log('result.songs is empty — scene_fetch did not record any songs (was it run after this script landed?)');
    process.exit(0);
  }
  // Hard cap at 20. The follow-up pipeline (TTS + transcode + stitch)
  // takes ~7s per song, so 20 ≈ 2.5min — acceptable latency between
  // trigger and playback. Larger playlists are filler.
  const PLAYLIST_SONG_CAP = 20;
  if (songs.length > PLAYLIST_SONG_CAP) {
    log(`capping songs from ${songs.length} → ${PLAYLIST_SONG_CAP}`);
    songs = songs.slice(0, PLAYLIST_SONG_CAP);
  }
  const scene = result.scene || state.scene || 'unknown';
  const playlistName = result.playlist_name || 'scene-fetch';
  log(`building playlist for scene="${scene}", playlist="${playlistName}", ${songs.length} songs`);

  // Load the editable prompt config (system / user template / scene
  // hints / fallback line) once for this build. The same object is
  // passed into generateIntrosBatch (so the LLM uses the configured
  // system + user prompts) and read in the build loop below (so the
  // fallback line is consistent with the prompt the LLM was shown).
  const promptCfg = loadIntroPromptConfig();
  const sceneHint = getSceneLabel(promptCfg.scene_hints, scene);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13); // YYYYMMDDHHMM
  const playlistDir = path.join(PLAYLIST_ROOT, stamp);
  const introsDir = path.join(playlistDir, 'intros');
  fs.mkdirSync(introsDir, { recursive: true });

  const playlist = [];
  let failed = 0;

  // Initial build-progress write so the admin UI moves from "下歌 20/20"
  // to a new "拼接" phase immediately after the download finishes.
  reportBuildProgress({
    phase: 'stitching',
    total: songs.length,
    current: 0,
    succeeded: 0,
    failed: 0,
    current_song: '',
    sub_phase: 'llm_batch',
    scene,
    playlist_id: result.playlist_id,
    playlist_name: playlistName,
    started_at: new Date().toISOString(),
  });

  // Batch-call the LLM ONCE with all song names, get back intros for
  // every song in one shot. ~10-15s instead of 20 × 7s = 140s.
  log(TTS_ENABLED
    ? `[llm-batch] asking LLM for ${songs.length} intros in one call…`
    : '[llm-batch] TTS disabled — skipping intro generation');
  const llmStart = Date.now();
  const { introMap, prompt, response, httpRequest } = TTS_ENABLED
    ? await generateIntrosBatch(songs, scene, promptCfg, log)
    : { introMap: new Map(), prompt: '', response: '', httpRequest: '' };
  const llmMs = Date.now() - llmStart;
  log(`[llm-batch] got ${introMap.size}/${songs.length} intros from LLM (${llmMs}ms)`);
  // Persist full prompt + raw response + parsed intros to queue_state
  // so the admin UI can show them after the run.
  reportBuildProgress({
    phase: 'stitching',
    total: songs.length,
    current: 0,
    succeeded: 0,
    failed: 0,
    current_song: '',
    sub_phase: 'llm_batch',
    llm: {
      system: promptCfg.system_template.replace(/\$\{sceneHint\}/g, sceneHint),
      prompt,
      response,
      http_request: httpRequest,
      parsed: Object.fromEntries(introMap),
      duration_ms: llmMs,
      requested: songs.length,
      succeeded: introMap.size,
    },
  });

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const idx = i + 1;
    // Look up intro from the batch map; fall back to a fixed line
    // when the LLM skipped this song.
    const introText = introMap.get(song.name)
      || promptCfg.fallback_intro.replace(/\$\{name\}/g, song.name);

    // Top-level per-song try/catch so a single TTS / transcode / stitch
    // failure (or missing mp3 on disk) doesn't kill the entire build.
    // Failures are reported and skipped; the rest of the playlist still
    // gets stitched. We also report progress so a stuck mmx call is
    // visible in the worker log.
    // Pre-stitch progress tick — covers the TTS + transcode window
    // where otherwise the bar looks frozen.
    reportBuildProgress({
      phase: 'stitching',
      total: songs.length,
      current: idx - 1,
      succeeded: playlist.length,
      failed,
      current_song: song.name,
      intro_text: introText,
      sub_phase: TTS_ENABLED ? 'tts_transcode' : 'track_only',
    });
    try {
      await buildOneSong(song, idx, songs.length, scene, stamp, introsDir, playlist, introText);
    } catch (e) {
      log(`  ✗ song ${idx} (${song.name}) failed: ${e.message?.slice(0, 200) || e}`);
      failed++;
    }
    // Post-stitch tick so the bar advances and stats refresh.
    const lastSucceeded = playlist[playlist.length - 1];
    reportBuildProgress({
      phase: 'stitching',
      total: songs.length,
      current: idx,
      succeeded: playlist.length,
      failed,
      current_song: song.name,
      intro_text: introText,
      sub_phase: 'stitched',
      last_size_kb: lastSucceeded ? Math.round(lastSucceeded.size_kb || 0) : 0,
    });
  }

  // Always save progress so the admin UI can see partial builds. We do
  // this even on failure (no stitched mp3) so the next run can resume
  // or the admin can show "5/20 succeeded".
  try {
    fs.writeFileSync(
      path.join(playlistDir, 'progress.json'),
      JSON.stringify({ generated_at: new Date().toISOString(), total: songs.length, succeeded: playlist.length, failed }, null, 2)
    );
  } catch {}

  if (playlist.length === 0) {
    log('No songs succeeded — aborting (leaving current.json untouched)');
    process.exit(1);
  }

  // Write playlist.json + symlink
  const playlistData = {
    generated_at: new Date().toISOString(),
    valid_until: new Date(Date.now() + 14 * 3600 * 1000).toISOString(),
    weather: 'n/a',
    time_of_day: scene,
    hour: new Date().getHours(),
    persona: null,
    // Top-level name so /api/esp can return it without reaching into
    // source_playlist. Falls back to NCM playlist name → "scene-<scene>"
    // for older builds / generate_playlist path.
    name: playlistName,
    playlist_name: playlistName,
    source_playlist: { id: result.playlist_id, name: playlistName, scene },
    songs: playlist,
    current_index: 0,
    stats: { requested: songs.length, succeeded: playlist.length, failed },
  };
  const finalPlaylistJson = path.join(playlistDir, 'playlist.json');
  fs.writeFileSync(finalPlaylistJson, JSON.stringify(playlistData, null, 2));
  log(`wrote playlist.json: ${playlist.length}/${songs.length} ok, ${failed} failed`);

  // Atomic swap: current.json (which is a symlink or a real file) →
  // the new playlist.json. Unlink first to handle both cases.
  for (const name of ['current.json']) {
    const p = path.join(PLAYLIST_ROOT, name);
    try { fs.unlinkSync(p); } catch {}
  }
  fs.symlinkSync(finalPlaylistJson, path.join(PLAYLIST_ROOT, 'current.json'));
  log(`symlinked current.json → ${stamp}/playlist.json`);

  // Update state to reflect playlist build
  state.playlist_built_at = new Date().toISOString();
  state.playlist_path = `${stamp}/playlist.json`;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);

  log(`done — ${playlist.length} songs ready, valid_until=${playlistData.valid_until}`);
}

main().catch(e => {
  console.error('[build-from-result] UNCAUGHT:', e.stack || e.message);
  process.exit(1);
});
