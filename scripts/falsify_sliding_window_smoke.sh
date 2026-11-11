#!/usr/bin/env bash
# NEXUS D937 — falsifier for sliding_window_smoke.sh.
#
# The main smoke proves the source Lua's sliding SWEEP (ZREMRANGEBYSCORE) makes the window RESET once a
# full W has passed: the burst is held to N, and a hit a window later sees the old scores dropped (ZCARD
# falls back to 1) so the principal is not locked out forever.
#
# This arm removes EXACTLY that one command from the source-extracted script and replays the same schedule,
# requiring the "after a full window the old scores are swept" assertion to go RED. Without ZREMRANGEBYSCORE
# the ZSET is a monotonic accumulator: the refused burst hits stay in-range forever, the后来 hit sees ZCARD
# keep climbing, and the principal is throttled FOREVER — the failure mode sliding exists to remove. The red
# is attributable to one deleted line: every other byte of the script, the schedule, the injected nowMs and
# the live Redis are identical.
#
# Exit 0 = without the sweep the window never resets (the reset assertion is load-bearing) => falsifiable.
# Exit 1 = the sweep-less script still reset (the assertion cannot fail) => do not claim D937.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$ROOT/services/platform/src/main/java/com/nexus/platform/KeyValueStore.java"
LIMIT=2
W=60000
KEY="sw:falsify:$$"
CTRL="sw:falsify:control:$$"
fail() { echo "FAIL: $*" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || { echo "SKIP: nexus-platform-redis not reachable — cannot run the live falsifier"; exit 2; }
[ -f "$STORE" ] || fail "KeyValueStore.java not found at $STORE"

# Extract the source Lua, then DELETE the ZREMRANGEBYSCORE statement (the sliding half of the claim).
FULL=$(python - "$STORE" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'SLIDING_WINDOW_LUA\s*=\s*(.*?);', src, re.S)
if not m:
    sys.exit("cannot isolate SLIDING_WINDOW_LUA")
lits = re.findall(r'"([^"]*)"', m.group(1))
if len(lits) < 4:
    sys.exit("expected four concatenated string literals, got %d" % len(lits))
print(''.join(lits), end='')
PY
) || fail "could not extract the Lua script from the source"

NO_SWEEP=$(printf '%s' "$FULL" | python -c '
import sys, re
s = sys.stdin.read()
# Delete exactly the ZREMRANGEBYSCORE call. Everything else stays byte-identical, so the red is attributable
# to the sliding sweep alone, not to a broken ZADD/ZCARD/PEXPIRE.
s2 = re.sub(r"redis\.call\([^)]*ZREMRANGEBYSCORE[^)]*\)\s*", "", s)
assert s2 != s, "ZREMRANGEBYSCORE statement was not found in the source script"
assert "ZREMRANGEBYSCORE" not in s2, "the sweep survived removal"
for cmd in ("ZADD", "ZCARD", "PEXPIRE"):
    assert cmd in s2, "the control lost %s too — the red would not be attributable to the sweep alone" % cmd
print(s2, end="")
') || fail "could not remove the ZREMRANGEBYSCORE statement"
echo "== source Lua with the sliding sweep deleted =="
echo "==   $NO_SWEEP =="

cleanup() { redis DEL "$KEY" "$CTRL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
redis DEL "$KEY" "$CTRL" >/dev/null 2>&1 || true

ev() { # script key nowMs member -> post-append ZCARD
  local script="$1" k="$2" now="$3" m="$4" cutoff=$(( $3 - W ))
  redis EVAL "$script" 1 "$k" "$cutoff" "$now" "$m" "$W" | tr -d '\r'
}

# Replay a refused burst, then a hit a full window later. The burst criterion is the SAME as the main smoke.
BURST=("$((W-1))" "$((W-1))" "$W" "$W" "$((W+1))")
REOPEN=$((2*W+1))

echo "== SWEEP-LESS script: burst, then a hit a full window later =="
seq_i=0
for now in "${BURST[@]}"; do
  seq_i=$((seq_i + 1))
  c=$(ev "$NO_SWEEP" "$KEY" "$now" "sw-f-$seq_i")
  echo "  now=$now -> ZCARD=$c"
done
c_no_sweep=$(ev "$NO_SWEEP" "$KEY" "$REOPEN" "sw-f-reopen")
echo "  now=$REOPEN (a full window later) -> ZCARD=$c_no_sweep"
# WITHOUT the sweep the old scores are never dropped, so ZCARD keeps climbing past 1: the window NEVER resets.
[ "$c_no_sweep" -gt 1 ] || fail "sweep-less script reset to ZCARD=$c_no_sweep — the sweep was NOT the load-bearing line"

echo "== INTACT source script on a control key: the same hit a full window later resets to 1 =="
seq_i=0
for now in "${BURST[@]}"; do
  seq_i=$((seq_i + 1))
  c=$(ev "$FULL" "$CTRL" "$now" "sw-c-$seq_i")
  echo "  now=$now -> ZCARD=$c"
done
c_intact=$(ev "$FULL" "$CTRL" "$REOPEN" "sw-c-reopen")
echo "  now=$REOPEN -> ZCARD=$c_intact"
[ "$c_intact" -eq 1 ] || fail "the intact script did NOT reset to ZCARD=1 (got $c_intact) — the control is not clean"

echo "PASS: with the sweep deleted the window never resets (ZCARD=$c_no_sweep > 1 = permanent throttling) while the intact script resets to 1 — D937's sliding claim is falsifiable"
