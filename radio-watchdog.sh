#!/bin/bash
# radio-streams watchdog
# Mirrors ncm-watchdog.sh pattern: a simple shell loop that brings the
# Node service back up if it dies, with no dependency on systemd/linger/
# tty/loginctl. Started detached from the spawning session (nohup+setsid
# + &) so it survives logout, with PPID=1 and SID/SID-of-self so the
# kernel keeps it around as a daemon-like process.
#
# Logs to /tmp/radio_watchdog.log — tail -f to watch it run.

set -u

LOG=/tmp/radio_watchdog.log
PROJ="$HOME/radio_streams"
START="$PROJ/restart.sh"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"
}

# Load nvm so `node` is on PATH for the restart script (it expects node
# in $PATH and the project uses nvm to pin Node 20).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# If the project directory is gone, there's nothing we can do.
if [ ! -x "$START" ]; then
  log "FATAL: $START not found or not executable — exiting"
  exit 1
fi

log "watchdog start, pid=$$"

last_restart=0

while :; do
  # Pgrep -f matches the full command line, so it sees "node server.js"
  # regardless of cwd. This is what we want.
  if pgrep -f "node server.js" > /dev/null 2>&1; then
    # Healthy. Sleep in small slices so a SIGTERM during shutdown has a
    # chance to be observed within ~5s.
    sleep 5
    continue
  fi

  now=$(date +%s)
  # Throttle: don't restart more than once every 30s. If restart.sh is
  # failing in a tight loop (bad code, port stuck, etc.) this stops us
  # from melting the box.
  if [ $((now - last_restart)) -lt 30 ]; then
    log "throttled — last restart ${now} - ${last_restart}s ago, sleeping 15"
    sleep 15
    continue
  fi
  last_restart=$now

  log "server.js not running — invoking restart.sh"
  if bash "$START" >> "$LOG" 2>&1; then
    log "restart.sh invoked ok"
  else
    log "restart.sh exited non-zero: $?"
  fi
  # Give Node a moment to bind :3000 before the next pgrep check so we
  # don't double-fire if startup is slow.
  sleep 3
done
