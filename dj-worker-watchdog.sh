#!/bin/bash
###############################################################################
# dj-worker-watchdog.sh — 守护 DJ worker（消费 trigger + 跑 generate_playlist）
#
# 问题：之前只有 radio-watchdog 和 ncm-watchdog 守护，dj_worker 没人管。
#       02:02:36 192 被按电源键关机重启后，server.js 和 NCM 都被拉起了，
#       但 dj_worker 没人拉 → 按钮点击后 trigger 写盘了没人消费，"点了没反应"。
#
# 解法：每 10s 检查 worker.log 是否在 60s 内有更新；queue_state.json 的
#       state 是否=running；pgrep 是否还能找到 worker 进程。三者不一致就拉起。
#
# 配合 crontab @reboot /home/zulin/radio_streams/dj-worker-watchdog.sh
#
# 日志：/tmp/dj_worker_watchdog.log
###############################################################################

set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

APP_DIR=/home/zulin/radio_streams
WORKER=$APP_DIR/scripts/dj_worker.js
WORKER_LOG=$APP_DIR/.radio_playlist/worker.log
STATE=$APP_DIR/.radio_playlist/queue_state.json
LOG=/tmp/dj_worker_watchdog.log
SLEEP_LOOP=10
LOG_STALE_SEC=60
BOOT_WARMUP=15

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

is_worker_running() {
  pgrep -f 'node scripts/dj_worker.js' >/dev/null 2>&1
}

restart_worker() {
  log "Starting dj_worker..."
  cd "$APP_DIR"
  # nvm 路径下 node 是真实二进制，替代 which node 找不到的问题
  local node_bin
  node_bin=$(command -v node 2>/dev/null || echo "")
  if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    node_bin="$HOME/.nvm/versions/node/v20.20.2/bin/node"
  fi
  if [ ! -x "$node_bin" ]; then
    log "ERROR: node binary not found at $node_bin"
    return 1
  fi
  log "Using node: $node_bin"
  nohup "$node_bin" scripts/dj_worker.js >> "$WORKER_LOG" 2>&1 &
  local pid=$!
  log "Spawned PID=$pid"
  # 等 5s 确认它没崩
  sleep 5
  if ! is_worker_running; then
    log "ERROR: dj_worker exited within 5s of start"
    return 1
  fi
  log "dj_worker is alive (PID=$pid)"
  return 0
}

trap 'log "Watchdog received signal, exiting"; exit 0' SIGTERM SIGINT

log "=== dj-worker-watchdog started (PID=$$) ==="

# 开机先睡一下，避免 NCM / radio 都还没起来就拉 worker
sleep "$BOOT_WARMUP"

while true; do
  if is_worker_running; then
    # worker 在跑 — 但要小心：state=running 但 log 长期没更新 = 假死
    if [ -f "$STATE" ]; then
      state_val=$(python3 -c "import json; print(json.load(open('$STATE')).get('state',''))" 2>/dev/null)
      if [ "$state_val" = "running" ] && [ -f "$WORKER_LOG" ]; then
        last_mod=$(stat -c %Y "$WORKER_LOG" 2>/dev/null || echo 0)
        now=$(date +%s)
        age=$((now - last_mod))
        if [ "$age" -gt "$LOG_STALE_SEC" ]; then
          log "Worker running but log stale for ${age}s — assuming stalled, restarting"
          pkill -9 -f 'node scripts/dj_worker.js' 2>/dev/null
          sleep 2
          restart_worker
        fi
      fi
    fi
  else
    log "dj_worker not running — starting"
    restart_worker
  fi
  sleep "$SLEEP_LOOP"
done