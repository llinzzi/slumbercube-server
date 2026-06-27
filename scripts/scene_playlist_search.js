#!/usr/bin/env node
/**
 * scene_playlist_search.js
 *
 * Search netease for fresh playlists matching a scene's keywords.
 * Filters out playlists already adopted (cross-scene dedup).
 *
 * Keyword source (priority order):
 *   1. config/intro_prompts.json → scene_hints.<scene>.keywords[]
 *      (preferred — edited from the admin UI, kept in one place
 *      with the LLM prompt label)
 *   2. config/scenes/<scene>.json → keywords[]  (legacy fallback,
 *      kept for old configs that haven't been re-saved through the UI)
 *
 * Usage:
 *   node scripts/scene_playlist_search.js <scene_name>
 *   node scripts/scene_playlist_search.js morning
 *   node scripts/scene_playlist_search.js --all
 *
 * Outputs JSON to stdout:
 *   { scene, candidates: [{id, name, creator, playCount, score, matched_keyword}], total_skipped, keywords_source }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const llmHelper = require('./lib/llm_helper');

const NETEASE_API = process.env.NETEASE_API || 'http://localhost:3001';
const PROJECT_ROOT = path.join(__dirname, '..');
const SCENES_DIR = path.join(PROJECT_ROOT, 'config', 'scenes');
const INTRO_PROMPTS_PATH = path.join(PROJECT_ROOT, 'config', 'intro_prompts.json');
const HISTORY_DIR = path.join(PROJECT_ROOT, 'data', 'history_playlists');

// Pull keywords for a scene from the unified prompt config first,
// falling back to scenes/*.json if not present. Records the source
// so the caller can log / display where the words came from.
function loadSceneKeywords(sceneName) {
  // Try intro_prompts.json (preferred)
  try {
    const cfg = JSON.parse(fs.readFileSync(INTRO_PROMPTS_PATH, 'utf8'));
    const v = cfg && cfg.scene_hints && cfg.scene_hints[sceneName];
    if (v && typeof v === 'object' && Array.isArray(v.keywords) && v.keywords.length > 0) {
      return { keywords: v.keywords, source: 'intro_prompts.json' };
    }
    // Legacy bare-string scene_hint value: no keywords, treat as empty.
  } catch (_) { /* file missing or malformed — fall through */ }
  // Fallback: scenes/*.json (legacy)
  const fp = path.join(SCENES_DIR, `${sceneName}.json`);
  if (fs.existsSync(fp)) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (Array.isArray(j.keywords) && j.keywords.length > 0) {
        return { keywords: j.keywords, source: fp };
      }
    } catch (_) { /* fall through */ }
  }
  return { keywords: [], source: null };
}

function loadSceneMeta(sceneName) {
  // Keep the old loader too in case other callers (scene_fetch) need
  // other fields from scenes/*.json. Returns {} if not present.
  const fp = path.join(SCENES_DIR, `${sceneName}.json`);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { return {}; }
}

// ---------------------------------------------------------------
// LLM-driven keyword generation + playlist selection
// ---------------------------------------------------------------
// Both functions are designed to fail gracefully — they return null
// on any error, and the caller falls back to fixed keywords + score-sort.

// loadSceneHistory(sceneName, limit): read the last N audit entries
// from data/scene_audit/<scene>.jsonl and compact them to a short
// one-line-per-entry summary suitable for an LLM prompt.
const SCENE_AUDIT_DIR = path.join(PROJECT_ROOT, 'data', 'scene_audit');
function loadSceneHistory(sceneName, limit = 8) {
  const fp = path.join(SCENE_AUDIT_DIR, `${sceneName}.jsonl`);
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim());
  const tail = lines.slice(-limit);
  const out = [];
  for (const line of tail) {
    try {
      const e = JSON.parse(line);
      // Compact: only fields the LLM needs to avoid repetition
      const date = (e.ts || '').slice(0, 10);
      const kws = (e.queried_keywords || []).slice(0, 6).join(',');
      const ch = e.chosen ? `${e.chosen.playlist_id}|${e.chosen.name}|${e.chosen.matched_keyword || ''}` : '-';
      out.push(`${date} | outcome=${e.outcome || '?'} | kws=[${kws}] | chosen=${ch}`);
    } catch { /* skip malformed */ }
  }
  return out;
}

// getSceneHintLabel(sceneName): pull the human-readable scene label
// from intro_prompts.json (the same value that ${sceneHint} resolves to
// for the LLM-batch intros).
function getSceneHintLabel(sceneName) {
  try {
    const cfg = JSON.parse(fs.readFileSync(INTRO_PROMPTS_PATH, 'utf8'));
    const v = cfg && cfg.scene_hints && cfg.scene_hints[sceneName];
    if (v && typeof v === 'object') return v.label || sceneName;
    if (typeof v === 'string') return v;
  } catch {}
  return sceneName;
}

// getPromptConfig(): load keyword_generator + playlist_selector templates
// (returns {} if missing — caller decides whether to use LLM at all).
function getPromptConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(INTRO_PROMPTS_PATH, 'utf8'));
    return {
      keyword: cfg.keyword_generator || null,
      selector: cfg.playlist_selector || null,
    };
  } catch { return { keyword: null, selector: null }; }
}

// generateKeywordsWithLLM(): ask the LLM for fresh search terms based on
// scene + date + weather + recent history. Returns string[] or null.
async function generateKeywordsWithLLM({ sceneName, weatherToday, weatherTomorrow }) {
  const cfg = getPromptConfig().keyword;
  if (!cfg || !cfg.system_template || !cfg.user_template) return null;
  const sceneHint = getSceneHintLabel(sceneName);
  const history = loadSceneHistory(sceneName, 8);
  const historyStr = history.length ? history.join('\n') : '(无历史)';
  const todayDate = getChinaDate();
  const weekday = getChinaWeekday();
  const user = cfg.user_template
    .replace(/\$\{sceneHint\}/g, sceneHint)
    .replace(/\$\{todayDate\}/g, todayDate)
    .replace(/\$\{weekday\}/g, weekday)
    .replace(/\$\{weatherToday\}/g, weatherToday || '未知')
    .replace(/\$\{weatherTomorrow\}/g, weatherTomorrow || '未知')
    .replace(/\$\{history\}/g, historyStr)
    .replace(/\$\{historyCount\}/g, String(history.length));
  console.log(`[${sceneName}] llm-keywords: requesting...`);
  const text = await llmHelper.anthropicChat(cfg.system_template, user, { max_tokens: 256, temperature: 0.8 });
  if (!text) return null;
  // Try to parse JSON array
  const cleaned = text.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr) && arr.every(x => typeof x === 'string') && arr.length > 0) {
      console.log(`[${sceneName}] llm-keywords: got ${arr.length} →`, arr);
      return arr.slice(0, 5);
    }
  } catch (e) {
    console.log(`[${sceneName}] llm-keywords: parse fail (${e.message.slice(0, 80)}), text=${text.slice(0, 100)}`);
  }
  return null;
}

// selectPlaylistWithLLM(): given the top-N candidates, ask the LLM
// which one to pick. Returns playlist_id string (or null on failure / SKIP).
async function selectPlaylistWithLLM({ sceneName, candidates, weatherToday, weatherTomorrow }) {
  const cfg = getPromptConfig().selector;
  if (!cfg || !cfg.system_template || !cfg.user_template) return null;
  if (!candidates || candidates.length === 0) return null;
  const sceneHint = getSceneHintLabel(sceneName);
  // Compact candidates for the prompt (top 8)
  const top = candidates.slice(0, 8);
  const candStr = top.map((c, i) => {
    const tracks = c.track_count || '?';
    const plays = c.play_count >= 10000 ? `${(c.play_count / 10000).toFixed(0)}万` : String(c.play_count || 0);
    return `${i + 1}. id=${c.id} | name=${c.name} | tracks=${tracks} | plays=${plays}`;
  }).join('\n');
  // Recent chosen playlist IDs (avoid picking the same one)
  const recent = loadSceneHistory(sceneName, 5);
  const recentIds = recent.map(l => {
    const m = l.match(/chosen=\d+\|([^|]+)/);
    return m ? m[1] : null;
  }).filter(Boolean).slice(0, 5);
  const recentIdsStr = recentIds.length ? recentIds.join(', ') : '(无)';
  const todayDate = getChinaDate();
  const weekday = getChinaWeekday();
  const user = cfg.user_template
    .replace(/\$\{sceneHint\}/g, sceneHint)
    .replace(/\$\{todayDate\}/g, todayDate)
    .replace(/\$\{weekday\}/g, weekday)
    .replace(/\$\{weatherToday\}/g, weatherToday || '未知')
    .replace(/\$\{weatherTomorrow\}/g, weatherTomorrow || '未知')
    .replace(/\$\{candidates\}/g, candStr)
    .replace(/\$\{candidateCount\}/g, String(top.length))
    .replace(/\$\{recentPlaylistIds\}/g, recentIdsStr)
    .replace(/\$\{historyCount\}/g, String(recent.length));
  console.log(`[${sceneName}] llm-select: requesting...`);
  const text = await llmHelper.anthropicChat(cfg.system_template, user, { max_tokens: 256, temperature: 0.3 });
  if (!text) return null;
  const cleaned = text.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
  // Try JSON object form first: {"playlist_id":"123"} or {"playlist_id":"SKIP"}
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.playlist_id === 'string') {
      const id = obj.playlist_id.trim();
      if (id === 'SKIP') { console.log(`[${sceneName}] llm-select: SKIP`); return 'SKIP'; }
      console.log(`[${sceneName}] llm-select: chose id=${id}`);
      return id;
    }
  } catch {}
  // Try bare number (just the id)
  const m = cleaned.match(/^"?(\d+)"?$/);
  if (m) {
    console.log(`[${sceneName}] llm-select: bare id ${m[1]}`);
    return m[1];
  }
  console.log(`[${sceneName}] llm-select: parse fail, text=${cleaned.slice(0, 100)}`);
  return null;
}

// Chinese date/weekday helpers (mirrored from build_playlist for parity).
// Use Asia/Shanghai (UTC+8) instead of the process's local timezone —
// 192 is UTC, so without this a morning trigger at 23:00 UTC
// (= 07:00 next day Beijing) would still show the UTC date.
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
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'long',
  }).format(new Date());
  return WEEKDAY_NAMES_CN[EN_WEEKDAY_MAP[wd]] || WEEKDAY_NAMES_CN[0];
}

/** Collect all playlist ids ever adopted, across all scenes. */
function loadAllUsedPlaylistIds() {
  const ids = new Set();
  if (!fs.existsSync(HISTORY_DIR)) return ids;
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
      for (const pl of arr) ids.add(String(pl.playlist_id));
    } catch (e) { /* ignore malformed */ }
  }
  return ids;
}

/** NCM search via sidecar. Returns array of playlist objects. */
function searchPlaylists(keyword, limit = 10) {
  return new Promise((resolve, reject) => {
    const url = new URL('/search', NETEASE_API);
    url.searchParams.set('keywords', keyword);
    url.searchParams.set('type', '1000');
    url.searchParams.set('limit', String(limit));

    const lib = url.protocol === 'https:' ? https : require('http');
    const req = lib.get(url.toString(), { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const ps = (j.result && j.result.playlists) || [];
          resolve(ps);
        } catch (e) {
          reject(new Error(`parse fail: ${e.message}, body=${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('search timeout')));
  });
}

/** Score: playCount primary, trackCount secondary. Reads snake_case fields. */
function score(p) {
  const pc = Number(p.play_count) || 0;
  const tc = Number(p.track_count) || 0;
  return pc + tc * 1000;
}

async function searchScene(sceneName, opts = {}) {
  // opts.useLLM      - try LLM keyword generation first
  // opts.weatherToday, opts.weatherTomorrow - for LLM context
  // Returns {scene, candidates, total_skipped, keywords_source, llm_used}
  let keywords;
  let source;
  let llm_used = false;

  if (opts.useLLM) {
    const llmKws = await generateKeywordsWithLLM({
      sceneName,
      weatherToday: opts.weatherToday,
      weatherTomorrow: opts.weatherTomorrow,
    });
    if (llmKws && llmKws.length > 0) {
      keywords = llmKws;
      source = 'llm';
      llm_used = true;
      console.log(`[${sceneName}] using LLM keywords:`, keywords);
    }
  }
  if (!keywords) {
    const fb = loadSceneKeywords(sceneName);
    keywords = fb.keywords;
    source = fb.source;
  }
  if (!keywords || keywords.length === 0) {
    return {
      scene: sceneName,
      candidates: [],
      total_skipped: 0,
      keywords_source: source,
      llm_used,
      used_keywords: keywords,
      error: 'no keywords configured for this scene',
    };
  }
  const usedIds = loadAllUsedPlaylistIds();
  const seen = new Map(); // id -> {meta, matched_keyword}
  let skipped = 0;

  for (const kw of keywords) {
    let results;
    try {
      results = await searchPlaylists(kw, 10);
    } catch (e) {
      console.error(`[${sceneName}] search failed for "${kw}": ${e.message}`);
      continue;
    }
    for (const p of results) {
      const id = String(p.id);
      if (usedIds.has(id)) {
        skipped++;
        continue;
      }
      if (seen.has(id)) {
        // multiple keywords matched, record additional match
        seen.get(id).matched_keywords.push(kw);
        continue;
      }
      seen.set(id, {
        id,
        name: p.name,
        cover: p.coverImgUrl,
        creator: p.creator && p.creator.nickname,
        creator_id: p.creator && p.creator.userId,
        play_count: Number(p.playCount) || 0,
        track_count: Number(p.trackCount) || 0,
        matched_keyword: kw,
        matched_keywords: [kw],
      });
    }
  }

  const candidates = Array.from(seen.values())
    .map((c) => ({ ...c, score: score(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { scene: sceneName, candidates, total_skipped: skipped, keywords_source: source, llm_used, used_keywords: keywords };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scene_playlist_search.js <scene_name|--all>');
    process.exit(1);
  }
  if (arg === '--all') {
    const names = ['morning', 'play', 'sport', 'night'];
    for (const n of names) {
      try {
        const r = await searchScene(n);
        console.log(JSON.stringify(r, null, 2));
      } catch (e) {
        console.error(`[${n}] error: ${e.message}`);
      }
    }
  } else {
    const r = await searchScene(arg);
    console.log(JSON.stringify(r, null, 2));
  }
}

if (require.main === module) main();

module.exports = {
  searchScene,
  loadAllUsedPlaylistIds,
  // LLM hooks (used by scene_fetch.js to drive keyword gen + playlist selection)
  generateKeywordsWithLLM,
  selectPlaylistWithLLM,
  loadSceneHistory,
  loadSceneKeywords,
};
