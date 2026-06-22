/**
 * dj_queue.js — DJ 工作队列状态库（轻量、无依赖）
 *
 * 所有 DJ 状态都写到 .radio_playlist/queue_state.json。
 * 单一真相源：dj_worker 写，server.js / web 端读。
 *
 * 状态文件 schema:
 * {
 *   state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled',
 *   batch: 'morning' | 'evening' | 'manual',
 *   started_at: ISO string,
 *   updated_at: ISO string,
 *   pid: number | null,
 *   progress: {
 *     total: 10,
 *     current: 4,            // 1-indexed current song
 *     phase: 'selecting' | 'ai_text' | 'tts' | 'transcoding' | 'stitching' | 'finalizing',
 *     current_song: '千与千寻',
 *     succeeded: 4,
 *     failed: 0,
 *   },
 *   result: {
 *     playlist_generated_at: ISO string,    // when done
 *     valid_until: ISO string,
 *     weather: '余杭，晴，22°C',
 *     songs: [...],
 *     error: null | 'error message',
 *   } | null,
 *   history: [
 *     { batch, started_at, ended_at, state, succeeded, failed, duration_sec }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');

const QUEUE_DIR = path.join(__dirname, '..', '.radio_playlist');
const STATE_FILE = path.join(QUEUE_DIR, 'queue_state.json');
const TRIGGER_DIR = QUEUE_DIR;  // trigger files live alongside state

const TRIGGERS = {
  morning: path.join(TRIGGER_DIR, '.trigger_morning'),
  evening: path.join(TRIGGER_DIR, '.trigger_evening'),
  manual: path.join(TRIGGER_DIR, '.trigger_manual'),
};

function ensureDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function emptyState() {
  return {
    state: 'idle',
    batch: null,
    started_at: null,
    updated_at: new Date().toISOString(),
    pid: null,
    progress: null,
    result: null,
    history: [],
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return emptyState();
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return emptyState();
  }
}

function writeState(partial) {
  ensureDir();
  const current = readState();
  const next = Object.assign({}, current, partial, {
    updated_at: new Date().toISOString(),
  });
  // Atomic write: .tmp → rename
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return next;
}

function trigger(batch, persona = null, scene = null) {
  ensureDir();
  // Write the trigger file as before, but also pin the persona and
  // (optional) scene to queue_state.json so the worker (which spawns
  // generate_playlist.js / scene_fetch.js) can forward them as env.
  // Both fields are cleared once the worker consumes the trigger.
  fs.writeFileSync(TRIGGERS[batch], new Date().toISOString());
  writeState({ pending_persona: persona, pending_scene: scene });
}

function consumeTrigger(batch) {
  // Read + delete trigger file atomically. Returns {at, reason} if found.
  const fp = TRIGGERS[batch];
  if (!fs.existsSync(fp)) return null;
  try {
    const at = fs.statSync(fp).mtime.toISOString();
    fs.unlinkSync(fp);
    return { at };
  } catch {
    return null;
  }
}

function pendingTriggers() {
  return Object.keys(TRIGGERS).filter(b => fs.existsSync(TRIGGERS[b]));
}

function appendHistory(entry) {
  const state = readState();
  const history = [entry, ...(state.history || [])].slice(0, 50);
  writeState({ history });
}

module.exports = {
  STATE_FILE,
  TRIGGERS,
  ensureDir,
  readState,
  writeState,
  trigger,
  consumeTrigger,
  pendingTriggers,
  appendHistory,
  emptyState,
};