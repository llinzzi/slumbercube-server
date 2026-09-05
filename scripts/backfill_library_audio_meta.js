#!/usr/bin/env node

// Build the lightweight metadata sidecar consumed by /api/library. Run in a
// separate process so slow network-mounted MP3 reads never block the server.
const fs = require('fs');
const path = require('path');
const { estimateMp3Duration } = require('./lib/netease_dl');

const root = path.resolve(__dirname, '..');
const settingsPath = path.join(root, 'config', 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
const libraryDir = settings.library?.stationsDir || process.env.NETEASE_DOWNLOAD_DIR;
if (!libraryDir) throw new Error('library.stationsDir is not configured');

const outputPath = path.join(root, '.radio_playlist', 'library_audio_meta.json');
const files = {};
const entries = fs.readdirSync(libraryDir, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mp3') && !e.name.startsWith('.'));

for (let i = 0; i < entries.length; i++) {
  const ent = entries[i];
  const filePath = path.join(libraryDir, ent.name);
  const stat = fs.statSync(filePath);
  const meta = estimateMp3Duration(filePath);
  files[ent.name] = { ...(meta || {}), size: stat.size, mtime_ms: stat.mtimeMs };
  if ((i + 1) % 100 === 0) process.stdout.write(`parsed ${i + 1}/${entries.length}\n`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const tmp = `${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 2));
fs.renameSync(tmp, outputPath);
console.log(`wrote ${entries.length} tracks to ${outputPath}`);
