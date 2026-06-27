#!/usr/bin/env node
/**
 * backfill_library_index.js — one-shot (2026-06-19)
 *
 * Populates .radio_playlist/library_index.json from existing state.
 *
 * The right way to populate this would be from history[].playlist_id/name,
 * but those fields don't exist on history entries written before 2026-06-19
 * (when we added them). For older downloads we fall back to the mtime → the
 * most recent playlist the user has *ever* used (state.result.playlist_name),
 * because in practice all DJ Agent downloads come from the single NCM playlist
 * the worker last selected — there has only been one NCM playlist in use
 * (the morning scene_fetch on 2026-06-18 used "听了心情会好的歌 DaDaDa❤️").
 *
 * Strategy:
 *   1. Read queue_state.json → result.playlist_name (most recent playlist).
 *   2. For each .mp3 in NETEASE_DIR, mtime < now-1h and mtime > result
 *      stale-threshold: tag with result.playlist_name.
 *   3. Files with no mtime match → tag null (will show as "未分组" in UI).
 *
 * Idempotent. Safe to re-run. Future downloads will populate the index
 * automatically through netease_dl.js's appendLibraryIndex().
 */
const fs = require('fs');
const path = require('path');

const PROJECT = (process.env.HOME || '/root') + '/slumbercube-server';
const QUEUE_STATE = path.join(PROJECT, '.radio_playlist', 'queue_state.json');
const LIBRARY_INDEX = path.join(PROJECT, '.radio_playlist', 'library_index.json');
const NETEASE_DIR = process.env.NETEASE_DOWNLOAD_DIR || '/home/zulin/Music/网易云收藏';

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

const queue = readJSON(QUEUE_STATE, { result: null, history: [] });

// Most recent NCM playlist. We don't have per-history playlist names for
// anything that ran before 2026-06-19 (when we added history.playlist_id/
// name), so the only playlist we can actually attribute is the one from
// state.result — the playlist the worker last used. Pragmatically, all
// DJ Agent downloads come from NCM playlists selected by scene_fetch.js, and
// we only have one playlist name in scope: state.result.playlist_name.
let recentPlaylistId = null;
let recentPlaylistName = null;
if (queue.result) {
  recentPlaylistId = queue.result.playlist_id || null;
  recentPlaylistName = queue.result.playlist_name || null;
}

// Cutoff: any song with mtime >= this ISO timestamp is considered to have
// come from the most recent NCM playlist. The cutoff is set to 24h before
// the most recent scene-fetch ended_at (if known) — generous enough to
// include that whole run, strict enough to leave older runs un-attributed
// (they may have used different playlists, and we have no record).
//
// If we have no history at all, fall back to "anything in the last 12h",
// which is a sane default for a fresh deploy.
let cutoffIso = null;
for (const h of (queue.history || [])) {
  if (h.batch === 'scene-fetch' && h.ended_at) {
    const t = Date.parse(h.ended_at) - 24 * 3600 * 1000;
    if (!isNaN(t)) { cutoffIso = new Date(t).toISOString(); }
    break;  // history is newest-first
  }
}
if (!cutoffIso) {
  cutoffIso = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
}

console.log(`attributing playlist: ${recentPlaylistId} "${recentPlaylistName}"`);
console.log(`mtime cutoff (songs newer than this get attributed): ${cutoffIso}`);

let files;
try {
  files = fs.readdirSync(NETEASE_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mp3') && !e.name.startsWith('.'))
    .map(e => e.name);
} catch (e) {
  console.error(`readdir ${NETEASE_DIR} failed: ${e.message}`);
  process.exit(1);
}
console.log(`scanning ${files.length} mp3 files in ${NETEASE_DIR}`);

const entries = [];
let tagged = 0, untagged = 0;
for (const name of files) {
  const full = path.join(NETEASE_DIR, name);
  let mtime;
  try { mtime = fs.statSync(full).mtime.toISOString(); }
  catch { continue; }

  // Attribute: only if mtime is at or after the cutoff AND we have a
  // playlist name to give. Everything older stays null — those songs
  // predate the attribution scheme and showing "未分组" is more honest
  // than guessing the wrong playlist.
  const source = (recentPlaylistName && mtime >= cutoffIso)
    ? { playlist_id: recentPlaylistId, playlist_name: recentPlaylistName }
    : null;

  const stem = name.replace(/\.mp3$/i, '');
  const lastDash = stem.lastIndexOf(' - ');
  const title = lastDash > 0 ? stem.slice(0, lastDash) : stem;
  const artist = lastDash > 0 ? stem.slice(lastDash + 3) : '';

  entries.push({
    title,
    artist,
    playlist_id: source?.playlist_id ?? null,
    playlist_name: source?.playlist_name ?? null,
    downloaded_at: mtime,
  });
  if (source) tagged++; else untagged++;
}

console.log(`tagged: ${tagged}, untagged: ${untagged}`);

// Dedupe by (title, artist) — keep the most recent record
const byKey = new Map();
for (const e of entries) {
  const k = `${e.title}::${e.artist}`;
  const prev = byKey.get(k);
  if (!prev || prev.downloaded_at < e.downloaded_at) byKey.set(k, e);
}
const deduped = [...byKey.values()];
console.log(`after dedup by (title, artist): ${deduped.length} unique songs`);

fs.mkdirSync(path.dirname(LIBRARY_INDEX), { recursive: true });
fs.writeFileSync(LIBRARY_INDEX, JSON.stringify({ entries: deduped }, null, 2));
console.log(`wrote ${LIBRARY_INDEX} (${(JSON.stringify({ entries: deduped }).length / 1024).toFixed(1)} KB)`);
