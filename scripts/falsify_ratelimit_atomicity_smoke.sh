#!/usr/bin/env bash
# NEXUS D932 — falsifier for ratelimit_atomicity_smoke.sh.
#
# The main smoke proves the ONE-script path leaves a ttl. This arm reproduces the DEFECT that path
# closes: the legacy shape sent INCR and a SEPARATE EXPIRE. If the EXPIRE never lands (the crash/fault
# window between the two round trips), the counter survives with NO ttl -> a fixed-window bucket that
# never resets -> a permanent 429 for that principal. We model "EXPIRE did not land" by issuing only
# the INCR and never the EXPIRE, then assert TTL == -1 (Redis's "key exists, no expiry").
#
# Exit 0 = the lockout state is reproducible, so the atomic single-script claim is falsifiable.
# Exit 1 = the legacy split somehow still had a ttl (the model is wrong) — do not claim the fix.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="rl:legacy:falsify:$$"
TTL=30
fail() { echo "FAIL: $*" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || { echo "SKIP: nexus-platform-redis not reachable — cannot run the live falsifier"; exit 2; }

cleanup() { redis DEL "$KEY" >/dev/null 2>&1 || true; }
trap cleanup EXIT
redis DEL "$KEY" >/dev/null 2>&1 || true

echo "== legacy two-command shape: INCR lands, EXPIRE does NOT (the fault window) =="
n=$(redis INCR "$KEY" | tr -d '\r')
# Deliberately NO 'redis EXPIRE': that is the injected fault.
ttl=$(redis TTL "$KEY" | tr -d '\r')
echo "  INCR -> $n, TTL -> $ttl (Redis uses -1 for a key with no expiry)"
[ "$n" = "1" ] || fail "INCR returned $n, expected 1"
[ "$ttl" = "-1" ] || fail "TTL=$ttl, expected -1 — the TTL-less lockout state was NOT reproduced, so the claim is not falsifiable here"

# And show the atomic script does NOT produce that state, closing the loop.
STORE="$ROOT/services/platform/src/main/java/com/nexus/platform/KeyValueStore.java"
SCRIPT=$(python - "$STORE" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'INCR_AND_EXPIRE_LUA\s*=\s*(.*?);', src, re.S)
if not m: sys.exit("no INCR_AND_EXPIRE_LUA")
lits = re.findall(r'"([^"]*)"', m.group(1))
if len(lits) < 3: sys.exit("not three literals")
print(''.join(lits), end='')
PY
) || fail "could not extract the Lua script"
AKEY="rl:atomic:falsify:$$"
redis DEL "$AKEY" >/dev/null 2>&1 || true
an=$(redis EVAL "$SCRIPT" 1 "$AKEY" "$TTL" | tr -d '\r')
attl=$(redis TTL "$AKEY" | tr -d '\r')
redis DEL "$AKEY" >/dev/null 2>&1 || true
echo "  atomic EVAL -> $an, TTL -> $attl"
[ "$an" = "1" ] && [ "$attl" -gt 0 ] || fail "atomic script did not arm a ttl (INCR=$an TTL=$attl) — the fix is not demonstrated"

echo "PASS: the lockout is reproducible with the split (TTL=-1) and absent with the one-script path (TTL=$attl) — D932 is falsifiable"
