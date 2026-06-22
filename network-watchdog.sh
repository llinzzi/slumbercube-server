#!/bin/bash
###############################################################################
# network-watchdog.sh — 网卡开机自愈兜底
#
# 问题：192 是 QEMU/KVM 虚机 (MAC 52:54:00...)，DHCP 模式下重启偶发拿不到 IP，
#       网卡状态显示 DOWN 或 carrier on 但 L3 没起来，导致 SSH 不通。
#
# 解决：
#   1. 主方案 — 走 netplan 静态 IP（00-static-ens1.yaml），从根上不再依赖 DHCP
#   2. 兜底 — 这个脚本 开机后跑一次，每 10 秒检查：
#        - ens1 状态是不是 UP
#        - 有没有 192.168.8.192/24 这个 IP
#        - 能不能 ping 通网关 192.168.8.1
#      任意一项失败就重置 ens1（先 down 再 up），最多重试 5 次。
#
# 跑法：crontab @reboot /home/zulin/radio_streams/network-watchdog.sh
#
# 日志：/tmp/network_watchdog.log
###############################################################################

set -u

IFACE=ens1
EXPECTED_IP="192.168.8.192/24"
GATEWAY="192.168.8.1"
LOG=/tmp/network_watchdog.log
MAX_RETRIES=5
SLEEP_LOOP=10

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

has_ip() {
  ip -4 addr show dev "$IFACE" 2>/dev/null | grep -q "inet ${EXPECTED_IP} "
}

has_route() {
  ip route show default dev "$IFACE" 2>/dev/null | grep -q "via ${GATEWAY}"
}

is_up() {
  local state
  state=$(cat /sys/class/net/"$IFACE"/operstate 2>/dev/null || echo "unknown")
  [ "$state" = "up" ] || [ "$state" = "unknown" ]
}

can_ping_gateway() {
  ping -c 1 -W 2 "$GATEWAY" >/dev/null 2>&1
}

reset_iface() {
  log "Resetting $IFACE (down + up + dhclient fallback)..."
  sudo /sbin/ip link set "$IFACE" down 2>/dev/null || true
  sleep 2
  sudo /sbin/ip link set "$IFACE" up   2>/dev/null || true
  sleep 3
  # 如果配了静态 IP，netplan apply 一下；否则走 dhclient
  if [ -f /etc/netplan/00-static-ens1.yaml ]; then
    sudo /usr/sbin/netplan apply 2>>"$LOG" || true
  else
    sudo /sbin/dhclient -1 -v "$IFACE" >>"$LOG" 2>&1 || true
  fi
  sleep 3
}

check_once() {
  is_up && has_ip && has_route && can_ping_gateway
}

trap 'log "Watchdog received signal, exiting"; exit 0' SIGTERM SIGINT

log "=== network-watchdog started (PID=$$) on $IFACE ==="

# 开机刚启动时网卡可能还没就绪，先睡 15 秒
sleep 15

retries=0
while true; do
  if check_once; then
    if [ "$retries" -gt 0 ]; then
      log "Network healthy after ${retries} reset(s)"
    fi
    retries=0
  else
    retries=$((retries + 1))
    log "Health check failed (${retries}/${MAX_RETRIES})"
    log "  state=$(cat /sys/class/net/"$IFACE"/operstate 2>/dev/null)  has_ip=$(has_ip && echo yes || echo no)  has_route=$(has_route && echo yes || echo no)  ping_gw=$(can_ping_gateway && echo yes || echo no)"
    if [ "$retries" -le "$MAX_RETRIES" ]; then
      reset_iface
    else
      log "Reached max retries (${MAX_RETRIES}) — backing off to ${SLEEP_LOOP}s polling"
      sleep 60
      retries=0
    fi
  fi
  sleep "$SLEEP_LOOP"
done