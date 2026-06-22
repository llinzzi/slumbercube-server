#!/usr/bin/env node
/**
 * scene_playlist_adopt.js
 *
 * Adopt a NCM playlist into a scene's history. Pulls full track list,
 * stores per-playlist songs, writes to data/history_playlists/<scene>.json.
 *
 * Usage:
 *   node scripts/scene_playlist_adopt.js <scene_name> <playlist_id> [matched_keyword]
 *
 * Idempotent: re-running with the same (scene, playlist_id) overwrites the
 * existing entry (refreshes song list) but never creates duplicates.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const NETEASE_API = process.env.NETEASE_API || 'http://localhost:3001';
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history_playlists');

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, NETEASE_API);
    const lib = url.protocol === 'https:' ? https : require('http');
    const req = lib.get(url.toString(), { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`parse fail: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function loadHistory(scene) {
  const fp = path.join(HISTORY_DIR, `${scene}.json`);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return []; }
}

function saveHistory(scene, arr) {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const fp = path.join(HISTORY_DIR, `${scene}.json`);
  // newest first
  arr.sort((a, b) => new Date(b.adopted_at) - new Date(a.adopted_at));
  fs.writeFileSync(fp, JSON.stringify(arr, null, 2));
}

function isCrossSceneDuplicate(playlistId, thisScene) {
  if (!fs.existsSync(HISTORY_DIR)) return null;
  for (const f of fs.readdirSync(HISTORY_DIR)) {
    if (!f.endsWith('.json')) continue;
    const scene = f.replace(/\.json$/, '');
    if (scene === thisScene) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
      const found = arr.find((p) => String(p.playlist_id) === String(playlistId));
      if (found) return scene;
    } catch { /* ignore */ }
  }
  return null;
}

async function adopt(scene, playlistId, matchedKeyword) {
  if (!scene || !playlistId) throw new Error('scene and playlist_id required');

  // Cross-scene dedup check
  const dupScene = isCrossSceneDuplicate(playlistId, scene);
  if (dupScene) {
    throw new Error(`playlist ${playlistId} already adopted by scene "${dupScene}" (cross-scene dedup)`);
  }

  // Pull playlist detail
  const detail = await httpGet(`/playlist/detail?id=${playlistId}`);
  const pl = detail.playlist || {};
  const tracks = pl.tracks || [];

  // Build per-track entries
  const songs = tracks.map((t) => ({
    id: String(t.id),
    name: t.name,
    artist: (t.ar || t.artists || []).map((a) => a.name).join('/') || '未知',
    album: (t.al && t.al.name) || (t.album && t.album.name) || '',
    duration: t.dt || t.duration || 0,
  }));

  const entry = {
    playlist_id: String(playlistId),
    name: pl.name || '(无标题)',
    cover: pl.coverImgUrl || '',
    creator: (pl.creator && pl.creator.nickname) || '',
    creator_id: (pl.creator && pl.creator.userId) || null,
    play_count: Number(pl.playCount) || 0,
    track_count: songs.length,
    matched_keyword: matchedKeyword || '',
    adopted_at: new Date().toISOString(),
    description: (pl.description || '').slice(0, 200),
    songs,
  };

  // Merge into history (replace if same id exists, prepend if new)
  const arr = loadHistory(scene);
  const idx = arr.findIndex((p) => p.playlist_id === entry.playlist_id);
  if (idx >= 0) {
    arr[idx] = entry;  // refresh in place
    console.log(`[${scene}] refreshed existing playlist ${playlistId}`);
  } else {
    arr.unshift(entry);
    console.log(`[${scene}] adopted new playlist ${playlistId} (${entry.name}), ${songs.length} songs`);
  }
  saveHistory(scene, arr);
  return entry;
}

if (require.main === module) {
  const [, , scene, playlistId, kw] = process.argv;
  adopt(scene, playlistId, kw)
    .then((e) => {
      console.log(JSON.stringify({ ok: true, scene, playlist_id: e.playlist_id, songs: e.songs.length }, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    });
}

module.exports = { adopt, isCrossSceneDuplicate };
