#!/usr/bin/env bash
# NEXUS D1140 — TWO gateway processes, ONE token budget, measured on the wire against REAL Redis.
#
#   1. build the reactor (skip tests — the reactor test phase already gated this in CI)
#   2. start TWO instances of the edge gateway on :18092 and :18093 with
#        NEXUS_GATEWAY_RATE_STORE=redis  NEXUS_REDIS_URI=redis://127.0.0.1:6380/0
#        NEXUS_GATEWAY_RATE_BURST=2      NEXUS_GATEWAY_RATE_REPLENISH=0
#      and a throwaway prefix NEXUS_GATEWAY_RATE_PREFIX, so this run cannot collide with anything
#   3. three requests from THIS host (same client key 127.0.0.1 for both processes):
#        req1 via gw1 -> NOT 429   (token 1 of 2)
#        req2 via gw1 -> NOT 429   (token 2 of 2)
#        req3 via gw2 -> 429       (the bucket is SHARED across processes — the claim)
#        req4 via gw1 -> 429       (and stays drained)
#      before the store existed, step 3 was admitted by every fresh process (each owns a private map)
#   4. assert the allowed answers carry X-RateLimit-Store: redis (the store is honestly labelled)
#   5. clean up: DEL only the one key this run created; never FLUSHALL
#
# The FALSIFIER is scripts/falsify_ratelimit_gateway_redis_smoke.sh: it boots the same pair with the
# DEFAULT store (inmemory) and requires step 3 to be ADMITTED (separate budgets) while step 4 still
# 429s — proving this smoke's green is attributable to the shared Redis store, not to a test that
# cannot fail.
#
# Prereqs: docker-capable host with Redis reachable (ci_ensure_redis.sh provides it), Maven, JDK.
# Usage:   bash scripts/ratelimit_gateway_redis_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
GW1_PORT=18092
GW2_PORT=18093
PREFIX="gw:ratelimit:smoketest$(date +%s)$$"
KEY="${PREFIX}127.0.0.1"
LOG_DIR="${TMPDIR:-/tmp}/nexus-gw-redis-lb"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380 (run: bash scripts/ci_ensure_redis.sh)"
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    redis DEL "$KEY" >/dev/null 2>&1 || true
}
mkdir -p "$LOG_DIR"
PIDS=()
trap cleanup EXIT

echo "== build (skip tests; the cloud reactor test phase gates those) =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "maven build"
JAR="$CLOUD/gateway/target/app.jar"
[ -f "$JAR" ] || fail "missing $JAR"

boot() {
    local name="$1" port="$2"
    EUREKA_CLIENT_REGISTERWITHEUREKA=false \
    EUREKA_CLIENT_FETCHREGISTRY=false \
    NEXUS_GATEWAY_RATE_STORE=redis \
    NEXUS_REDIS_URI="redis://127.0.0.1:6380/0" \
    NEXUS_GATEWAY_RATE_PREFIX="$PREFIX" \
    NEXUS_GATEWAY_RATE_BURST=2 NEXUS_GATEWAY_RATE_REPLENISH=0 \
    NEXUS_PLATFORM_URI=http://127.0.0.1:9/ NEXUS_AI_URI=http://127.0.0.1:9/ NEXUS_WEB_URI=http://127.0.0.1:9/ \
        java -jar "$JAR" --server.port="$port" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!) on :$port"
}

wait_health() {
    local name="$1" port="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q '"status":"UP"'; then
            echo "  $name healthy on :$port"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never became healthy on :$port (see $LOG_DIR/$name.log)"
}

http_code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$1/probe"; }

echo "== boot two gateways, shared redis store, burst=2 replenish=0 =="
redis DEL "$KEY" >/dev/null 2>&1 || true
boot gw1 "$GW1_PORT"
boot gw2 "$GW2_PORT"
wait_health gw1 "$GW1_PORT"
wait_health gw2 "$GW2_PORT"

echo "== same client key, two processes, one budget =="
c1=$(http_code "$GW1_PORT"); echo "  gw1 req1 -> $c1"
c2=$(http_code "$GW1_PORT"); echo "  gw1 req2 -> $c2"
c3=$(http_code "$GW2_PORT"); echo "  gw2 req3 -> $c3"
c4=$(http_code "$GW1_PORT"); echo "  gw1 req4 -> $c4"
[ "$c1" != "429" ] || fail "req1 was 429 — burst should admit 2 per client"
[ "$c2" != "429" ] || fail "req2 was 429 — burst should admit 2 per client"
[ "$c3" == "429" ] || fail "req3 was $c3 — the shared store did NOT hold across processes (each gateway admitted its private budget)"
[ "$c4" == "429" ] || fail "req4 was $c4 — the shared bucket did not stay drained"

store=$(curl -s -m 10 -D - -o /dev/null "http://127.0.0.1:$GW1_PORT/probe" | tr -d '\r' | grep -i '^X-RateLimit-Store:' | awk '{print $2}')
echo "  X-RateLimit-Store on a refused/analysed answer: ${store:-<absent>}"
[ "${store:-}" = "redis" ] || fail "X-RateLimit-Store was not 'redis' (got '${store:-absent}')"

echo "PASS: two processes, one Redis token budget — req3/req4 refused cross-process (D1140)"
