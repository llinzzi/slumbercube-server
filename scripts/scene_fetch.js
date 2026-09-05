#!/usr/bin/env node
/**
 * scene_fetch.js — Scene-timer playlist fetch + download
 *
 * Triggered by dj_worker when a scene-timer fires. Pipeline:
 *   1. Load the scene config (config/scenes/<scene>.json)
 *   2. Search Netease for playlists matching the scene's keywords
 *   3. Filter out playlists already adopted (per-scene + cross-scene dedup)
 *   4. Pick the highest-scored fresh candidate
 *   5. Adopt it (writes to data/history_playlists/<scene>.json, which
 *      makes it visible to future dedup checks)
 *   6. For each song in the playlist, download via the netease
 *      search-and-download pipeline (NETEASE_DOWNLOAD_DIR)
 *   7. Append a record to data/scene_audit/<scene>.jsonl
 *   8. If NO fresh candidate was found, append a "dedup_miss" record
 *      and exit 2 so the worker can fall back to the standard
 *      generate_playlist path (AI picks from local library).
 *
 * Worker integration (env vars, set by dj_worker.js when spawning):
 *   DJ_SCENE=<scene_name>           (e.g. "morning", "night", "play", "sport")
 *   DJ_PROGRESS_FILE=<queue_state>  (matches generate_playlist convention)
 *   DJ_CANCEL_FILE=<cancel flag>    (matches generate_playlist convention)
 *
 * Exit codes:
 *   0  - success, songs downloaded
 *   2  - dedup miss: no fresh playlist available; worker should fall back
 *   1  - hard error (config missing, network down, etc.)
 *
 * Usage (standalone):
 *   node scripts/scene_fetch.js morning
 *   node scripts/scene_fetch.js night
 */

const fs = require('fs');
const path = require('path');

const { neteaseSearchAndDownload, NETEASE_DOWNLOAD_DIR, setCurrentPlaylist } = require('./lib/netease_dl');
const { loadOne } = require('./lib/scenes_index');
const { searchScene, loadAllUsedPlaylistIds, selectPlaylistWithLLM, loadSceneHistory } = require('./scene_playlist_search');
const { adopt, isCrossSceneDuplicate } = require('./scene_playlist_adopt');
const audit = require('./lib/scene_audit');

const DJ_SCENE = process.env.DJ_SCENE || null;
const DJ_PROGRESS_FILE = process.env.DJ_PROGRESS_FILE || null;
const DJ_CANCEL_FILE = process.env.DJ_CANCEL_FILE || null;

function log(...args) {
  const line = `[scene-fetch ${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
}

function reportProgress(partial) {
  if (!DJ_PROGRESS_FILE) return;
  try {
    let current = {};
    if (fs.existsSync(DJ_PROGRESS_FILE)) {
      current = JSON.parse(fs.readFileSync(DJ_PROGRESS_FILE, 'utf8'));
    }
    if (partial.progress && current.progress) {
      partial.progress = Object.assign({}, current.progress, partial.progress);
    }
    const next = Object.assign({}, current, partial, {
      updated_at: new Date().toISOString(),
    });
    const tmp = DJ_PROGRESS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, DJ_PROGRESS_FILE);
  } catch { /* never let reporting failure kill the run */ }
}

function checkCancelled() {
  if (!DJ_CANCEL_FILE) return false;
  try { return fs.existsSync(DJ_CANCEL_FILE); } catch { return false; }
}

async function main() {
  const sceneName = DJ_SCENE || process.argv[2];
  if (!sceneName) {
    console.error('usage: scene_fetch.js <scene_name> (or DJ_SCENE env)');
    process.exit(1);
  }

  // 1. Load scene config — hard error if missing
  let scene;
  try {
    scene = loadOne(sceneName);
  } catch (e) {
    log(`FATAL: ${e.message}`);
    audit.append(sceneName, { scene: sceneName, outcome: 'error', error: e.message });
    process.exit(1);
  }

  log(`scene="${sceneName}" name="${scene.name}" keywords=[${scene.keywords.join(', ')}]`);
  reportProgress({
    state: 'running',
    batch: 'scene-fetch',
    scene: sceneName,
    started_at: new Date().toISOString(),
    progress: { phase: 'searching', total: 0, current: 0, succeeded: 0, failed: 0 },
  });

  // 2. Search NCM for playlists
  // Fetch today's/tomorrow's weather first so the LLM keyword generator
  // can use it as context. /api/weather has a 1-min in-memory cache
  // shared with the worker, so this is cheap.
  let weatherToday = '', weatherTomorrow = '';
  try {
    const http = require('http');
    const w = await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:3000/api/weather', { timeout: 5000 }, (res) => {
        let d = ''; res.setEncoding('utf8');
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('weather timeout')); });
    });
    if (w && w.today) {
      weatherToday = `${w.today.textDay || ''}${w.today.tempMin ? '，' + w.today.tempMin + '~' + w.today.tempMax + '°C' : ''}`.replace(/^，/, '');
    }
    if (w && w.tomorrow) {
      weatherTomorrow = `${w.tomorrow.textDay || ''}${w.tomorrow.tempMin ? '，' + w.tomorrow.tempMin + '~' + w.tomorrow.tempMax + '°C' : ''}`.replace(/^，/, '');
    }
  } catch (e) {
    log(`weather fetch failed (non-fatal): ${e.message.slice(0, 80)}`);
  }

  let searchResult;
  try {
    searchResult = await searchScene(sceneName, { useLLM: true, weatherToday, weatherTomorrow });
  } catch (e) {
    log(`search failed: ${e.message}`);
    audit.append(sceneName, { scene: sceneName, outcome: 'search_error', error: e.message });
    reportProgress({ state: 'failed', result: { error: `search: ${e.message}` } });
    process.exit(1);
  }
  log(`search returned ${searchResult.candidates.length} candidates (skipped ${searchResult.total_skipped} used, keywords=${searchResult.keywords_source}${searchResult.llm_used ? '/llm' : ''})`);

  // 把搜索过程写进 progress，让 UI 能展示「搜了什么关键词 / 找到哪些候选」
  // 用 push 模式（不是覆盖），让上一个 reportProgress 的字段（phase /
  // total 等）保留。state 字段保持 running。
  reportProgress({
    state: 'running',
    progress: {
      phase: 'searching',
      keywords: (searchResult && searchResult.keywords_source === 'llm')
        ? (searchResult.candidates[0] && searchResult.candidates[0].matched_keywords) || []
        : scene.keywords,                         // LLM 生成 or 配置的关键词
      candidates: searchResult.candidates.map(c => ({  // 候选歌单列表
        id: c.id,
        name: c.name,
        track_count: c.track_count,
        play_count: c.play_count,
        score: c.score,
        matched_keyword: c.matched_keyword,
      })),
      total_ranked: searchResult.total_ranked,
      skipped_used: searchResult.total_skipped,
    },
  });

  // 3-4. Pick a fresh candidate.
  // First try the LLM picker (if it returns a valid id present in candidates).
  // Otherwise fall back to score-sort[0].
  let candidate = null;
  let llm_picked_id = null;
  if (searchResult.candidates.length > 0) {
    try {
      const llmId = await selectPlaylistWithLLM({
        sceneName,
        candidates: searchResult.candidates,
        weatherToday,
        weatherTomorrow,
      });
      if (llmId && llmId !== 'SKIP') {
        const match = searchResult.candidates.find(c => String(c.id) === String(llmId));
        if (match) {
          candidate = match;
          llm_picked_id = llmId;
          log(`LLM chose playlist ${llmId} (${match.name})`);
        } else {
        log(`LLM returned ${llmId} not in candidates`);
        }
      } else if (llmId === 'SKIP') {
        log(`LLM said SKIP — no playlist will be adopted`);
      } else {
        log(`LLM picker returned no valid id after retries`);
      }
    } catch (e) {
      log(`LLM picker error: ${e.message.slice(0, 100)}`);
    }
  }
  if (!candidate && searchResult.candidates.length) {
    const error = '歌单选择未得到有效结果，已停止，请重试';
    audit.append(sceneName, { scene: sceneName, outcome: 'selection_failed',
      queried_keywords: searchResult.used_keywords, candidates: searchResult.candidates });
    reportProgress({ state: 'failed', result: { error } });
    process.exit(1);
  }
  if (!candidate) {
    log('NO FRESH CANDIDATE — dedup exhausted for this scene');
    audit.append(sceneName, {
      scene: sceneName,
      outcome: 'dedup_miss',
      queried_keywords: scene.keywords,
      candidates_seen: searchResult.candidates.length,
      skipped_used: searchResult.total_skipped,
    });
    reportProgress({
      state: 'failed',  // not done — exit code 2 signals worker to fall back
      result: { error: 'dedup_miss: no fresh playlist' },
    });
    // exit 2 = "fall back to AI path"
    process.exit(2);
  }

  log(`chose playlist ${candidate.id} "${candidate.name}" (${candidate.track_count} tracks, play_count=${candidate.play_count})`);

  // 5. Adopt (writes history_playlists/<scene>.json → makes this playlist
  //    visible to future dedup). `isCrossSceneDuplicate` will throw if
  //    somehow the same id was already adopted by another scene between
  //    search and adopt — in that case we move to the next candidate.
  let adopted;
  try {
    adopted = await adopt(sceneName, candidate.id, candidate.matched_keyword);
  } catch (e) {
    if (e.message && e.message.includes('cross-scene dedup')) {
      log(`cross-scene dup detected on ${candidate.id} — trying next candidate`);
      // Naive retry: drop the conflicting one and pick again
      const remaining = searchResult.candidates.filter(c => c.id !== candidate.id);
      if (remaining.length === 0) {
        audit.append(sceneName, { scene: sceneName, outcome: 'dedup_miss', reason: 'cross_scene_dup_no_alternative' });
        process.exit(2);
      }
      try {
        const retryId = await selectPlaylistWithLLM({ sceneName, candidates: remaining, weatherToday, weatherTomorrow });
        const retryCandidate = remaining.find(c => String(c.id) === retryId);
        if (!retryCandidate) throw new Error('No valid alternative playlist selected');
        adopted = await adopt(sceneName, retryCandidate.id, retryCandidate.matched_keyword);
      } catch (e2) {
        log(`retry also failed: ${e2.message}`);
        audit.append(sceneName, { scene: sceneName, outcome: 'adopt_error', error: e2.message });
        process.exit(1);
      }
    } else {
      log(`adopt failed: ${e.message}`);
      audit.append(sceneName, { scene: sceneName, outcome: 'adopt_error', error: e.message });
      process.exit(1);
    }
  }

  log(`adopted: ${adopted.playlist_id} "${adopted.name}" (${adopted.songs.length} songs)`);
  reportProgress({
    state: 'running',
    progress: {
      phase: 'downloading',
      total: adopted.songs.length,
      current: 0,
      succeeded: 0,
      failed: 0,
      playlist_id: adopted.playlist_id,
      playlist_name: adopted.name,
      // 选中的歌单完整信息（让 UI 高亮这个 candidate）
      chosen_playlist: {
        id: adopted.playlist_id,
        name: adopted.name,
        cover: adopted.cover,
        creator: adopted.creator,
        play_count: adopted.play_count,
        track_count: adopted.track_count,
        matched_keyword: adopted.matched_keyword,
        score: candidate.score,
        llm_picked: !!llm_picked_id,
      },
      llm_keywords: !!searchResult.llm_used,
      llm_picked: !!llm_picked_id,
      // 歌单里所有歌（让 UI 展示完整歌曲列表）
      songs: adopted.songs.map(s => ({
        id: s.id,
        name: s.name,
        artist: s.artist,
        album: s.album,
        duration: s.duration,
      })),
    },
  });

  // 6. Download each song via the standard pipeline
  const downloaded = [];
  const failed = [];
  const skippedTrial = [];
  // 累计下载满 SONGS_PER_PLAYLIST 首完整歌曲为止。遇到 30 秒试听
  // 片段（VIP/付费歌曲对非 VIP 用户的退化版）就跳过继续找下一首。
  // 经验上 ~45% 的网易云歌曲对未登录账号是试听，所以遍历窗口拉到 60 首
  // 才能稳定拿到 20 首完整版（前 60 首通常是热门，命中率更高）。
  const SONGS_PER_PLAYLIST = 20;
  const SEARCH_WINDOW = 60;
  const totalToScan = Math.min(adopted.songs.length, SEARCH_WINDOW);
  // Tag every song we download (or cache-hit) with the NCM playlist
  // it came from, so the曲目库 page can group songs by source. The
  // setter is process-global (it's a module-level variable in
  // netease_dl.js), so all concurrent downloads in this loop inherit
  // the same context.
  setCurrentPlaylist({ id: adopted.playlist_id, name: adopted.name });
  for (let i = 0; i < totalToScan; i++) {
    if (checkCancelled()) {
      log(`cancel requested — aborting after ${downloaded.length} songs`);
      break;
    }
    if (downloaded.length >= SONGS_PER_PLAYLIST) {
      log(`reached ${SONGS_PER_PLAYLIST} full songs, stopping scan at index ${i}/${totalToScan}`);
      break;
    }
    const song = adopted.songs[i];
    reportProgress({ progress: { total: totalToScan, current: i + 1, current_song: `${song.name} - ${song.artist}` } });
    log(`  [${i + 1}/${totalToScan}] ${song.name} - ${song.artist}`);

    const fp = await neteaseSearchAndDownload(song.name, song.artist, { logger: log });
    if (fp) {
      downloaded.push({ id: song.id, name: song.name, artist: song.artist, path: fp });
      reportProgress({ progress: { succeeded: downloaded.length } });
    } else {
      failed.push({ id: song.id, name: song.name, artist: song.artist });
      reportProgress({ progress: { failed: failed.length } });
    }
  }

  log(`done: ${downloaded.length}/${SONGS_PER_PLAYLIST} full songs (scanned ${totalToScan} of ${adopted.songs.length}, ${failed.length} failed/skipped)`);

  // 7. Append audit record
  audit.append(sceneName, {
    scene: sceneName,
    outcome: downloaded.length >= SONGS_PER_PLAYLIST ? 'success' : 'partial',
    queried_keywords: scene.keywords,
    candidates_seen: searchResult.candidates.length,
    skipped_used: searchResult.total_skipped,
    chosen: {
      playlist_id: adopted.playlist_id,
      name: adopted.name,
      matched_keyword: adopted.matched_keyword,
      play_count: adopted.play_count,
      track_count: adopted.track_count,
    },
    tracks: {
      requested: SONGS_PER_PLAYLIST,
      downloaded: downloaded.length,
      failed: failed.length,
      items: downloaded,
      failures: failed,
    },
  });

  // 8. Worker contract
  reportProgress({
    state: 'done',
    result: {
      scene: sceneName,
      playlist_id: adopted.playlist_id,
      playlist_name: adopted.name,
      downloaded: downloaded.length,
      failed: failed.length,
      download_dir: NETEASE_DOWNLOAD_DIR,
      // LLM-driven selection flags (so the run-history can show whether the
      // LLM was involved). Used by admin UI to highlight the LLM steps.
      llm_keywords: !!searchResult.llm_used,
      llm_picked: !!llm_picked_id,
      // The actual keywords used (either LLM-generated or fallback scene.keywords).
      // Truncated to 10 entries to keep the JSON small.
      used_keywords: (searchResult.used_keywords || searchResult.candidates?.[0]?.matched_keywords || []).slice(0, 10),
      // Persist the actual downloaded song list so the post-fetch
      // playlist builder (scripts/build_playlist_from_result.js) can
      // turn these into a stitched, intro-narrated playlist without
      // having to re-walk the download directory. Each entry mirrors
      // what generate_playlist.js expects: name + filePath.
      songs: downloaded.map(s => ({
        name: s.name,
        artist: s.artist,
        filePath: s.path,
        playlist_id: adopted.playlist_id,
        playlist_name: adopted.name,
      })),
    },
  });
  process.exit(0);
}

main().catch((e) => {
  console.error('[scene-fetch] UNCAUGHT:', e.stack || e.message);
  if (DJ_SCENE || process.argv[2]) {
    audit.append(DJ_SCENE || process.argv[2], { outcome: 'uncaught', error: e.message });
  }
  process.exit(1);
});
