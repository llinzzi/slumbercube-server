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
// Surface audit-write failures + read-parse failures at WARN so
// operators notice dedup-context degradation (finding #7). Silent
// failure here is worse than a loud crash because the LLM silently
// dedups against stale context.
function warn(msg) {
  console.warn(`[scene-audit ${new Date().toISOString()}] ${msg}`);
}

function append(scene, record) {
  ensureDir();
  const fp = path.join(AUDIT_DIR, `${scene}.jsonl`);
  const full = Object.assign(
    { ts: new Date().toISOString() },
    record
  );
  try {
    fs.appendFileSync(fp, JSON.stringify(full) + '\n', 'utf8');
  } catch (e) {
    warn(`append failed for ${scene}: ${e.message.slice(0, 200)}`);
    throw e;  // surface to caller (which already catches per-entry)
  }
  return full;
}

/** Read all audit records for a scene (for /admin or debugging). */
function readAll(scene) {
  const fp = path.join(AUDIT_DIR, `${scene}.jsonl`);
  if (!fs.existsSync(fp)) return [];
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    warn(`readAll: file read failed for ${scene}: ${e.message.slice(0, 200)}`);
    return [];
  }
  const out = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch {
      // Malformed line (truncated write, disk corruption, etc.).
      // Skipping silently used to mean dedup-context shrank without
      // warning; now we count and log.
      skipped++;
    }
  }
  if (skipped > 0) {
    warn(`readAll: skipped ${skipped} malformed line(s) in ${scene}.jsonl — dedup context may be stale`);
  }
  return out;
}

module.exports = { AUDIT_DIR, append, readAll, ensureDir };
