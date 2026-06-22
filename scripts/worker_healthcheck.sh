#!/bin/bash
# Worker health check — if worker.log hasn't been updated in 180s AND state=running, restart worker.
# This prevents silent epoll stalls.

LOG=/tmp/dj_worker.log
WORKER_PID_FILE=/home/zulin/radio_streams/.radio_playlist/worker.pid
STATE=/home/zulin/radio_streams/.radio_playlist/queue_state.json
PROJECT=/home/zulin/radio_streams
LOCK=/tmp/worker_healthcheck.lock

# Skip if a healthcheck is already running
if [ -f "$LOCK" ]; then
  exit 0
fi
touch "$LOCK"
trap "rm -f $LOCK" EXIT

if [ ! -f "$LOG" ]; then
  exit 0
fi

# If state != running, worker may be idle (that's fine)
if [ -f "$STATE" ]; then
  STATE_VAL=$(python3 -c "import json; print(json.load(open('$STATE')).get('state',''))" 2>/dev/null)
  if [ "$STATE_VAL" != "running" ]; then
    exit 0
  fi
fi

# State is running — check if log has new line in 180s
LAST_MOD=$(stat -c %Y "$LOG" 2>/dev/null)
NOW=$(date +%s)
AGE=$((NOW - LAST_MOD))

if [ "$AGE" -gt 180 ]; then
  echo "[healthcheck $(date -u +%FT%TZ)] worker.log stale for ${AGE}s while state=running — restarting worker"
  pkill -9 -f 'node scripts/dj_worker.js' 2>/dev/null
  sleep 1
  cd "$PROJECT"
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nohup node scripts/dj_worker.js > "$LOG" 2>&1 &
  disown
fi
