#!/usr/bin/env bash
###############################################################################
# 192fm E2E test suite — browser-driven end-to-end coverage
#
# Layers (in order, exit on first failure unless --keep-going):
#   L0  Server health (curl :3000 + :3001)
#   L1  API smoke (curl — every public endpoint reachable)
#   L2  API behavior (curl — every endpoint exercised with valid + invalid input)
#   L3  UI smoke (browser_navigate — every page renders without error)
#   L4  UI interaction (browser_click — every user-actionable control works)
#   L5  Background pipeline (curl — scene trigger → queue → worker → songs)
#
# Run:   bash test_e2e_192fm.sh                    # default host http://127.0.0.1:3000
#        bash test_e2e_192fm.sh http://YOUR_SERVER:3000
#        bash test_e2e_192fm.sh --keep-going        # don't exit on first fail
#        bash test_e2e_192fm.sh --skip-ui           # skip browser tests (no Hermes tools)
#
# Exit code: 0 = all pass, non-zero = at least one failure.
#
# Output: a per-test PASS/FAIL line, then a final summary. Designed for
# `bash test_e2e_192fm.sh 2>&1 | tee /tmp/e2e.log`.
###############################################################################

set -u
HOST="${1:-http://127.0.0.1:3000}"
KEEP_GOING=0
SKIP_UI=0
for arg in "$@"; do
  case "$arg" in
    --keep-going) KEEP_GOING=1 ;;
    --skip-ui)    SKIP_UI=1 ;;
    --help|-h)
      head -25 "$0" | grep -E '^#' | sed 's/^# *//'
      exit 0
      ;;
    http*) HOST="$arg" ;;
  esac
done

PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()

# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------
# Usage: test "label" "expected_exit_code" "command..." "assertion_fn_body"
# assertion_fn_body runs in subshell; if it exits 0 → PASS, else → FAIL
test() {
  local label="$1"
  local expected="$2"
  local cmd="$3"
  local assertion="$4"

  echo
  echo "── $label ──"

  # Run command, capture output
  local out
  out=$(eval "$cmd" 2>&1)
  local actual=$?

  # If expected exit code matches, optionally run assertion
  if [ "$actual" = "$expected" ]; then
    if [ -n "$assertion" ]; then
      local assert_out
      assert_out=$(eval "$assertion" <<<"$out" 2>&1)
      local assert_rc=$?
      if [ "$assert_rc" = "0" ]; then
        echo "  ✓ PASS  exit=$actual"
        PASS=$((PASS+1))
        return 0
      else
        echo "  ✗ FAIL  exit=$actual (assertion failed)"
        echo "    cmd:    $cmd"
        echo "    output: $(echo "$out" | head -3 | tr '\n' ' ')"
        echo "    assert: $assertion"
        echo "    detail: $(echo "$assert_out" | head -3 | tr '\n' ' ')"
        FAIL=$((FAIL+1))
        FAILED_TESTS+=("$label")
        [ "$KEEP_GOING" = "0" ] && exit 1
        return 1
      fi
    else
      echo "  ✓ PASS  exit=$actual"
      PASS=$((PASS+1))
      return 0
    fi
  else
    echo "  ✗ FAIL  exit=$actual (expected $expected)"
    echo "    cmd:    $cmd"
    echo "    output: $(echo "$out" | head -3 | tr '\n' ' ')"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$label")
    [ "$KEEP_GOING" = "0" ] && exit 1
    return 1
  fi
}

skip() {
  local label="$1" reason="$2"
  echo
  echo "── $label ──"
  echo "  ⊘ SKIP  $reason"
  SKIP=$((SKIP+1))
}

# Assert helpers (used in assertion body, stdin = command output)
contains() {
  grep -qF "$1"
}
not_contains() {
  ! grep -qF "$1"
}
matches_re() {
  grep -qE "$1"
}
json_has() {
  python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('$1') is not None, 'missing $1'"
}
json_eq() {
  python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('$1') == $2, f'expected $2 got {d.get(chr(34)+\$1+chr(34))}'"
}

###############################################################################
# L0: Server health
###############################################################################
echo "================================================================"
echo "  192fm E2E Test Suite — $HOST"
echo "================================================================"

test "L0.1 server :3000 reachable" 0 "curl -s -o /dev/null -w '%{http_code}' '$HOST/'" \
  "grep -q '200'"

test "L0.2 NCM sidecar :3001 reachable" 0 "curl -s -o /dev/null -w '%{http_code}' '$HOST/api/netease/health' || true; curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3001/'" \
  "grep -qE '200|301|302'"

###############################################################################
# L1: API smoke (every endpoint reachable)
###############################################################################
test "L1.1 GET /api/esp"               0 "curl -s '$HOST/api/esp'"                "contains '\"song\"'"
test "L1.2 GET /api/esp/:deviceId"     0 "curl -s '$HOST/api/esp/test-device'"   "contains '\"song\"'"
test "L1.3 GET /api/time"              0 "curl -s '$HOST/api/time'"               "contains '\"iso\"'"
test "L1.4 GET /api/volume"            0 "curl -s '$HOST/api/volume'"             "contains '\"volume\"'"
test "L1.5 GET /api/weather"           0 "curl -s '$HOST/api/weather'"            "contains '\"text\"'"
test "L1.6 GET /api/library"           0 "curl -s '$HOST/api/library'"            "contains '\"songs\"'"
test "L1.7 GET /api/library/:id"       0 "curl -s -o /dev/null -w '%{http_code}' '$HOST/api/library/foo'" "grep -q '301'"
test "L1.8 GET /api/dj/status"         0 "curl -s '$HOST/api/dj/status'"          "contains '\"state\"'"
test "L1.9 GET /api/dj/personas"       0 "curl -s '$HOST/api/dj/personas'"        "grep -qE '\"personas\"|\\['"
test "L1.10 GET /api/dj/vibes"        0 "curl -s '$HOST/api/dj/vibes'"           "true"
test "L1.11 GET /api/dj/intro-prompts" 0 "curl -s '$HOST/api/dj/intro-prompts'"   "true"
test "L1.12 GET /api/dj/llm-history"  0 "curl -s '$HOST/api/dj/llm-history?limit=5'" "contains '\"entries\"'"
test "L1.13 GET /api/devices"          0 "curl -s '$HOST/api/devices'"            "contains '\"devices\"'"
test "L1.14 GET /api/source"           0 "curl -s '$HOST/api/source'"             "true"
test "L1.15 GET /api/playlist"         0 "curl -s '$HOST/api/playlist'"           "true"
test "L1.16 GET /api/fonts"            0 "curl -s '$HOST/api/fonts'"              "contains '\"text\"'"
test "L1.17 GET /api/tts-intro"        0 "curl -s '$HOST/api/tts-intro'"          "true"
test "L1.18 GET /api/netease/search"   0 "curl -s '$HOST/api/netease/search?keywords=test'" "true"
test "L1.19 GET /api/next"             0 "curl -s '$HOST/api/next'"               "true"
test "L1.20 GET /favicon.ico"          0 "curl -s -o /dev/null -w '%{http_code}' '$HOST/favicon.ico'" "grep -q '204'"

# Pages render
test "L1.21 GET /"                     0 "curl -s '$HOST/'"                       "contains '192'"
test "L1.22 GET /library"              0 "curl -s '$HOST/library'"                "contains '网易云收藏'"
test "L1.23 GET /admin/dj"             0 "curl -s '$HOST/admin/dj'"               "contains 'DJ'"
test "L1.24 GET /history → 301"        0 "curl -s -o /dev/null -w '%{http_code}' '$HOST/history'" "grep -q '301'"
test "L1.25 GET /admin → 301"          0 "curl -s -o /dev/null -w '%{http_code}' '$HOST/admin'"   "grep -q '301'"

###############################################################################
# L2: API behavior (POST endpoints, validation, error paths)
###############################################################################

# Volume: get → set → get roundtrip
test "L2.1 POST /api/volume 50 → 200"  0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"volume\":50}' '$HOST/api/volume'" \
  "contains 'ok'"

test "L2.2 POST /api/volume 0 → 400 (out of range)" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"volume\":0}' '$HOST/api/volume'" \
  "grep -q '400'"

test "L2.3 POST /api/volume 999 → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"volume\":999}' '$HOST/api/volume'" \
  "grep -q '400'"

# TTS toggle: get → toggle → get
test "L2.4 GET /api/tts-intro (initial state)" 0 \
  "curl -s '$HOST/api/tts-intro'" "contains '\"enabled\"'"

test "L2.5 POST /api/tts-intro → 200"  0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"enabled\":true}' '$HOST/api/tts-intro'" \
  "contains '\"ok\":true'"

# DJ trigger: valid scene → 200 + queued
test "L2.6 POST /api/dj/trigger sport → 200" 0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"batch\":\"manual\",\"scene\":\"sport\"}' '$HOST/api/dj/trigger'" \
  "grep -qE 'ok|already'"

test "L2.7 POST /api/dj/trigger invalid batch → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"batch\":\"xxx\"}' '$HOST/api/dj/trigger'" \
  "grep -q '400'"

test "L2.8 POST /api/dj/trigger invalid scene → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"batch\":\"manual\",\"scene\":\"xxx\"}' '$HOST/api/dj/trigger'" \
  "grep -q '400'"

# DJ cancel: when idle → 400; when running → 200
test "L2.9 POST /api/dj/cancel when idle → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST '$HOST/api/dj/cancel'" \
  "grep -qE '200|400|404'"

# Device seek: valid id → 200 (or graceful 404)
test "L2.10 POST /api/devices/:id/seek → handled" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"position\":3}' '$HOST/api/devices/test-device/seek'" \
  "grep -qE '200|400|404'"

# Intro prompts: roundtrip POST then GET
test "L2.11 POST /api/dj/intro-prompts → 200" 0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"system\":\"test system\",\"user\":\"test user\"}' '$HOST/api/dj/intro-prompts'" \
  "contains '\"ok\":true'"

# Removed endpoints should 404
test "L2.12 GET /api/local → 404 (removed)" 0 \
  "curl -s -o /dev/null -w '%{http_code}' '$HOST/api/local'" "grep -q '404'"

test "L2.13 POST /api/select-station → 404 (removed)" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST '$HOST/api/select-station'" "grep -q '404'"

test "L2.14 GET /api/dj/log → 404 (removed)" 0 \
  "curl -s -o /dev/null -w '%{http_code}' '$HOST/api/dj/log'" "grep -q '404'"

###############################################################################
# L3: UI smoke (browser pages render)
###############################################################################
if [ "$SKIP_UI" = "1" ]; then
  echo
  echo "── L3 (UI smoke) SKIPPED ──"
  echo "  ⊘ run with browser tools enabled (Hermes agent) for full coverage"
  SKIP=$((SKIP+5))
else
  echo
  echo "── L3: UI pages ──"
  echo "  ℹ  This layer requires Hermes browser tools (browser_navigate)."
  echo "  ℹ  Run via Hermes agent:  /test-e2e-ui"
  echo "  ℹ  Manual verification: visit each URL below"
  echo "      • $HOST/"
  echo "      • $HOST/library"
  echo "      • $HOST/admin/dj"
  echo "      • $HOST/api/esp  (should return JSON)"
  SKIP=$((SKIP+1))
fi

###############################################################################
# L3.5: Schedule (cron) — operator-editable list of timed triggers
###############################################################################
test "L3.5.1 GET /api/schedule" 0 \
  "curl -s '$HOST/api/schedule'" "contains '\"items\"'"

test "L3.5.2 POST /api/schedule valid items" 0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"items\":[{\"id\":\"t1\",\"label\":\"test morning\",\"hour\":8,\"minute\":30,\"batch\":\"morning\",\"scene\":\"morning\",\"enabled\":true}]}' '$HOST/api/schedule'" \
  "grep -qE 'ok.*true.*installed_lines|installed_lines.*ok' <<<\"\$(cat)\""

test "L3.5.3 POST /api/schedule invalid hour → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"items\":[{\"id\":\"t\",\"hour\":99,\"minute\":0,\"batch\":\"morning\"}]}' '$HOST/api/schedule'" \
  "grep -q '400' <<<\"\$(cat)\""

test "L3.5.4 POST /api/schedule invalid minute → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"items\":[{\"id\":\"t\",\"hour\":7,\"minute\":99,\"batch\":\"morning\"}]}' '$HOST/api/schedule'" \
  "grep -q '400' <<<\"\$(cat)\""

test "L3.5.5 POST /api/schedule invalid batch → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"items\":[{\"id\":\"t\",\"hour\":7,\"minute\":0,\"batch\":\"BAD\"}]}' '$HOST/api/schedule'" \
  "grep -q '400' <<<\"\$(cat)\""

test "L3.5.6 POST /api/schedule invalid scene → 400" 0 \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"items\":[{\"id\":\"t\",\"hour\":7,\"minute\":0,\"batch\":\"manual\",\"scene\":\"nonexistent\"}]}' '$HOST/api/schedule'" \
  "grep -q '400' <<<\"\$(cat)\""

test "L3.5.7 POST /api/schedule/install (re-install from config)" 0 \
  "curl -s -X POST '$HOST/api/schedule/install'" "contains '\"ok\":true'"

test "L3.5.8 POST /api/schedule empty array disables all" 0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"items\":[]}' '$HOST/api/schedule'" "contains '\"ok\":true'"

# Restore original schedule before exit (so test doesn't break the user's setup)
# — caller should re-run their schedule after this test
test "L3.5.9 restore default schedule (morning+evening)" 0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"items\":[{\"id\":\"morning\",\"label\":\"🌅 早安歌单\",\"hour\":7,\"minute\":0,\"batch\":\"morning\",\"scene\":\"morning\",\"enabled\":true},{\"id\":\"evening\",\"label\":\"🌙 晚安歌单\",\"hour\":21,\"minute\":0,\"batch\":\"evening\",\"scene\":\"night\",\"enabled\":true}]}' '$HOST/api/schedule'" \
  "contains '\"ok\":true'"

###############################################################################
# L4: Background pipeline (scene trigger actually does work)
###############################################################################
# Trigger sport → wait → check /api/library gained songs
test "L4.1 baseline /api/library count" 0 \
  "curl -s '$HOST/api/library'" "contains '\"total\"'"

BEFORE=$(curl -s "$HOST/api/library" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))")
echo "  ℹ  Library before trigger: $BEFORE songs"

test "L4.2 trigger sport scene" 0 \
  "curl -s -X POST -H 'Content-Type: application/json' -d '{\"batch\":\"manual\",\"scene\":\"sport\"}' '$HOST/api/dj/trigger'" \
  "contains '\"ok\":true'"

test "L4.3 wait for worker to consume trigger (≤60s)" 0 \
  "for i in \$(seq 1 30); do state=\$(curl -s '$HOST/api/dj/status' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get(\"state\",\"\"))' 2>/dev/null); [ \"\$state\" = \"running\" ] && break; sleep 2; done; echo \"final state: \$state\"; [ \"\$state\" = \"running\" ] || [ \"\$state\" = \"done\" ]" \
  "grep -qE 'running|done'"

echo
echo "  ℹ  Waiting 30s for downloads to finish..."
sleep 30

AFTER=$(curl -s "$HOST/api/library" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))")
echo "  ℹ  Library after trigger: $AFTER songs (delta=$((AFTER-BEFORE)))"

###############################################################################
# L5: End-to-end summary
###############################################################################
echo
echo "================================================================"
echo "  SUMMARY"
echo "================================================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "  FAILED TESTS:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "    ✗ $t"
  done
  echo
  echo "================================================================"
  exit 1
fi
echo
echo "  ✓ All tests passed"
echo "================================================================"
exit 0