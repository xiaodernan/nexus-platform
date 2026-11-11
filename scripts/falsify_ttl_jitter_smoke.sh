#!/usr/bin/env bash
# NEXUS D940 — falsifier for ttl_jitter_smoke.sh.
#
# The main smoke proves the D940 guard uses an UNSIGNED remainder: a batch of same-TTL keys is lengthened
# by unsigned(hash(key)) % spread, so it spreads across >= 16 expiry buckets and NO key expires earlier than
# the requested base. The unsigned remainder is load-bearing because FNV's top bit is set for ~half of keys,
# making the signed Java/C long NEGATIVE; a plain signed `%` then yields a NEGATIVE offset.
#
# This arm plants EXACTLY that one bug — it swaps the unsigned remainder for the SIGNED one in the
# source-extracted formula — and replays the same batch on live Redis, requiring the "never shorter than
# base" assertion to go RED: ~half the keys now get a TTL BELOW base, i.e. they expire EARLIER than the
# caller asked. That is a worse defect than the avalanche the guard exists to prevent, which is why the
# unsigned remainder is not decoration. The red is attributable to one swapped operator: every other byte,
# every key, the base and the live Redis are identical. A control arm with the honest unsigned remainder
# keeps every PTTL >= base, proving the control is clean.
#
# Exit 0 = the signed bug shortens TTLs (the guard's "never shortens" claim is load-bearing) => falsifiable.
# Exit 1 = the signed bug did NOT shorten anything (the assertion cannot fail) => do not claim D940.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JITTER="$ROOT/services/platform/src/main/java/com/nexus/platform/TtlJitter.java"
N=64
BASE=30000
SPREAD=1024
KEY_PREFIX="ttl:falsify:$$"
fail() { echo "FAIL: $*" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || { echo "SKIP: nexus-platform-redis not reachable — cannot run the live falsifier"; exit 2; }
[ -f "$JITTER" ] || fail "TtlJitter.java not found at $JITTER"

OFFSET_HEX=$(sed -n 's/.*FNV_OFFSET_BASIS = \(0x[0-9a-fA-F]*\)L;.*/\1/p' "$JITTER" | head -1)
PRIME_HEX=$(sed -n 's/.*FNV_PRIME = \(0x[0-9a-fA-F]*\)L;.*/\1/p' "$JITTER" | head -1)
[ -n "$OFFSET_HEX" ] || fail "could not extract FNV_OFFSET_BASIS"
[ -n "$PRIME_HEX" ] || fail "could not extract FNV_PRIME"
grep -q 'Long.remainderUnsigned' "$JITTER" || fail "the source does NOT use the unsigned remainder — the honest arm has no load-bearing operator to flip"

# ---- the FAULTY table: signed remainder (Java/C % semantics: result carries the dividend's sign) ------
# plus the HONEST table: unsigned remainder. Both from the SAME source constants, SAME keys, SAME base.
mapfile -t TABLE_LINES < <(python - "$OFFSET_HEX" "$PRIME_HEX" "$N" "$BASE" "$SPREAD" <<'PY'
import sys
offset=int(sys.argv[1],16); prime=int(sys.argv[2],16)
n=int(sys.argv[3]); base=int(sys.argv[4]); spread=int(sys.argv[5])
MASK=(1<<64)-1
def fnv_u(s):
    h=offset
    for b in s.encode('utf-8'):
        h ^= b; h=(h*prime)&MASK
    return h
def signed64(u):
    return u-(1<<64) if u >= (1<<63) else u
def java_signed_mod(u, spread):
    # Java's `long % long`: same sign as the dividend, magnitude truncated toward zero.
    v=signed64(u)
    r=abs(v) % spread
    return -r if v < 0 else r
s=[]; hn=[]
for i in range(n):
    k='nexus:jc:%d'%i
    u=fnv_u(k)
    s.append('%d' % (base + java_signed_mod(u, spread)))
    hn.append('%d' % (base + (u % spread)))
print(' '.join(s))
print(' '.join(hn))
PY
)
[ "${#TABLE_LINES[@]}" -eq 2 ] || fail "expected two TTL tables from Python, got ${#TABLE_LINES[@]} lines"
SIGNED_ARR=(${TABLE_LINES[0]})
HONEST_ARR=(${TABLE_LINES[1]})
[ "${#SIGNED_ARR[@]}" -eq "$N" ] || fail "signed table has ${#SIGNED_ARR[@]} entries, expected $N"
[ "${#HONEST_ARR[@]}" -eq "$N" ] || fail "honest table has ${#HONEST_ARR[@]} entries, expected $N"

cleanup() {
  { for i in $(seq 0 $((N - 1))); do
      echo "DEL $KEY_PREFIX:signed:$i"
      echo "DEL $KEY_PREFIX:unsigned:$i"
    done; } | redis >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---- the FAULTY arm: signed remainder must produce TTLs SHORTER than base --------------------------
# One docker exec per arm: an inline PSETEX/PTTL command stream (avoids 128 docker exec processes).
echo "== FAULTY arm: signed remainder — PSETEX the same $N keys =="
signed_pttls=$( {
  for i in $(seq 0 $((N - 1))); do
    echo "PSETEX $KEY_PREFIX:signed:$i ${SIGNED_ARR[$i]} v"
    echo "PTTL $KEY_PREFIX:signed:$i"
  done
} | redis | tr -d '\r' | awk 'NR%2==0' )
shortened=$(echo "$signed_pttls" | awk -v base="$BASE" '$1 < base {c++} END {print c+0}')
min_signed=$(echo "$signed_pttls" | sort -n | head -1)
echo "  signed remainder: $shortened / $N keys expired BELOW base=$BASE (min PTTL=$min_signed)"
# The "never shortens" assertion from the main smoke must REDDEN here.
[ "$shortened" -gt 0 ] || fail "signed remainder did NOT shorten any TTL — the unsigned-remainder claim is NOT falsifiable here"
[ "$min_signed" -lt "$BASE" ] || fail "min PTTL=$min_signed not below base — the early-expiry defect was not reproduced"

# ---- the HONEST control: unsigned remainder keeps every PTTL >= base -------------------------------
echo "== HONEST control: unsigned remainder — PSETEX the same $N keys =="
honest_pttls=$( {
  for i in $(seq 0 $((N - 1))); do
    echo "PSETEX $KEY_PREFIX:unsigned:$i ${HONEST_ARR[$i]} v"
    echo "PTTL $KEY_PREFIX:unsigned:$i"
  done
} | redis | tr -d '\r' | awk 'NR%2==0' )
honest_shortened=$(echo "$honest_pttls" | awk -v base="$BASE" '$1 < base {c++} END {print c+0}')
min_honest=$(echo "$honest_pttls" | sort -n | head -1)
echo "  unsigned remainder: $honest_shortened / $N keys below base (min PTTL=$min_honest)"
[ "$honest_shortened" -eq 0 ] || fail "the honest unsigned arm shortened $honest_shortened keys — the control is not clean"
[ "$min_honest" -ge "$BASE" ] || fail "honest min PTTL=$min_honest < base — control failed"

echo "PASS: the signed-remainder bug shortens $shortened/$N TTLs below base (= early expiry, a real defect) while the unsigned control keeps all $N >= base — D940's 'never shortens' claim is falsifiable and the unsigned remainder is load-bearing"
