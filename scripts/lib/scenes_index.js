/**
 * scenes_index.js — load + lookup helper for config/scenes/*.json
 *
 * Each scene JSON has shape:
 *   { name, trigger, keywords, tts_interval_songs, ... }
 *
 * `trigger` is a 5-field cron string ("0 6 * * *").
 *
 * The mapping batch → scene is time-of-day based (so 07:00 cron fires
 * the "morning" scene, 21:00 fires "night", 12:00 fires "play",
 * 17:30 fires "sport"). We resolve this by comparing the current
 * Asia/Shanghai hour against each scene's trigger.
 */

const fs = require('fs');
const path = require('path');

const SCENES_DIR = path.join(__dirname, '..', '..', 'config', 'scenes');

/** Load all scenes keyed by filename (without .json). */
function loadAll() {
  const out = {};
  if (!fs.existsSync(SCENES_DIR)) return out;
  for (const f of fs.readdirSync(SCENES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const name = f.replace(/\.json$/, '');
    try {
      out[name] = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, f), 'utf8'));
    } catch (e) {
      console.error(`[scenes] failed to load ${f}: ${e.message}`);
    }
  }
  return out;
}

/** Load one scene by name (e.g. 'morning'). Throws if not found. */
function loadOne(name) {
  const fp = path.join(SCENES_DIR, `${name}.json`);
  if (!fs.existsSync(fp)) throw new Error(`scene not found: ${fp}`);
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

/**
 * Parse "0 6 * * *" → {minute: 0, hour: 6, dom: '*', month: '*', dow: '*'}
 * Crontab fields with `*` map to null; first field = minute, second = hour.
 */
function parseCron(expr) {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`bad cron: "${expr}"`);
  const parseField = (s) => (s === '*' ? null : parseInt(s, 10));
  return { minute: parseField(parts[0]), hour: parseField(parts[1]), raw: parts };
}

/**
 * Given the current hour (Asia/Shanghai, 0-23) and minute (0-59),
 * find the scene whose trigger matches this time of day. Returns the
 * scene's name (filename stem) or null if nothing matches.
 *
 * Multi-firing per day: returns the FIRST match in directory order
 * whose hour/minute is within a 5-minute window of now. Good enough
 * for the morning/evening/play/sport cron schedule.
 */
function sceneForTime(hour, minute, scenes) {
  const all = scenes || loadAll();
  const ordered = Object.entries(all);  // insertion order
  for (const [name, scene] of ordered) {
    if (!scene.trigger) continue;
    const t = parseCron(scene.trigger);
    if (t.hour === null || t.minute === null) continue;
    if (t.hour === hour && Math.abs((t.minute || 0) - minute) <= 5) {
      return name;
    }
  }
  return null;
}

/**
 * Map a trigger batch (morning/evening/manual) to a scene by:
 *   - 'morning' → 'morning'
 *   - 'evening' → 'night'   (the evening cron fires the night scene)
 *   - 'manual'  → null      (no automatic mapping; caller must supply)
 *
 * This is a stable convention: the worker writes a `pending_scene`
 * hint into queue_state.json before the trigger is consumed, so the
 * worker can forward DJ_SCENE to the script. This function is the
 * fallback if no hint is present.
 */
function defaultSceneForBatch(batch) {
  switch (batch) {
    case 'morning': return 'morning';
    case 'evening': return 'night';
    case 'manual':  return null;
    default:        return null;
  }
}

module.exports = {
  SCENES_DIR,
  loadAll,
  loadOne,
  parseCron,
  sceneForTime,
  defaultSceneForBatch,
};
