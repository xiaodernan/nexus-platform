#!/usr/bin/env bash
# NEXUS D1140 — FALSIFIER for ratelimit_gateway_redis_smoke.sh.
#
# The smoke claims: with NEXUS_GATEWAY_RATE_STORE=redis, ONE token budget is shared across two
# gateway processes; therefore its third request from the same client key (served by the SECOND
# process) is refused. This falsifier boots the same pair with the DEFAULT store (inmemory — the
# pre-D1140 behaviour every existing deployment gets) and REQUIRES the claim to fail:
#
#   req1 gw1 -> not 429     req2 gw1 -> not 429     req3 gw2 -> NOT 429   (private budgets)
#   req4 gw1 -> 429                                     (gw1's own budget drained)
#
# If req3 gw2 is 429 even with two private in-memory maps, the smoke's green is not attributable
# to the shared Redis store — something else (a global lock, a shared file, a port collision)
# supplied the budget. Then this falsifier reds, and the pair is not proven.
#
# A pass here means: the smoke's shared-store assertion fails exactly when the shared store is
# absent — i.e. the smoke cannot be green by accident.
#
# Usage:   bash scripts/falsify_ratelimit_gateway_redis_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
GW1_PORT=18094
GW2_PORT=18095
PREFIX="gw:ratelimit:falsify$(date +%s)$$"
KEY="${PREFIX}127.0.0.1"
LOG_DIR="${TMPDIR:-/tmp}/nexus-gw-redis-lb-falsify"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
JAR="$CLOUD/gateway/target/app.jar"
PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    redis DEL "$KEY" >/dev/null 2>&1 || true   # inmemory never writes it; belt-and-braces
}
trap cleanup EXIT

# The jar is built by the positive smoke; build here too so this falsifier stands alone.
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "maven build"
[ -f "$JAR" ] || fail "missing $JAR"

boot() {
    local name="$1" port="$2"
    EUREKA_CLIENT_REGISTERWITHEUREKA=false \
    EUREKA_CLIENT_FETCHREGISTRY=false \
    NEXUS_GATEWAY_RATE_STORE=inmemory \
    NEXUS_GATEWAY_RATE_PREFIX="$PREFIX" \
    NEXUS_GATEWAY_RATE_BURST=2 NEXUS_GATEWAY_RATE_REPLENISH=0 \
    NEXUS_PLATFORM_URI=http://127.0.0.1:9/ NEXUS_AI_URI=http://127.0.0.1:9/ NEXUS_WEB_URI=http://127.0.0.1:9/ \
        java -jar "$JAR" --server.port="$port" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!) on :$port — inmemory store (pre-D1140 default)"
}

wait_health() {
    local name="$1" port="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q '"status":"UP"'; then
            echo "  $name healthy on :$port"; return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never became healthy on :$port (see $LOG_DIR/$name.log)"
}

http_code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$1/probe"; }

echo "== boot the inmemory pair (the store the claim is falsified against) =="
boot gw1 "$GW1_PORT"
boot gw2 "$GW2_PORT"
wait_health gw1 "$GW1_PORT"
wait_health gw2 "$GW2_PORT"

c1=$(http_code "$GW1_PORT"); echo "  gw1 req1 -> $c1"
c2=$(http_code "$GW1_PORT"); echo "  gw1 req2 -> $c2"
c3=$(http_code "$GW2_PORT"); echo "  gw2 req3 -> $c3"
c4=$(http_code "$GW1_PORT"); echo "  gw1 req4 -> $c4"
[ "$c1" != "429" ] && [ "$c2" != "429" ] || fail "gw1 refused before its own budget was drained ($c1,$c2) — inmemory pair is not behaving like a baseline"
[ "$c3" != "429" ] || fail "req3 gw2 was 429 with two PRIVATE in-memory maps — the shared-store claim does not distinguish wiring from accident"
[ "$c4" == "429" ] || fail "gw1 req4 was $c4 — its own budget should be drained after two admits"

echo "PASS: the shared-store claim is falsified without the Redis wiring — the smoke cannot be green by accident (D1140)"
