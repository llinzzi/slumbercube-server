#!/bin/bash
# 重启主进程。
# 日志写在项目内 .radio_playlist/server.log —— 不再用 /tmp（重启即丢、也可能被
# 系统清理），并在超过 10MB 时轮转成 server.log.1，只保留一代。
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd ~/slumbercube-server || exit 1

LOG=.radio_playlist/server.log
MAX_BYTES=$((10 * 1024 * 1024))

mkdir -p .radio_playlist

# 轮转（在起新进程之前做，避免和新进程抢同一个 fd）
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_BYTES" ]; then
  mv -f "$LOG" "$LOG.1"
fi

# 用 ^ 锚定命令行开头，避免匹配到"恰好包含 node server.js 字样"的包装 shell
# （比如 ssh host '... node server.js ...' 这种一次性命令，会被误杀）
pkill -f "^node server\.js" 2>/dev/null
sleep 1

# 一次性迁移：把之前写在 /tmp 的日志接过来，保持历史连续
if [ -s /tmp/radio_server.log ]; then
  cat /tmp/radio_server.log >> "$LOG"
  : > /tmp/radio_server.log
fi

nohup node server.js >> "$LOG" 2>&1 &
echo "Radio server restarted, PID: $! (log: $LOG)"
