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

async function searchScene(sceneName) {
  const { keywords, source } = loadSceneKeywords(sceneName);
  if (!keywords || keywords.length === 0) {
    return {
      scene: sceneName,
      candidates: [],
      total_skipped: 0,
      keywords_source: source,
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

  return { scene: sceneName, candidates, total_skipped: skipped, keywords_source: source };
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

module.exports = { searchScene, loadAllUsedPlaylistIds };
