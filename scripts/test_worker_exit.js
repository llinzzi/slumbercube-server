const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Run the daemon in isolation: no real processes, files, or timers.
let state = { history: [] };
let child;
const removed = [];
const queue = {
  STATE_FILE: '/fake/state', ensureDir() {},
  readState: () => state,
  writeState: value => { state = { ...state, ...value }; },
  appendHistory: value => { state.history.push(value); },
};
const context = {
  require: name => {
    if (name === './dj_queue') return queue;
    if (name === 'fs') return { writeFileSync() {}, unlinkSync(file) { removed.push(file); }, appendFileSync() {} };
    if (name === 'child_process') return { spawn() {
      child = new EventEmitter();
      child.pid = 123;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    } };
    return require(name);
  },
  __dirname, module: { exports: {} },
  process: { env: {}, execPath: process.execPath, pid: 1, on() {}, stdout: { write() {} }, stderr: { write() {} } },
  setInterval() {}, setTimeout() {},
};
vm.runInNewContext(fs.readFileSync(__dirname + '/dj_worker.js', 'utf8'), context);
assert.ok(removed.some(file => file.endsWith('/.cancel')), 'boot clears stale cancellation');
for (const [code, expected] of [[0, 'done'], [1, 'failed'], [130, 'cancelled']]) {
  context.module.exports.startJob('evening');
  assert.equal(state.state, 'running');
  child.emit('exit', code, null);
  assert.equal(state.state, expected);
  assert.equal(state.pid, null);
}
context.module.exports.startJob('evening');
const before = state.history.length;
child.emit('error', new Error('spawn failed'));
child.emit('exit', 1, null);
assert.equal(state.state, 'failed');
assert.equal(state.history.length, before + 1);
console.log('PASS: success, failure, cancellation, spawn error and single finalization');
