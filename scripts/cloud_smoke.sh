#!/usr/bin/env bash
# NEXUS cloud-plane smoke: build the three Spring Cloud modules, run them on loopback ports, and
# assert the three things that make the plane real rather than decorative:
#
#   1. the config server serves nexus-gateway.yml, and the gateway RESOLVES it ("label":"cloud-smoke"
#      in /cloud/info, not the local default "local");
#   2. the gateway's route table contains the platform/AI/web routes and honours the URI overrides;
#   3. the gateway registers itself with Eureka and the registry lists NEXUS-GATEWAY.
#
# It also asserts the edge mints X-Request-Id on a routed miss, so a caller can correlate a gateway
# answer even when no upstream was reached.
#
# No database, no platform, no AI service: the point is the cloud plane's own wiring, and the route
# URIs are pointed at a closed port on purpose (they must appear in the table, not answer).
#
# Usage:  scripts/cloud_smoke.sh
# Env:    NEXUS_SMOKE_EUREKA_PORT (18761), NEXUS_SMOKE_CONFIG_PORT (18888),
#         NEXUS_SMOKE_GATEWAY_PORT (18088), MVN (mvn)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
EUREKA_PORT="${NEXUS_SMOKE_EUREKA_PORT:-18761}"
CONFIG_PORT="${NEXUS_SMOKE_CONFIG_PORT:-18888}"
GATEWAY_PORT="${NEXUS_SMOKE_GATEWAY_PORT:-18088}"
DEAD_PORT=9
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-smoke"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
        kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    echo "logs: $LOG_DIR" >&2
    exit 1
}

wait_health() {
    local name="$1" port="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q '"status":"UP"'; then
            echo "  $name healthy on :$port"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never became healthy on :$port (see $LOG_DIR/$name.log)"
}

start() {
    local name="$1" jar="$2"
    shift 2
    [ -f "$jar" ] || fail "missing $jar - run: mvn -f services/cloud/pom.xml -DskipTests package"
    java -jar "$jar" "$@" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!)"
}

echo "== build =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "maven build"

echo "== start =="
start eureka "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT"
wait_health eureka "$EUREKA_PORT"

start config "$CLOUD/config-server/target/app.jar" --server.port="$CONFIG_PORT"
wait_health config "$CONFIG_PORT"

export NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/"
export NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT"
export NEXUS_PLATFORM_URI="http://127.0.0.1:$DEAD_PORT"
export NEXUS_AI_URI="http://127.0.0.1:$DEAD_PORT"
export NEXUS_WEB_URI="http://127.0.0.1:$DEAD_PORT"
start gateway "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT"
wait_health gateway "$GATEWAY_PORT"

echo "== config server serves the file =="
served="$(curl -fsS "http://127.0.0.1:$CONFIG_PORT/nexus-gateway/default")" || fail "config server did not serve nexus-gateway/default"
echo "$served" | grep -q 'cloud-smoke' || fail "config server response lacks the smoke label: $served"
echo "  /nexus-gateway/default carries cloud-smoke"

echo "== gateway resolved the config =="
info="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/cloud/info")" || fail "gateway /cloud/info failed"
echo "$info" | grep -q '"label":"cloud-smoke"' || fail "gateway did not resolve its label from the config server: $info"
echo "$info" | grep -q '"id":"platform"' || fail "route table has no platform route: $info"
echo "$info" | grep -q '"id":"ai"' || fail "route table has no ai route: $info"
echo "  label=cloud-smoke, platform + ai routes present"

echo "== gateway route table honours the overrides =="
routes="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/gateway/routes")" || fail "actuator/gateway/routes failed"
echo "$routes" | grep -q '/api/v1/\*\*' || fail "platform predicate /api/v1/** missing: $routes"
echo "$routes" | grep -q '127.0.0.1:'"$DEAD_PORT" || fail "platform URI override missing (expected closed port $DEAD_PORT): $routes"
echo "  /api/v1/** -> closed port $DEAD_PORT"

echo "== the edge mints X-Request-Id =="
headers="$(curl -sS -D - -o /dev/null "http://127.0.0.1:$GATEWAY_PORT/cloud/nope" 2>/dev/null || true)"
echo "$headers" | grep -qi '^x-request-id:' || fail "no X-Request-Id on a routed miss"
echo "  routed miss carries X-Request-Id"

echo "== eureka lists the gateway =="
registered=0
attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null | grep -q 'NEXUS-GATEWAY'; then
        registered=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$registered" = 1 ] || fail "eureka never listed NEXUS-GATEWAY"
echo "  NEXUS-GATEWAY registered"

echo "PASS: cloud plane smoke - eureka + config + gateway"
