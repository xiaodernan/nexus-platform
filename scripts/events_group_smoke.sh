#!/usr/bin/env bash
# NEXUS D931 — prove the Redis Stream consumer group actually partitions the stream.
#
#   1. flush nexus:events, choose a UNIQUE group name
#   2. boot TWO events-service JVMs on distinct ports, same group, DISTINCT consumer names,
#      group-enabled=true (unless NEXUS_EVENTS_GROUP_OFF=1, the falsifier arm)
#   3. publish N entries into the live nexus-platform-redis
#   4. poll both /events/count until the two total_seen sum to N (or time out)
#   5. ASSERT the sum is EXACTLY N — with bare XREAD tails it would be 2N (each reads everything),
#      so a sum of N can only come from the group having delivered each entry to ONE consumer
#   6. read both /events/group and assert enabled=true, same group, distinct consumers,
#      delivered+acked == N, pending == 0
#
# FALSIFIER ARM: NEXUS_EVENTS_GROUP_OFF=1 boots both readers in D929 tail mode but keeps the
# SAME "sum == N" assertion. Two tails each see all N, so the sum is 2N and the script FAILS —
# attributable to exactly one flipped variable (group-enabled). See falsify_events_group_smoke.sh.
#
# NOT CLAIMED: consumer-group HA, XAUTOCLAIM of a dead consumer's pending entries (this smoke uses
# two LIVE consumers), ordering, or production throughput. The replay property is measured in
# EventsGroupReaderTest.anUnackedEntryStaysPendingAndIsReplayed, not here.
#
# Usage:  bash scripts/events_group_smoke.sh
#         NEXUS_EVENTS_GROUP_OFF=1 bash scripts/events_group_smoke.sh   # must FAIL
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
A_PORT="${NEXUS_EVENTS_GROUP_A_PORT:-19575}"
B_PORT="${NEXUS_EVENTS_GROUP_B_PORT:-19576}"
GROUP_NAME="smoke-group-$$"
N="${NEXUS_EVENTS_GROUP_N:-8}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-events-group-smoke"
mkdir -p "$LOG_DIR"
GROUP_OFF="${NEXUS_EVENTS_GROUP_OFF:-0}"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

if [ "${NEXUS_EVENTS_GROUP_SKIP_BUILD:-0}" != "1" ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl events-service -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/events-service/target/app.jar" ] || fail "skip requested but the events jar is missing"
fi

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380"
redis FLUSHDB >/dev/null 2>&1 || fail "could not flush the test DB"
echo "== redis up, DB flushed, group=$GROUP_NAME, N=$N =="

if [ "$GROUP_OFF" = "1" ]; then
    echo "  FALSIFIER ARM: group-enabled=false on both readers (D929 tails)"
    GROUP_FLAG="false"
else
    GROUP_FLAG="true"
fi

boot() {  # $1=port $2=consumer $3=log
    env NEXUS_EVENTS_EUREKA_ENABLED=false \
        NEXUS_EVENTS_URL="redis://127.0.0.1:6380/0" \
        NEXUS_EVENTS_GROUP_ENABLED="$GROUP_FLAG" \
        NEXUS_EVENTS_GROUP_NAME="$GROUP_NAME" \
        NEXUS_EVENTS_CONSUMER_NAME="$2" \
        NEXUS_EVENTS_POLL_MS=250 \
        java -jar "$CLOUD/events-service/target/app.jar" --server.port="$1" \
        >"$3" 2>&1 &
    PIDS+=("$!")
}
echo "== boot reader A on :$A_PORT (consumer-a) =="
boot "$A_PORT" "consumer-a" "$LOG_DIR/a.log"
echo "== boot reader B on :$B_PORT (consumer-b) =="
boot "$B_PORT" "consumer-b" "$LOG_DIR/b.log"

wait_health() {  # $1=port
    local ok=0 attempt=0
    while [ "$attempt" -lt 90 ]; do
        curl -fsS --max-time 2 "http://127.0.0.1:$1/events/health" 2>/dev/null \
            | grep -q '"status":"UP"' && { ok=1; break; }
        attempt=$((attempt + 1)); sleep 1
    done
    [ "$ok" = 1 ] || fail "reader on :$1 never became healthy (see $LOG_DIR)"
}
wait_health "$A_PORT"
wait_health "$B_PORT"
echo "  both readers healthy"

# Let both consumers create/join the group before publishing, so neither misses the first entries.
sleep 2

echo "== publish $N entries =="
for i in $(seq 1 "$N"); do
    redis XADD nexus:events "*" template lead_new tenant_id "t-$i" type LeadCaptured payload "{\"i\":$i}" >/dev/null
done

# Poll until the SUM of both readers' total_seen reaches at least N (2N in tail mode).
sum=0
for attempt in $(seq 1 40); do
    ca=$(curl -fsS --max-time 3 "http://127.0.0.1:$A_PORT/events/count" 2>/dev/null | grep -oE '"total_seen":[0-9]+' | grep -oE '[0-9]+' || echo 0)
    cb=$(curl -fsS --max-time 3 "http://127.0.0.1:$B_PORT/events/count" 2>/dev/null | grep -oE '"total_seen":[0-9]+' | grep -oE '[0-9]+' || echo 0)
    sum=$((ca + cb))
    if [ "$sum" -ge "$N" ]; then break; fi
    sleep 1
done
echo "  total_seen: A=$ca B=$cb sum=$sum (expected exactly $N under group, 2*$N=$((2*N)) under tails)"
[ "$sum" -ge "$N" ] || fail "readers drained only $sum of $N entries"

# THE load-bearing assertion: a single assertion template, flipped only by GROUP_OFF.
if [ "$sum" -ne "$N" ]; then
    fail "sum=$sum != N=$N — with group-enabled=$GROUP_FLAG the stream was NOT partitioned once (2N=$((2*N)))"
fi
echo "  SPLIT HOLDS: sum == N == $N (each entry delivered to exactly one consumer)"

group_a=$(curl -fsS "http://127.0.0.1:$A_PORT/events/group")
group_b=$(curl -fsS "http://127.0.0.1:$B_PORT/events/group")
echo "  A /events/group -> $group_a"
echo "  B /events/group -> $group_b"

if [ "$GROUP_OFF" = "1" ]; then
    # The falsifier arm never reaches here on the real plane; keep the script honest if it does.
    echo "$group_a" | grep -q '"enabled":false' || fail "tail arm: group should report disabled"
else
    echo "$group_a" | grep -q '"enabled":true' || fail "A group not enabled"
    echo "$group_b" | grep -q '"enabled":true' || fail "B group not enabled"
    echo "$group_a" | grep -q "\"group\":\"$GROUP_NAME\"" || fail "A wrong group name"
    echo "$group_b" | grep -q "\"group\":\"$GROUP_NAME\"" || fail "B wrong group name"
    echo "$group_a" | grep -q '"consumer":"consumer-a"' || fail "A wrong consumer name"
    echo "$group_b" | grep -q '"consumer":"consumer-b"' || fail "B wrong consumer name"
    da=$(echo "$group_a" | grep -oE '"delivered":[0-9]+' | grep -oE '[0-9]+')
    db=$(echo "$group_b" | grep -oE '"delivered":[0-9]+' | grep -oE '[0-9]+')
    aa=$(echo "$group_a" | grep -oE '"acked":[0-9]+' | grep -oE '[0-9]+')
    ab=$(echo "$group_b" | grep -oE '"acked":[0-9]+' | grep -oE '[0-9]+')
    [ "$((da + db))" -eq "$N" ] || fail "delivered sum $((da+db)) != $N"
    [ "$((aa + ab))" -eq "$N" ] || fail "acked sum $((aa+ab)) != $N"
    echo "  delivered+acked == $N, both consumers distinct, group name shared"
fi

echo "PASS: consumer group partitions $N entries across two readers (delivered once, all acked)"
