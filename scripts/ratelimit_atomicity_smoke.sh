#!/usr/bin/env bash
# NEXUS D932 — the Redis limit-counter script, as written in the SOURCE, really leaves a ttl.
#
#   1. extract INCR_AND_EXPIRE_LUA from KeyValueStore.java (the ACTUAL string the Java path evals,
#      not a copy that could drift) by parsing its three concatenated literals
#   2. EVAL it once against the live nexus-platform-redis -> 1; TTL > 0 (the first write armed a window)
#   3. EVAL it again -> 2; TTL still > 0 but DECREASED (the second INCR did NOT re-arm the window)
#   4. assert the script body holds BOTH INCR and EXPIRE (one atomic operation, not two round trips)
#
# The crash/fault lockout that D932 closes is reproduced by falsify_ratelimit_atomicity_smoke.sh,
# which runs the legacy two-command shape and asserts the key ends up with TTL == -1 (no expiry).
#
# NOT CLAIMED: fixed-window's boundary burst (a ZSET sliding window is a separate seam), production
# throughput, or that the mock's injected EXPIRE fault is a live Redis bug. This smoke proves the
# SOURCE script's wire behaviour against a real server; the JUnit suite proves the Java call path.
#
# Usage:  bash scripts/ratelimit_atomicity_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$ROOT/services/platform/src/main/java/com/nexus/platform/KeyValueStore.java"
KEY="rl:atomic:smoke:$$"
TTL=30
LOG_DIR="${TMPDIR:-/tmp}/nexus-ratelimit-atomicity"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380"
[ -f "$STORE" ] || fail "KeyValueStore.java not found at $STORE"

# Extract the three string literals of INCR_AND_EXPIRE_LUA and concatenate them exactly as javac does.
SCRIPT=$(python - "$STORE" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'INCR_AND_EXPIRE_LUA\s*=\s*(.*?);', src, re.S)
if not m:
    sys.exit("cannot isolate INCR_AND_EXPIRE_LUA")
literals = re.findall(r'"([^"]*)"', m.group(1))
if len(literals) < 3:
    sys.exit("expected three concatenated string literals, got %d" % len(literals))
print(''.join(literals), end='')
PY
) || fail "could not extract the Lua script from the source"
echo "== source Lua script: $SCRIPT =="
echo "$SCRIPT" | grep -q "INCR" || fail "the source script does not INCR"
echo "$SCRIPT" | grep -q "EXPIRE" || fail "the source script does not EXPIRE (a counter could have no ttl)"

cleanup() { redis DEL "$KEY" >/dev/null 2>&1 || true; }
trap cleanup EXIT
redis DEL "$KEY" >/dev/null 2>&1 || true

echo "== EVAL #1 on live Redis (key=$KEY, ttl=$TTL) =="
n1=$(redis EVAL "$SCRIPT" 1 "$KEY" "$TTL" | tr -d '\r')
ttl1=$(redis TTL "$KEY" | tr -d '\r')
echo "  INCR -> $n1, TTL -> $ttl1"
[ "$n1" = "1" ] || fail "first EVAL returned $n1, expected 1"
[ "$ttl1" -gt 0 ] && [ "$ttl1" -le "$TTL" ] || fail "first write left TTL=$ttl1, expected (0, $TTL] — the counter exists without an expiry"

echo "== EVAL #2 (must count up, must NOT re-arm the window) =="
sleep 1
n2=$(redis EVAL "$SCRIPT" 1 "$KEY" "$TTL" | tr -d '\r')
ttl2=$(redis TTL "$KEY" | tr -d '\r')
echo "  INCR -> $n2, TTL -> $ttl2"
[ "$n2" = "2" ] || fail "second EVAL returned $n2, expected 2"
[ "$ttl2" -gt 0 ] || fail "second EVAL left no ttl"
[ "$ttl2" -lt "$ttl1" ] || fail "TTL did not decrease ($ttl1 -> $ttl2): the second INCR re-armed the window, it must not"

echo "PASS: the source's INCR+EXPIRE script is atomic on the wire — first write arms a ttl, the next INCR counts without re-arming"
