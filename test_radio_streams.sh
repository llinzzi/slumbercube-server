#!/usr/bin/env bash
###############################################################################
# test_radio_streams.sh — smoke test for 192fm server
#
# 2026-06-21 refactor: 25-station switching removed; server exposes a single
# library directory. Old /api/local + per-station tests are gone — replaced
# with single-pool /api/library + /api/esp checks.
###############################################################################

HOST="${1:-http://localhost:3000}"
PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

jget() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "=== 192fm smoke test → $HOST ==="

# --- 1. Basic endpoints ---
RESP=$(curl -s --max-time 3 "$HOST/api/esp")
SONG=$(echo "$RESP" | jget "d.get('song','-')")
[ -n "$SONG" ] && [ "$SONG" != "None" ] && ok "/api/esp 返回 song=$SONG" || bad "/api/esp 没拿到 song"

RESP=$(curl -s --max-time 3 "$HOST/api/volume")
VOL=$(echo "$RESP" | jget "d.get('volume',-1)")
[ "$VOL" -ge 1 ] 2>/dev/null && [ "$VOL" -le 100 ] 2>/dev/null \
  && ok "/api/volume 在 1-100 之间 (=$VOL)" || bad "/api/volume = $VOL"

# --- 2. Library endpoint ---
RESP=$(curl -s --max-time 10 "$HOST/api/library")
TOTAL=$(echo "$RESP" | jget "d.get('total',0)")
[ "$TOTAL" -gt 0 ] 2>/dev/null && ok "/api/library total > 0 (=$TOTAL)" \
  || bad "/api/library total = $TOTAL"

# --- 3. /api/library/:id should redirect (was local station ids, now gone) ---
HTTP=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$HOST/api/library/foo")
[ "$HTTP" = "301" ] && ok "/api/library/:id → 301 重定向" \
  || bad "/api/library/:id → $HTTP (预期 301)"

# --- 4. Removed endpoints should be 404 ---
HTTP=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$HOST/api/local")
[ "$HTTP" = "404" ] && ok "/api/local 已删除 (404)" || bad "/api/local → $HTTP"

HTTP=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' -X POST "$HOST/api/select-station")
[ "$HTTP" = "404" ] && ok "/api/select-station 已删除 (404)" || bad "/api/select-station → $HTTP"

# --- 5. Timezone ---
RESP=$(curl -s --max-time 3 "$HOST/api/time")
[ -n "$RESP" ] && ok "/api/time 返回非空" || bad "/api/time 空响应"

echo
echo "=== 结果 ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
[ "$FAIL" = "0" ] && exit 0 || exit 1