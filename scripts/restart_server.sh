#!/bin/bash
# Start radio_streams server (idempotent — kills any old process first)
set -e
cd /home/zulin/slumbercube-server
export PATH=/home/zulin/.nvm/versions/node/v20.20.2/bin:$PATH
export TZ=Asia/Shanghai

# Kill any existing node server.js — match both bare and absolute paths
for pid in $(pgrep -f 'node .*server\.js' 2>/dev/null); do
  if grep -q "$(pwd)/server.js\|server\.js" /proc/$pid/cmdline 2>/dev/null; then
    echo "Killing old server PID $pid"
    kill "$pid" 2>/dev/null || true
  fi
done
# Also kill anything bound to port 3000 just in case
for pid in $(ss -tlnp 2>/dev/null | awk '/:3000 /{print $NF}' | grep -oP 'pid=\K[0-9]+'); do
  echo "Killing PID $pid on :3000"
  kill "$pid" 2>/dev/null || true
done
sleep 2

# Verify port is free
if ss -tln | grep -q ':3000 '; then
  echo "ERROR: port 3000 still in use after kill"
  ss -tlnp | grep ':3000 '
  exit 1
fi

# Start fresh
nohup node server.js > server.log 2>&1 &
NEWPID=$!
echo "Started PID $NEWPID"
echo "$NEWPID" > server.pid

# Wait for boot
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ | grep -q 200; then
    echo "Ready in ${i}s"
    exit 0
  fi
  sleep 1
done
echo "Failed to start within 10s"
tail -20 server.log
exit 1
