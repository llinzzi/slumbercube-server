/**
 * scene_audit.js — append-only audit trail for scene→playlist fetches
 *
 * Writes one JSONL line per fetch attempt to data/scene_audit/<scene>.jsonl.
 * Each line is the full record of one run: which playlist was queried,
 * which was chosen, which songs were downloaded (or skipped), and
 * whether it was a "dedup miss" (no fresh playlist available).
 *
 * This is the only forensic record for "why did 川川 hear playlist X
 * at 07:00 on Tuesday". Useful when tuning dedup / rotation policy.
 */

const fs = require('fs');
const path = require('path');

const AUDIT_DIR = path.join(__dirname, '..', '..', 'data', 'scene_audit');

function ensureDir() {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

/**
 * Append a record to <scene>.jsonl. Returns the record (with timestamp
 * added if not present). Uses a single fs.appendFileSync — atomic on
 * most filesystems for sub-page writes.
 */
function append(scene, record) {
  ensureDir();
  const fp = path.join(AUDIT_DIR, `${scene}.jsonl`);
  const full = Object.assign(
    { ts: new Date().toISOString() },
    record
  );
  fs.appendFileSync(fp, JSON.stringify(full) + '\n', 'utf8');
  return full;
}

/** Read all audit records for a scene (for /admin or debugging). */
function readAll(scene) {
  const fp = path.join(AUDIT_DIR, `${scene}.jsonl`);
  if (!fs.existsSync(fp)) return [];
  const out = [];
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch { /* skip malformed lines */ }
  }
  return out;
}

module.exports = { AUDIT_DIR, append, readAll, ensureDir };
