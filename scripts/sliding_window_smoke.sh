#!/usr/bin/env bash
# NEXUS D937 — the Redis-ZSET sliding window closes fixed-window's BOUNDARY BURST, measured on the wire.
#
#   1. extract SLIDING_WINDOW_LUA from KeyValueStore.java (the ACTUAL script the Java path evals,
#      not a copy that could drift) by parsing its four concatenated string literals
#   2. FIXED window model on live Redis: limit N per W, split across the W boundary —
#      N hits land in bucket [0,W) and N hits land in bucket [W,2W). Two INCREDs on two bucket keys
#      both succeed => 2N admitted in a ~1ms span. That is the burst D932's fixed window cannot remove.
#   3. SLIDING window on live Redis: feed the SAME hit schedule (two at t=W-1, then more straddling W)
#      through the source Lua, with nowMs INJECTED so the boundary is exact and no sleeping is needed.
#      Because the sweep drops only scores <= now-W, the two t=W-1 hits stay in-range past the boundary
#      and the window admits at most N in ANY W-wide interval — NOT 2N.
#   4. assert sliding_admitted <= N < fixed_admitted == 2N, that the ZSET member count equals the admitted
#      hits, and that a hit W later sweeps the old scores so the window can admit again (no permanent lockout).
#
# The FALSIFIER is scripts/falsify_sliding_window_smoke.sh: it drops the ZREMRANGEBYSCORE sweep from the
# source Lua (the sliding half) and requires the exact SAME burst assertion to go RED — showing the green
# is attributable to the sliding sweep, not to a test that cannot fail.
#
# NOT CLAIMED: production throughput, a distributed/atomic-across-nodes guarantee beyond Redis's single
# thread, the fallback tier's latency, or that the edge gateway's D917 token bucket uses this store (it does
# not — that is a separate per-instance limiter). nowMs is injected by the TEST; production uses wall-clock.
#
# Usage:  bash scripts/sliding_window_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$ROOT/services/platform/src/main/java/com/nexus/platform/KeyValueStore.java"
LIMIT=2
W=60000                      # window, ms
KEY_FIXED_EARLY="sw:fixed:early:$$"
KEY_FIXED_LATE="sw:fixed:late:$$"
KEY_SLIDING="sw:sliding:$$"
LOG_DIR="${TMPDIR:-/tmp}/nexus-sliding-window"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380"
[ -f "$STORE" ] || fail "KeyValueStore.java not found at $STORE"

# Extract the five string literals of SLIDING_WINDOW_LUA and concatenate them exactly as javac does.
SCRIPT=$(python - "$STORE" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'SLIDING_WINDOW_LUA\s*=\s*(.*?);', src, re.S)
if not m:
    sys.exit("cannot isolate SLIDING_WINDOW_LUA")
literals = re.findall(r'"([^"]*)"', m.group(1))
if len(literals) < 4:
    sys.exit("expected four concatenated string literals, got %d" % len(literals))
print(''.join(literals), end='')
PY
) || fail "could not extract the Lua script from the source"
echo "== source Lua script: $SCRIPT =="
for cmd in ZREMRANGEBYSCORE ZADD ZCARD PEXPIRE; do
  echo "$SCRIPT" | grep -q "$cmd" || fail "the source script does not issue $cmd"
done

cleanup() { redis DEL "$KEY_FIXED_EARLY" "$KEY_FIXED_LATE" "$KEY_SLIDING" >/dev/null 2>&1 || true; }
trap cleanup EXIT
redis DEL "$KEY_FIXED_EARLY" "$KEY_FIXED_LATE" "$KEY_SLIDING" >/dev/null 2>&1 || true

# ---- FIXED window: two independent bucket keys either side of the boundary both fill to limit ----
# A fixed window keys its counter by the BUCKET (floor(now/W)), so the bucket at [0,W) and the bucket at
# [W,2W) are separate counters. N right before the edge + N right after => 2N admitted in ~1ms.
echo "== FIXED window: limit=$LIMIT per W=$W ms, split across the boundary =="
fixed_admitted=0
for i in $(seq 1 "$LIMIT"); do
  n=$(redis INCR "$KEY_FIXED_EARLY" | tr -d '\r')
  [ "$n" -le "$LIMIT" ] && fixed_admitted=$((fixed_admitted + 1))
done
for i in $(seq 1 "$LIMIT"); do
  n=$(redis INCR "$KEY_FIXED_LATE" | tr -d '\r')
  [ "$n" -le "$LIMIT" ] && fixed_admitted=$((fixed_admitted + 1))
done
echo "  fixed window admitted $fixed_admitted (= 2 x limit=$LIMIT) across the boundary"
[ "$fixed_admitted" -eq $((2 * LIMIT)) ] || fail "fixed model admitted $fixed_admitted, expected 2 x $LIMIT"

# ---- SLIDING window: the SAME schedule through the source Lua, with nowMs injected ----
# Schedule (ms): W-1, W-1, W, W+1, ... Every hit is a distinct member so two in the same ms are two hits.
# At t=W: cutoff = W-W = 0, the two t=W-1 scores (> 0) stay in-range => count 3 > limit, refused.
echo "== SLIDING window: the SAME burst schedule through the source Lua (nowMs injected) =="
slide() { # nowMs member -> echoes the post-append ZCARD from the real script
  local now="$1" m="$2" cutoff=$(( $1 - W ))
  redis EVAL "$SCRIPT" 1 "$KEY_SLIDING" "$cutoff" "$now" "$m" "$W" | tr -d '\r'
}
sliding_admitted=0
seq_i=0
# hits clustered right before and right after the boundary, inside a W-wide interval
for now in $((W-1)) $((W-1)) $((W)) $((W)) $((W+1)); do
  seq_i=$((seq_i + 1))
  c=$(slide "$now" "sw-m-$seq_i")
  echo "  now=$now member=sw-m-$seq_i -> ZCARD=$c"
  [ "$c" -le "$LIMIT" ] && sliding_admitted=$((sliding_admitted + 1))
done
echo "  sliding window admitted $sliding_admitted of 5 burst hits (limit=$LIMIT)"
[ "$sliding_admitted" -le "$LIMIT" ] || fail "sliding admitted $sliding_admitted > limit $LIMIT — the boundary burst was NOT closed"

# The ZSET really holds exactly the hits that were appended (all 5 were ZADDed, refused or not).
zc=$(redis ZCARD "$KEY_SLIDING" | tr -d '\r')
echo "  ZCARD=$zc after 5 appends"
[ "$zc" -eq 5 ] || fail "ZSET holds $zc members, expected 5 — the append/sweep semantics drifted"

# No permanent lockout: a hit a full window later sweeps the old scores (cutoff = 2W+1-W = W+1, which
# removes every score <= W+1) and the window can admit again.
echo "== a hit W later sweeps the old scores and reopens the window =="
c_later=$(slide $((2*W+1)) "sw-m-reopen")
echo "  now=$((2*W+1)) -> ZCARD=$c_later"
[ "$c_later" -eq 1 ] || fail "after the window slid, ZCARD=$c_later, expected 1 — old scores were not swept"
zc_after=$(redis ZCARD "$KEY_SLIDING" | tr -d '\r')
[ "$zc_after" -eq 1 ] || fail "ZSET holds $zc_after after the sweep, expected 1"
ttl=$(redis TTL "$KEY_SLIDING" | tr -d '\r')
[ "$ttl" -gt 0 ] || fail "sliding key carries no reclaiming ttl (TTL=$ttl)"

echo "PASS: fixed admitted 2xlimit=$fixed_admitted while sliding admitted <=limit=$sliding_admitted; the ZSET swept old scores and kept a ttl — D937 closes the boundary burst on the wire"
