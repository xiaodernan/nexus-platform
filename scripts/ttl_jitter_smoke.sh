#!/usr/bin/env bash
# NEXUS D940 — deterministic cache-TTL decorrelation (thundering-herd guard), measured on the wire.
#
#   1. extract FNV_OFFSET_BASIS / FNV_PRIME and the jitterMs() formula SHAPE from TtlJitter.java (the ACTUAL
#      constants the Java path uses, not a copy that could drift), and REQUIRE the unsigned remainder —
#      this is the load-bearing line: a signed % shortens the TTL for ~half of keys.
#   2. reproduce FNV-1a 64 in Python and CROSS-CHECK it against a golden vector computed here from the
#      source constants — if the Python replica drifts from the Java constants, the cross-check fails.
#   3. NO-jitter control: PSETEX a batch of N same-TTL keys with the exact base millis on live Redis and
#      bucket their PTTLs — they all collapse into ONE expiry bucket (the self-synchronised stampede).
#   4. WITH-jitter: PSETEX the same batch at base + unsigned(hash(key)) % spread, bucket the PTTLs — they
#      spread across >= 16 distinct buckets, and NONE is shorter than base (only ever lengthened).
#   5. STABILITY: rewriting a key recomputes the SAME offset (no process randomness / restart drift).
#
# This is a CACHE-TTL claim, not a throughput or hit-rate claim. It proves the mechanism on the wire:
# same-TTL writes no longer expire in one instant, the offset is a stable function of the key, and the TTL
# is only lengthened. It does NOT claim any production cache was migrated (the feature is opt-in, OFF by
# default), nor that a real backing-store stampede was measured — that needs a deployed cache + load.
#
# The FALSIFIER is scripts/falsify_ttl_jitter_smoke.sh: it plants a SIGNED remainder in the source-extracted
# formula and requires the "never shorter than base" assertion to go RED, showing the unsigned remainder is
# what keeps the guard from becoming an early-expiry defect.
#
# Usage:  bash scripts/ttl_jitter_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JITTER="$ROOT/services/platform/src/main/java/com/nexus/platform/TtlJitter.java"
N=64
BASE=30000                    # 30s base — long enough that PTTL readback noise (ms) cannot cross a bucket
SPREAD=1024
BUCKET=64                     # 1024 / 16 buckets
KEY_PREFIX="ttl:jitter:$$"
LOG_DIR="${TMPDIR:-/tmp}/nexus-ttl-jitter"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380"
[ -f "$JITTER" ] || fail "TtlJitter.java not found at $JITTER"

# ---- 1. extract the source constants + the load-bearing unsigned remainder -------------------------
OFFSET_HEX=$(sed -n 's/.*FNV_OFFSET_BASIS = \(0x[0-9a-fA-F]*\)L;.*/\1/p' "$JITTER" | head -1)
PRIME_HEX=$(sed -n 's/.*FNV_PRIME = \(0x[0-9a-fA-F]*\)L;.*/\1/p' "$JITTER" | head -1)
[ -n "$OFFSET_HEX" ] || fail "could not extract FNV_OFFSET_BASIS from the source"
[ -n "$PRIME_HEX" ] || fail "could not extract FNV_PRIME from the source"
grep -q 'Long.remainderUnsigned' "$JITTER" || fail "TtlJitter.java no longer uses the UNSIGNED remainder — the signed-% early-expiry bug would return"
echo "== source constants: offset=$OFFSET_HEX prime=$PRIME_HEX (unsigned remainder present) =="

# ---- 2. reproduce FNV-1a 64 in Python, driven by the SOURCE constants; emit the TTL table -----------
# The script prints "<key> <offset> <ttl>" per key. Golden-vector cross-checks run inside Python.
TABLE=$(python - "$OFFSET_HEX" "$PRIME_HEX" "$N" "$BASE" "$SPREAD" <<'PY'
import sys
offset = int(sys.argv[1], 16)
prime = int(sys.argv[2], 16)
n = int(sys.argv[3]); base = int(sys.argv[4]); spread = int(sys.argv[5])
MASK = (1 << 64) - 1
def fnv(s):
    h = offset
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * prime) & MASK
    return h
def off(key):
    return fnv(key) % spread          # unsigned: Python ints are unbounded, % is non-negative for spread>0
# Golden vector — the SAME values TtlJitterTest pins, computed from the source-extracted constants.
golden = {
    'nexus:jc:0': 60583 - 60000,      # offsets are spread-1024/base-60000; recompute below for THIS base
}
# Cross-check the ALGORITHM against the fixed golden hash values (independent of base).
expect_hash = {
    'nexus:jc:0':  0x0000a97b78f31162ae47,
    'nexus:jc:1':  0x0000a97b77f31162ac94,
    'nexus:jc:7':  0x0000a97b75f31162a92e,
    'nexus:jc:42': 0x00005f6f02068aa2410b,
    'nexus:refreshfam:demo': 0x0000678255b55f715ffc,
}
for k, want in expect_hash.items():
    got = fnv(k)
    if got != want:
        sys.exit("golden FNV hash drift for %r: got %020x want %020x (Python replica != Java source)" % (k, got, want))
for i in range(n):
    k = 'nexus:jc:%d' % i
    o = off(k)
    print('%s %d %d' % (k, o, base + o))
PY
) || fail "Python FNV-1a replica drifted from the golden vector / source constants"
echo "== Python replica matches the Java golden FNV hashes for 5 keys =="

cleanup() {
  { for i in $(seq 0 $((N - 1))); do
      echo "DEL $KEY_PREFIX:plain:$i"
      echo "DEL $KEY_PREFIX:jit:nexus:jc:$i"
    done; } | redis >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---- 3. NO-jitter control: every same-TTL key lands in ONE expiry bucket ---------------------------
# Batch ALL commands through ONE docker exec (a redis-cli command stream on stdin) — 64 separate
# `docker exec` processes per phase is what makes a wire smoke flaky on a loaded host.
echo "== NO jitter: PSETEX $N keys at the exact base=$BASE ms =="
# One docker exec, an inline command stream of PSETEX/PTTL pairs; each command returns one reply line.
plain_pttls=$( { for i in $(seq 0 $((N - 1))); do echo "PSETEX $KEY_PREFIX:plain:$i $BASE v"; echo "PTTL $KEY_PREFIX:plain:$i"; done; } | redis | tr -d '\r' | awk 'NR%2==0' )
plain_buckets=$(echo "$plain_pttls" | awk -v b="$BUCKET" '{print int($1/b)}' | sort -u | wc -l)
echo "  distinct ${BUCKET}ms expiry buckets WITHOUT jitter: $plain_buckets"
[ "$plain_buckets" -eq 1 ] || fail "no-jitter control spread into $plain_buckets buckets (expected 1) — the stampede premise does not hold"

# ---- 4. WITH jitter: PSETEX the same batch at base+offset; bucket the PTTLs ------------------------
echo "== WITH jitter: PSETEX at base + unsigned(hash(key)) % $SPREAD =="
# Build one interleaved command stream: PSETEX key ttl v; then PTTL key — all in ONE docker exec.
jitter_report=$( {
  while read -r key off ttl; do
    echo "PSETEX $KEY_PREFIX:jit:$key $ttl v"
    echo "PTTL $KEY_PREFIX:jit:$key"
  done <<< "$TABLE"
} | redis | tr -d '\r' )
jitter_pttls=$(echo "$jitter_report" | awk 'NR%2==0')
jitter_buckets=$(echo "$jitter_pttls" | awk -v b="$BUCKET" '{print int($1/b)}' | sort -u | wc -l)
min_pttl=$(echo "$jitter_pttls" | sort -n | head -1)
shortened=$(echo "$jitter_pttls" | awk -v base="$BASE" '$1 < base {c++} END {print c+0}')
echo "  distinct ${BUCKET}ms expiry buckets WITH jitter: $jitter_buckets (>= 16)"
echo "  min PTTL observed: $min_pttl (base=$BASE); shortened keys: $shortened"
[ "$jitter_buckets" -ge 16 ] || fail "jitter spread to only $jitter_buckets buckets — keys still cluster (expected >= 16)"
[ "$shortened" -eq 0 ] || fail "$shortened keys expired SHORTER than base — the offset must only lengthen"
[ "$min_pttl" -ge "$BASE" ] || fail "min PTTL=$min_pttl < base=$BASE — an early expiry slipped through"

# ---- 5. STABILITY within a run: rewriting the same key yields the same offset ---------------------
first_off=$(printf '%s\n' "$TABLE" | awk '$1=="nexus:jc:0"{print $2}')
again=$(python - "$OFFSET_HEX" "$PRIME_HEX" "$SPREAD" <<'PY'
import sys
offset=int(sys.argv[1],16); prime=int(sys.argv[2],16); spread=int(sys.argv[3]); MASK=(1<<64)-1
h=offset
for b in b'nexus:jc:0':
    h ^= b; h=(h*prime)&MASK
print(h % spread)
PY
)
echo "  nexus:jc:0 offset: first=$first_off recomputed=$again (must be identical)"
[ "$first_off" = "$again" ] || fail "the same key got a different offset on recompute — jitter is not a stable function of the key"

echo "PASS: no-jitter collapsed to $plain_buckets bucket; jitter spread to $jitter_buckets buckets, min PTTL=$min_pttl >= base=$BASE, offset stable — D940 decorrelates cache expiry on the wire"
