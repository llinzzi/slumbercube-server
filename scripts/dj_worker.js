#!/usr/bin/env node
/**
 * dj_worker.js — DJ 工作队列守护进程
 *
 * 长期运行（nohup 守护），负责：
 *   1. 监听 .radio_playlist/.trigger_{morning,evening,manual} 文件
 *   2. 触发时启动 generate_playlist.js 子进程
 *   3. 把 child 进度写回 queue_state.json（web 读取）
 *   4. 接收 SIGTERM 优雅关闭（先 cancel child 再退出）
 *
 * 与 cron 配合：
 *   cron 不直接跑 generate_playlist.js（可能跑几个小时）
 *   cron 只 touch 一个 trigger 文件，本 daemon 看见 trigger 就启动 worker
 *
 * 启动方式：
 *   nohup node scripts/dj_worker.js > .radio_playlist/worker.log 2>&1 &
 *   停止: kill $(cat .radio_playlist/worker.pid)
 *
 * 或者用 npm script:
 *   npm run dj:start
 *   npm run dj:stop
 *   npm run dj:status
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const queue = require('./dj_queue');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLAYLIST_ROOT = path.join(PROJECT_ROOT, '.radio_playlist');
const STATE_FILE = queue.STATE_FILE;
const CANCEL_FILE = path.join(PLAYLIST_ROOT, '.cancel');
const WORKER_PID_FILE = path.join(PLAYLIST_ROOT, 'worker.pid');
const WORKER_LOG = path.join(PLAYLIST_ROOT, 'worker.log');
const GENERATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'generate_playlist.js');
const SCENE_FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'scene_fetch.js');
const BUILD_FROM_RESULT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'build_playlist_from_result.js');
const TRIGGER_POLL_MS = 2000;
const IDLE_FLUSH_MS = 5000;

let currentJob = null;  // { batch, child, startedAt }
let stopping = false;

function log(...args) {
  const line = `[dj-worker ${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  fs.appendFileSync(WORKER_LOG, line);
}

function ensureDir() { queue.ensureDir(); }

function writePidFile() {
  fs.writeFileSync(WORKER_PID_FILE, String(process.pid));
}

function clearPidFile() {
  try { fs.unlinkSync(WORKER_PID_FILE); } catch {}
}

function pickTrigger() {
  // Priority: manual > morning > evening
  for (const batch of ['manual', 'morning', 'evening']) {
    const trig = queue.consumeTrigger(batch);
    if (trig) return { batch, at: trig.at };
  }
  return null;
}

function startJob(batch, persona = null) {
  const child = spawn(process.execPath, [GENERATE_SCRIPT], {
    env: {
      ...process.env,
      DJ_BATCH: batch,
      DJ_PERSONA: persona || '',  // empty string = "let generate_playlist pick random"
      DJ_PROGRESS_FILE: STATE_FILE,
      DJ_CANCEL_FILE: CANCEL_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Initialize state file with "running" status (generate_playlist.js will overwrite)
  queue.writeState({
    state: 'running',
    batch,
    persona: persona || null,  // null = TBD (random)
    started_at: new Date().toISOString(),
    pid: child.pid,
    progress: { total: 0, current: 0, phase: 'starting', succeeded: 0, failed: 0 },
    result: null,
    pending_persona: null,  // consumed
    pending_scene: null,    // consumed (not relevant for AI batch)
  });

  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));

  attachExitHandler(child, { kind: 'generate', batch, persona });
  currentJob = { kind: 'generate', batch, child, startedAt: Date.now() };
  log(`Job started: ${batch} (PID ${child.pid})`);
}

/**
 * Spawn scene_fetch.js for a scene-timer playlist fetch. Behaviour:
 *   - exit 0 (success)         → mark done
 *   - exit 2 (dedup miss)      → spawn generate_playlist.js as fallback
 *   - exit 1 (hard error)      → mark failed
 * The fallback path preserves the old behaviour (AI picks from local
 * library) when no fresh NCM playlist is available.
 */
function startSceneFetchJob(scene, persona = null) {
  const child = spawn(process.execPath, [SCENE_FETCH_SCRIPT], {
    env: {
      ...process.env,
      DJ_SCENE: scene,
      DJ_PERSONA: persona || '',
      DJ_PROGRESS_FILE: STATE_FILE,
      DJ_CANCEL_FILE: CANCEL_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  queue.writeState({
    state: 'running',
    batch: 'scene-fetch',
    scene,
    persona: persona || null,
    started_at: new Date().toISOString(),
    pid: child.pid,
    progress: { total: 0, current: 0, phase: 'starting', succeeded: 0, failed: 0 },
    result: null,
    pending_persona: null,
    pending_scene: null,
  });

  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));

  // On dedup miss (exit 2) we fall back to the standard AI playlist
  // path. Spawn generate_playlist.js and let it run as if it were
  // a normal batch.
  child.on('exit', (code, signal) => {
    if (code === 2 && !signal) {
      log(`scene_fetch exited with dedup miss (code=2) for scene="${scene}" — falling back to generate_playlist.js`);
      // Pick a sensible batch key for the fallback. Use 'morning' /
      // 'evening' based on the scene's typical time slot; otherwise
      // 'manual'. The vibe prompt in generate_playlist is keyed off
      // DJ_BATCH, so this preserves the morning/evening personality.
      const fallbackBatch = scene === 'morning' ? 'morning' : scene === 'night' ? 'evening' : 'manual';
      startJob(fallbackBatch, persona);
      return;
    }
    if (code === 0 && !signal) {
      // Scene-fetch successfully downloaded an NCM playlist. Turn those
      // freshly downloaded songs into a stitched playlist that /api/esp
      // can serve — without this step the songs sit on disk but the
      // ESP keeps playing whatever playlist was current before (often
      // a stale morning 川川 playlist when the user just triggered
      // "sport" mid-day). Fire-and-forget so attachExitHandler can
      // mark the job done in the UI immediately; the build runs in
      // the background and updates current.json when finished.
      log(`scene_fetch succeeded for scene="${scene}" — spawning build_playlist_from_result.js`);
      const build = spawn(process.execPath, [BUILD_FROM_RESULT_SCRIPT], {
        env: {
          ...process.env,
          DJ_PROGRESS_FILE: STATE_FILE,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      build.stdout.on('data', d => process.stdout.write(`[build-bg] ${d}`));
      build.stderr.on('data', d => process.stderr.write(`[build-bg] ${d}`));
      // Once build finishes (success OR failure), run attachExitHandler
      // so the admin UI flips state='done' and progress=phase=done.
      const finalize = attachExitHandler(build, { kind: 'scene-fetch+build', batch: 'scene-fetch', scene, persona });
      build.on('exit', (bcode, bsignal) => {
        if (bcode === 0) {
          log(`build_playlist_from_result.js completed (PID ${build.pid})`);
        } else {
          log(`build_playlist_from_result.js exited code=${bcode} signal=${bsignal}`);
        }
        finalize(bcode, bsignal);
      });
      // Hold currentJob until build finishes so the cancel button
      // stays enabled across the whole trigger→play pipeline.
      currentJob = { kind: 'scene-fetch+build', scene, child: build, startedAt: Date.now() };
      // Don't fall through to attachExitHandler for the scene-fetch
      // child — we want its "running" state to persist while the build
      // is still alive. The exit handler is wired onto the build child
      // above.
      return;
    }
    // Any other exit (0 success with build above, or 1 hard error)
    // flows through the normal exit handler.
    attachExitHandler(child, { kind: 'scene-fetch', batch: 'scene-fetch', scene, persona })(code, signal);
  });

  currentJob = { kind: 'scene-fetch', scene, child, startedAt: Date.now() };
  log(`Scene-fetch job started: scene="${scene}" (PID ${child.pid})`);
}

/**
 * Return a function that, when bound to a child 'exit' event, updates
 * the queue state to its terminal form and appends a history entry.
 * We factor this out of the old inline handler so both startJob and
 * startSceneFetchJob can share it.
 */
function attachExitHandler(child, meta) {
  return (code, signal) => {
    const endedAt = new Date().toISOString();
    const finalState = queue.readState();
    const succeeded = finalState.progress ? (finalState.progress.succeeded || 0) : 0;
    const failed = finalState.progress ? (finalState.progress.failed || 0) : 0;
    const durationSec = currentJob
      ? Math.round((Date.now() - currentJob.startedAt) / 1000)
      : 0;

    let endState;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      endState = 'cancelled';
    } else if (code === 0) {
      endState = 'done';
    } else if (code === 130) {
      endState = 'cancelled';  // 128 + SIGINT
    } else {
      endState = 'failed';
    }

    const startedAtIso = currentJob ? new Date(currentJob.startedAt).toISOString() : null;
    log(`Job ${meta.kind}/${meta.batch || meta.scene} ended: code=${code} signal=${signal} → ${endState} (${succeeded} ok, ${failed} failed, ${durationSec}s)`);

    // Append to history (include persona so the UI can render avatars later;
    // include result.playlist_id/name for scene-fetch jobs so the曲目库 page
    // can recover which NCM playlist a given download came from).
    const existing = queue.readState();
    const histEntry = {
      batch: meta.batch,
      scene: meta.scene || null,
      kind: meta.kind,
      persona: finalState.persona || null,
      started_at: startedAtIso,
      ended_at: endedAt,
      state: endState,
      succeeded,
      failed,
      duration_sec: durationSec,
    };
    if (meta.kind === 'scene-fetch' && existing && existing.result) {
      histEntry.playlist_id = existing.result.playlist_id || null;
      histEntry.playlist_name = existing.result.playlist_name || null;
      histEntry.llm_keywords = !!existing.result.llm_keywords;
      histEntry.llm_picked = !!existing.result.llm_picked;
      histEntry.used_keywords = existing.result.used_keywords || [];
    }
    queue.appendHistory(histEntry);

    // Update final state (preserve result if generate_playlist.js wrote one)
    queue.writeState({
      state: endState,
      pid: null,
      result: existing.result || { error: `exit code ${code} signal ${signal}` },
    });

    // Cleanup cancel file
    try { fs.unlinkSync(CANCEL_FILE); } catch {}

    currentJob = null;
  };
}

function cancelCurrentJob(reason) {
  if (!currentJob) return false;
  log(`Cancel requested: ${reason}`);
  // Touch cancel file — generate_playlist.js checks it between songs
  try { fs.writeFileSync(CANCEL_FILE, reason); } catch {}
  // Also send SIGTERM (graceful, will break out of long mmx call)
  try { currentJob.child.kill('SIGTERM'); } catch {}
  return true;
}

function tick() {
  if (stopping) return;

  if (currentJob) {
    // Heartbeat: ensure state has updated_at refreshed every IDLE_FLUSH_MS
    // (generate_playlist.js writes when active, but we want liveness for "no progress in 5 min" detection)
    const state = queue.readState();
    if (state.state === 'running') {
      const age = Date.now() - new Date(state.updated_at).getTime();
      if (age > 60_000) {
        log(`WARNING: no state update for ${Math.round(age/1000)}s`);
      }
    }
    return;
  }

  // Idle — look for triggers
  const trig = pickTrigger();
  if (trig) {
    // Pull the pinned persona + scene off the state file (set by
    // dj_queue.trigger) and clear them so a subsequent trigger starts
    // fresh. scene may be null for backward-compat triggers that
    // pre-date the scene-timer work.
    const state = queue.readState();
    const persona = state.pending_persona || null;
    const scene = state.pending_scene || null;
    if (scene) log(`Trigger consumed: ${trig.batch} (created ${trig.at}) scene=${scene} persona=${persona || 'random'}`);
    else if (persona) log(`Trigger consumed: ${trig.batch} (created ${trig.at}) persona=${persona}`);
    else log(`Trigger consumed: ${trig.batch} (created ${trig.at}) persona=random`);

    if (scene) {
      startSceneFetchJob(scene, persona);
    } else {
      startJob(trig.batch, persona);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function handleSignal(sig) {
  log(`Received ${sig}, shutting down...`);
  stopping = true;
  if (currentJob) {
    cancelCurrentJob(`worker shutdown (${sig})`);
    // Give child 5s to clean up, then force-kill
    setTimeout(() => {
      if (currentJob) {
        try { currentJob.child.kill('SIGKILL'); } catch {}
      }
      finishShutdown();
    }, 5000);
  } else {
    finishShutdown();
  }
}

function finishShutdown() {
  clearPidFile();
  log('Worker exited cleanly');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
ensureDir();
writePidFile();
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('uncaughtException', e => log('UNCAUGHT:', e.stack || e.message));
process.on('exit', () => clearPidFile());

log(`Worker starting (PID ${process.pid})`);
log(`Watching: ${PLAYLIST_ROOT}/.trigger_{morning,evening,manual}`);

// Don't start a job if there was an interrupted one — wait for manual trigger
const initial = queue.readState();
if (initial.state === 'running') {
  log(`Detected interrupted run (state=running). Will not auto-restart; manual trigger required.`);
  // Mark as failed to clear stuck state
  queue.writeState({ state: 'failed', pid: null, result: { error: 'worker restarted mid-run' } });
}

// Main loop
setInterval(tick, TRIGGER_POLL_MS);

// Write idle state on startup so status endpoint works immediately
queue.writeState({
  state: 'idle',
  pid: process.pid,
  worker_started_at: new Date().toISOString(),
});

// Module exports for testing
module.exports = { startJob, startSceneFetchJob, cancelCurrentJob, handleSignal };