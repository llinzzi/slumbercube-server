/**
 * netease_dl.js — NeteaseCloudMusicApi download helpers (shared).
 *
 * Extracted from generate_playlist.js (which had a duplicate of this
 * block). Both generate_playlist.js and scene_fetch.js require this
 * module so the search→url→download flow is in one place.
 *
 * The sidecar process must be running on NETEASE_API (see README — started
 * via /home/zulin/ncm-api/start.sh). All requests are anonymous — no
 * login cookie, no VIP. Anonymous requests can still resolve search,
 * playlist detail, and 320kbps song URLs for free content.
 */

const fs = require('fs');
const path = require('path');

const NETEASE_API = process.env.NETEASE_API || 'http://127.0.0.1:3001';
const NETEASE_DOWNLOAD_DIR = process.env.NETEASE_DOWNLOAD_DIR || '/home/zulin/Music/网易云收藏';
const NETEASE_REQUEST_TIMEOUT = 8000;  // ms — search + song/url each have budget

// Sanitize a song name for use as a filename. Chinese chars are kept;
// we just strip path separators and control chars. Length cap prevents
// runaway names from breaking ext4 (max 255 bytes).
function sanitizeFilename(s) {
  return s
    .replace(/[\\/?*"<>|\x00-\x1f]/g, '_')
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
//
// freeTrialInfo 字段用于判断 30 秒试听片段（VIP/付费歌曲对非 VIP 用户）：
//   { fragmentType: -1, start: 0, end: 30, ... }   → 试听
//   null                                            → 完整
// size 字段不可靠（API 返回的 size 偶尔与实际 CDN 文件大小不一致）。
async function neteaseGetSongUrl(id) {
  const url = `${NETEASE_API}/song/url?id=${id}&br=320000`;
  const r = await fetch(url, { signal: AbortSignal.timeout(NETEASE_REQUEST_TIMEOUT) });
  if (!r.ok) throw new Error(`song/url HTTP ${r.status}`);
  const j = await r.json();
  const item = j?.data?.[0];
  if (!item?.url) return null;  // VIP-only or geo-blocked
  return {
    url: item.url,
    size: item.size,
    br: item.br,
    fee: item.fee,
    level: item.level,
    freeTrialInfo: item.freeTrialInfo,  // null = full, {end: N} = trial clip
  };
}

// 是否 30 秒试听片段（VIP/付费歌曲对当前未登录账号的退化版）
function isTrialClip(urlInfo) {
  if (!urlInfo) return false;
  const fti = urlInfo.freeTrialInfo;
  // end <= 60 视为试听；正常歌曲不会自己报告 end<duration
  if (fti && typeof fti.end === 'number' && fti.end > 0 && fti.end <= 60) return true;
  return false;
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

/**
 * Resolve a (name, artist) pair on netease and download the 320kbps MP3
 * to NETEASE_DOWNLOAD_DIR. Returns the absolute file path on success,
 * or null on any step failure (search miss, VIP-only, network error).
 *
 * If the destination file already exists with >100KB of data, we reuse
 * it — this makes re-running a batch idempotent and avoids hammering
 * netease's CDN.
 *
 * Pass `logger.log` to forward "[netease] ..." messages (matches the
 * existing convention from generate_playlist.js).
 *
 * The current NCM playlist context is process-global: callers set it
 * via setCurrentPlaylist({id, name}) before invoking a batch of
 * downloads, and each successful download (or cache hit) is recorded
 * in the library index along with that playlist's id+name. This is
 * what the曲目库 page uses to show "this song came from 歌单X" —
 * there's no other way to recover the source playlist after the fact,
 * because the MP3 filename is just "name - artist.mp3".
 */
async function neteaseSearchAndDownload(name, artist, { logger } = {}) {
  const log = logger ? (...a) => logger('[netease]', ...a) : () => {};
  try {
    const hit = await neteaseSearch(name, artist);
    if (!hit) {
      log(`no search result for "${name} - ${artist}"`);
      return null;
    }
    const urlInfo = await neteaseGetSongUrl(hit.id);
    if (!urlInfo) {
      log(`no 320k URL for id=${hit.id} (${name} - ${artist}, likely VIP)`);
      return null;
    }
    // ★ 跳过 30 秒试听片段（VIP/付费歌曲对非 VIP 用户的退化版）
    // 上层循环（scene_fetch / generate_playlist）应改用「累计成功
    // 下载 N 首」而不是「遍历前 N 首」，这样听到试听就自然换下一首。
    if (isTrialClip(urlInfo)) {
      const end = urlInfo.freeTrialInfo.end;
      log(`skip trial clip id=${hit.id} end=${end}s fee=${urlInfo.fee} (${name} - ${artist})`);
      return null;
    }
    const safeName = sanitizeFilename(`${hit.name} - ${hit.artist}`);
    const destPath = path.join(NETEASE_DOWNLOAD_DIR, `${safeName}.mp3`);
    const existed = fs.existsSync(destPath) && fs.statSync(destPath).size > 100_000;
    if (existed) {
      log(`reusing cached file: ${destPath}`);
      // Cache hits already have an index entry from the original
      // download — but the original may have been recorded under a
      // different playlist context (before this feature landed, or
      // before the caller set the context). Re-record now to ensure
      // the index reflects the most recent intent. Cheap; append-only
      // dedup is done at read time.
      appendLibraryIndex({
        title: hit.name,
        artist: hit.artist,
        playlist_id: _currentPlaylist?.id ?? null,
        playlist_name: _currentPlaylist?.name ?? null,
        downloaded_at: new Date().toISOString(),
      });
      return destPath;
    }
    const size = await downloadToFile(urlInfo.url, destPath);
    log(`downloaded ${(size / 1024).toFixed(0)} KB → ${destPath}`);
    appendLibraryIndex({
      title: hit.name,
      artist: hit.artist,
      playlist_id: _currentPlaylist?.id ?? null,
      playlist_name: _currentPlaylist?.name ?? null,
      downloaded_at: new Date().toISOString(),
    });
    return destPath;
  } catch (e) {
    log(`error for "${name} - ${artist}": ${e.message.slice(0, 150)}`);
    return null;
  }
}

// --------------------------------------------------------------------
// Library index: a persistent log of every (song → NCM playlist) edge
// we ever recorded. Lives in .radio_playlist/library_index.json so it
// sits next to queue_state.json and is owned by the same daemon. The
// file is append-only from the writer's side; reads (server.js) build
// an in-memory Map and dedup by basename.
// --------------------------------------------------------------------

// _currentPlaylist is set by setCurrentPlaylist() before each batch
// download. It's process-global because Node modules are singletons
// within a process; both scene_fetch.js and generate_playlist.js share
// this state in the same worker process.
let _currentPlaylist = null;
const LIBRARY_INDEX_FILE = process.env.LIBRARY_INDEX_FILE
  || path.join(process.env.HOME || '/root', 'slumbercube-server', '.radio_playlist', 'library_index.json');

function setCurrentPlaylist(p) {
  // p: { id, name } | null
  _currentPlaylist = p && (p.id || p.name) ? { id: p.id ?? null, name: p.name ?? null } : null;
}

function getCurrentPlaylist() {
  return _currentPlaylist;
}

function _readIndexRaw() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_INDEX_FILE, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function appendLibraryIndex(entry) {
  // Append-only with a small read-modify-write. Safe because only one
  // process (the active worker) writes this file at a time. If two
  // workers ever race, the last write wins and we lose at most one
  // entry — acceptable for a UI-only data source.
  try {
    fs.mkdirSync(path.dirname(LIBRARY_INDEX_FILE), { recursive: true });
    const data = _readIndexRaw();
    data.entries = data.entries || [];
    data.entries.push(entry);
    fs.writeFileSync(LIBRARY_INDEX_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    // Logging through logger would be nice but we don't have it here
    // and the caller's own [netease] log line is enough for diagnosis.
    process.stderr.write(`[library_index] append failed: ${e.message}\n`);
  }
}

function readLibraryIndex() {
  return _readIndexRaw();
}

module.exports = {
  NETEASE_API,
  NETEASE_DOWNLOAD_DIR,
  LIBRARY_INDEX_FILE,
  sanitizeFilename,
  neteaseSearch,
  neteaseGetSongUrl,
  downloadToFile,
  neteaseSearchAndDownload,
  isTrialClip,
  setCurrentPlaylist,
  getCurrentPlaylist,
  appendLibraryIndex,
  readLibraryIndex,
};
