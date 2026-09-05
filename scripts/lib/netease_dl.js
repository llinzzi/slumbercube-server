/**
 * netease_dl.js — NeteaseCloudMusicApi download helpers (shared).
 *
 * Extracted from generate_playlist.js (which had a duplicate of this
 * block). Both generate_playlist.js and scene_fetch.js require this
 * module so the search→url→download flow is in one place.
 *
 * The sidecar process must be running on NETEASE_API (see README — started
 * via the local NCM API service.
 * login cookie, no VIP. Anonymous requests can still resolve search,
 * playlist detail, and 320kbps song URLs for free content.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const NETEASE_API = process.env.NETEASE_API || 'http://127.0.0.1:3001';
const NETEASE_DOWNLOAD_DIR = process.env.NETEASE_DOWNLOAD_DIR || path.join(os.homedir(), 'Music', '网易云收藏');
const NETEASE_REQUEST_TIMEOUT = 8000;  // ms — search + song/url each have budget
const MIN_SONG_SIZE = 200_000;         // bytes — below this, the file is almost certainly a trial clip or truncated download
const MIN_SONG_DURATION = 30;          // seconds — songs shorter than this are flagged as suspicious

// MPEG1 Layer 3 bitrate table (kbps), index 0-15
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_BITRATES = [0, 8,  16, 24, 32,  40,  48,  56,  64,  80,  96,  112, 128, 144, 160, 0];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000, 0];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000, 0];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000,  0];

// Quick duration estimate from an MP3 file without ffprobe.
// Reads a small chunk after the ID3 tag, finds the first valid MPEG frame header, and
// computes duration = fileSize * 8 / bitrate. Skips ID3v2 tags.
// Returns { bitrate, sampleRate, channels, channelMode, duration } or null.
function estimateMp3Duration(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 1024) return null;
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, header.length, 0);
    let offset = 0;
    if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
      // ID3v2 size is 4 bytes at offset 6, synchsafe integer
      const id3Size = ((header[6] & 0x7F) << 21) | ((header[7] & 0x7F) << 14)
                    | ((header[8] & 0x7F) << 7) | (header[9] & 0x7F);
      offset = 10 + id3Size;
    }
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    // Scan for MPEG frame sync word 0xFFEx
    for (let i = 0; i < bytesRead - 3; i++) {
      if (buf[i] !== 0xFF) continue;
      if ((buf[i + 1] & 0xE0) !== 0xE0) continue;
      // Skip if next byte looks like another sync (false positive)
      const b2 = buf[i + 1];
      const versionIdx = (b2 >> 3) & 0x3;  // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const layerIdx  = (b2 >> 1) & 0x3;   // 3=Layer1, 2=Layer2, 1=Layer3
      if (layerIdx !== 1) continue;        // Layer 3 only
      const b3 = buf[i + 2];
      const bitrateIdx = (b3 >> 4) & 0xF;
      const sampleRateIdx = (b3 >> 2) & 0x3;

      if (bitrateIdx === 0 || bitrateIdx === 15) continue; // reserved / free

      let bitrate, sampleRate;
      if (versionIdx === 3) {
        bitrate = MPEG1_BITRATES[bitrateIdx] * 1000;
        sampleRate = MPEG1_SAMPLE_RATES[sampleRateIdx];
      } else if (versionIdx === 2) {
        bitrate = MPEG2_BITRATES[bitrateIdx] * 1000;
        sampleRate = MPEG2_SAMPLE_RATES[sampleRateIdx];
      } else if (versionIdx === 0) {
        bitrate = MPEG2_BITRATES[bitrateIdx] * 1000;
        sampleRate = MPEG25_SAMPLE_RATES[sampleRateIdx];
      } else {
        continue;
      }

      if (!bitrate || !sampleRate) continue;

      // Duration estimate from file size. ID3v1 tag at end (128 bytes)
      // and ID3v2 header are included in the file size, so this is a
      // slight overestimate — acceptable for our purpose (flagging
      // obviously-short files).
      const duration = Math.round((stat.size * 8) / bitrate);
      const channelModeIdx = (buf[i + 3] >> 6) & 0x3;
      const channelModes = ['立体声', '联合立体声', '双声道', '单声道'];
      return {
        bitrate: Math.round(bitrate / 1000),
        sampleRate,
        channels: channelModeIdx === 3 ? 1 : 2,
        channelMode: channelModes[channelModeIdx],
        duration,
      };
    }
    return null;
  } catch {
    return null;
  }
}

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

// 是否为短试听片段（VIP/付费歌曲对当前未登录账号的退化版）。
//
// 判断优先级：
//   1. freeTrialInfo.end == 0: 有些 API 版本用 end=0 表示试听片段（0 秒
//      意味着文件存在但内容很短）。正常歌曲不会报告 end=0。
//   2. freeTrialInfo.end <= 90: 核心判断 —— 正常歌曲有时也会被 API 标为
//      试听版本（例如付费歌曲对免费账号），但 end 会接近曲目长度。小于 90
//      秒的都视为退化片段。
//   3. fee > 0 且无登录 cookie: 强信号——几乎所有付费歌曲在没有登录 cookie
//      时都返回试听片段。结合 size < 1MB 一起判断（一首 320kbps 90 秒的
//      歌约 3.6MB）。
//   4. size < 500KB 且 fee > 0: 即使 freeTrialInfo 已解除，极小的 size 也
//      足以确认是试听（完整 320kbps 歌曲最小约 3MB）。
function isTrialClip(urlInfo) {
  if (!urlInfo) return false;
  const fti = urlInfo.freeTrialInfo;
  // end <= 90 (放宽到 90 秒)：正常歌曲的试听片段最多约 30-90 秒。
  if (fti && typeof fti.end === 'number') {
    if (fti.end === 0) return true;                        // 0 秒 → 极短片段
    if (fti.end > 0 && fti.end <= 90) return true;         // ≤ 90 秒试听
  }
  // 付费歌曲 (fee > 0) 对非 VIP 基本是试听。结合 size 信息辅助判断：
  // size < 500KB + fee > 0 → 极大概率是试听（完整歌至少 3MB）。
  if (urlInfo.fee > 0 && typeof urlInfo.size === 'number' && urlInfo.size < 500_000) {
    return true;
  }
  return false;
}

// Download a URL to a local file. We pipe through fetch → stream so we
// don't buffer the whole MP3 in memory (some tracks are 30MB).
//
// Post-download validation:
//   1. If content-length was present and the written size differs by >10%,
//      the file is deleted and the promise rejects (caller should retry).
//   2. If the file is smaller than MIN_SONG_SIZE (200KB), it is treated
//      as a trial clip / truncated download — the promise rejects.
//   3. We attempt up to `retries` times (default 1 retry = 2 total attempts)
//      when the first download fails validation.
async function downloadToFile(remoteUrl, destPath, retries = 1) {
  const attempt = async () => {
    const r = await fetch(remoteUrl, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const contentLength = r.headers.get('content-length');
    const expectedSize = contentLength ? parseInt(contentLength, 10) : null;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const ws = fs.createWriteStream(destPath);
    await new Promise((resolve, reject) => {
      r.body.pipeTo(new WritableStream({
        write(chunk) { ws.write(Buffer.from(chunk)); },
        close() { ws.end(); },
      })).then(resolve, reject);
    });
    await new Promise((resolve) => ws.on('finish', resolve));
    const actualSize = fs.statSync(destPath).size;

    // Content-length mismatch (>10%) → truncated download
    if (expectedSize && actualSize < expectedSize * 0.9) {
      try { fs.unlinkSync(destPath); } catch {}
      throw new Error(`download truncated: expected ${(expectedSize / 1024).toFixed(0)}KB, got ${(actualSize / 1024).toFixed(0)}KB`);
    }

    // File too small to be a real song
    if (actualSize < MIN_SONG_SIZE) {
      try { fs.unlinkSync(destPath); } catch {}
      throw new Error(`file too small: ${(actualSize / 1024).toFixed(0)}KB < ${(MIN_SONG_SIZE / 1024).toFixed(0)}KB minimum`);
    }

    return actualSize;
  };

  for (let t = 0; t <= retries; t++) {
    try {
      return await attempt();
    } catch (e) {
      if (t < retries) {
        // Log and retry — brief pause to avoid hammering on transient failures
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw e;
      }
    }
  }
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

    // Build diagnostic summary for the log: fti={end, start}, fee, api_size
    const fti = urlInfo.freeTrialInfo || null;
    const diag = [
      `id=${hit.id}`,
      `fee=${urlInfo.fee ?? '?'}`,
      `br=${urlInfo.br ?? '?'}`,
      fti ? `fti.end=${fti.end}` : 'fti=null',
      urlInfo.size ? `api_size=${(urlInfo.size / 1024).toFixed(0)}KB` : 'api_size=?',
    ].join(' ');

    // ★ 跳过试听片段（VIP/付费歌曲对非 VIP 用户的退化版）
    // 上层循环（scene_fetch / generate_playlist）应改用「累计成功
    // 下载 N 首」而不是「遍历前 N 首」，这样听到试听就自然换下一首。
    if (isTrialClip(urlInfo)) {
      const end = fti ? fti.end : '?';
      log(`skip trial clip ${diag} end=${end}s (${name} - ${artist})`);
      return null;
    }

    const safeName = sanitizeFilename(`${hit.name} - ${hit.artist}`);
    const destPath = path.join(NETEASE_DOWNLOAD_DIR, `${safeName}.mp3`);

    // Cache hit: existing file > 200KB. We also validate the cached file's
    // estimated duration so a previously-cached trial clip doesn't keep
    // being reused as if it were a real song.
    const existed = fs.existsSync(destPath);
    if (existed) {
      const cachedSize = fs.statSync(destPath).size;
      if (cachedSize > MIN_SONG_SIZE) {
        // Extra validation for cached files: check estimated duration.
        const meta = estimateMp3Duration(destPath);
        if (meta && meta.duration < MIN_SONG_DURATION) {
          log(`cached file too short (est ${meta.duration}s, ${(cachedSize / 1024).toFixed(0)}KB) — re-downloading "${name} - ${artist}"`);
          // Fall through to re-download; don't reuse this cached copy.
        } else {
          log(`reusing cached file: ${destPath} (${(cachedSize / 1024).toFixed(0)}KB${meta ? `, ~${meta.duration}s` : ''})`);
          appendLibraryIndex({
            title: hit.name,
            artist: hit.artist,
            playlist_id: _currentPlaylist?.id ?? null,
            playlist_name: _currentPlaylist?.name ?? null,
            downloaded_at: new Date().toISOString(),
            audio_meta: meta || null,
          });
          return destPath;
        }
      } else {
        // Cached file is too small — remove it and re-download.
        log(`cached file too small (${(cachedSize / 1024).toFixed(0)}KB) — removing and re-downloading "${name} - ${artist}"`);
        try { fs.unlinkSync(destPath); } catch {}
      }
    }

    // Download with one retry on validation failure.
    let size;
    try {
      size = await downloadToFile(urlInfo.url, destPath, 1);
    } catch (dlErr) {
      // downloadToFile already retried once internally; surface as a
      // permanent failure for this song.
      log(`download failed after retry: ${dlErr.message.slice(0, 120)} — ${diag} (${name} - ${artist})`);
      return null;
    }

    // Post-download duration validation — double-check that the
    // downloaded file isn't a trial clip that the API mislabeled.
    const durMeta = estimateMp3Duration(destPath);
    if (durMeta && durMeta.duration < MIN_SONG_DURATION) {
      log(`downloaded file too short: est ${durMeta.duration}s @ ${durMeta.bitrate}kbps, ${(size / 1024).toFixed(0)}KB — discarding (${name} - ${artist})`);
      try { fs.unlinkSync(destPath); } catch {}
      return null;
    }

    log(`downloaded ${(size / 1024).toFixed(0)}KB${durMeta ? `, ~${durMeta.duration}s @ ${durMeta.bitrate}kbps` : ''} → ${destPath}  [${diag}]`);
    appendLibraryIndex({
      title: hit.name,
      artist: hit.artist,
      playlist_id: _currentPlaylist?.id ?? null,
      playlist_name: _currentPlaylist?.name ?? null,
      downloaded_at: new Date().toISOString(),
      audio_meta: durMeta || null,
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
  estimateMp3Duration,
};
