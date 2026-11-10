#!/usr/bin/env bash
# NEXUS cloud-plane smoke: build the three Spring Cloud modules, run them on loopback ports, and
# assert the four things that make the plane real rather than decorative:
#
#   1. the config server serves nexus-gateway.yml, and the gateway RESOLVES it ("label":"cloud-smoke"
#      in /cloud/info, not the local default "local");
#   2. the gateway's route table contains the platform/AI/web routes and honours the URI overrides;
#   3. the gateway registers itself with Eureka and the registry lists NEXUS-GATEWAY;
#   4. the registry lists NOTHING this repo does not declare (D847). Checked before the gateway
#      registers as well as after, so a port owned by another project's registry is caught without
#      our instance ever being written into it.
#
# It also asserts the edge mints X-Request-Id on a routed miss, so a caller can correlate a gateway
# answer even when no upstream was reached.
#
# No database, no platform, no AI service: the point is the cloud plane's own wiring, and the route
# URIs are pointed at a closed port on purpose (they must appear in the table, not answer).
#
# Usage:  scripts/cloud_smoke.sh
# Env:    NEXUS_SMOKE_EUREKA_PORT, NEXUS_SMOKE_CONFIG_PORT, NEXUS_SMOKE_GATEWAY_PORT (each overrides
#         the port its module declares in application.yaml - the defaults are READ, not retyped here,
#         so a green run is a verdict about the plane a developer actually gets), MVN (mvn)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
# D847: the smoke runs on the plane's OWN declared defaults, read from each module instead of retyped
# here. A second copy of the port map is how a green smoke ends up describing an offset plane nobody
# deploys - which is what this script had while the modules defaulted to 8761/8888/8088.
module_port() {
    sed -n 's/^[[:space:]]*port:[[:space:]]*${[A-Z_]*:\([0-9]*\)}[[:space:]]*$/\1/p' \
        "$CLOUD/$1/src/main/resources/application.yaml" | head -1
}
EUREKA_PORT="${NEXUS_SMOKE_EUREKA_PORT:-$(module_port eureka-server)}"
CONFIG_PORT="${NEXUS_SMOKE_CONFIG_PORT:-$(module_port config-server)}"
GATEWAY_PORT="${NEXUS_SMOKE_GATEWAY_PORT:-$(module_port gateway)}"
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

# Every application name this repo declares, uppercased the way Eureka lists them. Read from the three
# modules and the monolith rather than listed here, so a fourth service cannot slip past the check.
plane_names() {
    grep -h -A1 '^  application:' "$CLOUD"/*/src/main/resources/application.yaml \
        "$ROOT/services/platform/src/main/resources/application.yml" 2>/dev/null \
        | sed -n 's/^[[:space:]]*name:[[:space:]]*\([A-Za-z0-9._-]*\)[[:space:]]*$/\1/p' \
        | tr '[:lower:]' '[:upper:]' | sort -u
}

# D847: the registry must hold only services this repo declares. Called BEFORE the gateway registers, so
# finding another project's registry on the port cannot be the act that writes our instance into it.
# `"name":"X","instance"` is the application element's own shape; the `name` inside dataCenterInfo
# ("MyOwn") is not an application and must not be counted as one.
assert_registry_is_ours() {
    local allowed listed n foreign=""
    allowed="$(plane_names)"
    [ -n "$allowed" ] || fail "no application name could be read from the repo - the isolation check is empty"
    listed="$(curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -o '{"name":"[^"]*","instance"' | sed 's/{"name":"//; s/","instance"//' \
        | tr '[:lower:]' '[:upper:]' | sort -u)"
    for n in $listed; do
        echo "$allowed" | grep -qx "$n" || foreign="$foreign $n"
    done
    [ -z "$foreign" ] \
        || fail "the registry on :$EUREKA_PORT lists application(s) this repo does not declare:$foreign"
    echo "  registry on :$EUREKA_PORT holds only declared names (${listed:-none yet})"
}

[ -n "$EUREKA_PORT" ] && [ -n "$CONFIG_PORT" ] && [ -n "$GATEWAY_PORT" ] \
    || fail "a module's application.yaml declares no \${ENV:<port>} default this script can read"

echo "== build =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "maven build"

echo "== start =="
start eureka "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT"
wait_health eureka "$EUREKA_PORT"
assert_registry_is_ours

start config "$CLOUD/config-server/target/app.jar" --server.port="$CONFIG_PORT"
wait_health config "$CONFIG_PORT"

export NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/"
export NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT"
export NEXUS_PLATFORM_URI="http://127.0.0.1:$DEAD_PORT"
export NEXUS_AI_URI="http://127.0.0.1:$DEAD_PORT"
export NEXUS_WEB_URI="http://127.0.0.1:$DEAD_PORT"
# D850: isolate the breaker from the rate limiter (proven in cloud_lb_smoke.sh) and flip the
# breaker's DEBUG transition lines on - the smoke greps the log for CLOSED->OPEN on the dead port.
export NEXUS_GATEWAY_RATE_BURST=1000
export NEXUS_CB_LOG=DEBUG
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

echo "== the breaker opens on a dead upstream (D850) =="
# Every call fails on the closed port; resilience4j counts them (minimumNumberOfCalls=5, failure
# threshold 50%) and opens the platform breaker. Later calls short-circuit to the fallback (fast,
# no upstream touch). The DEBUG log names the transition; the answer body carries the fallback code.
for _ in $(seq 1 8); do
    curl -sS -o /dev/null "http://127.0.0.1:$GATEWAY_PORT/api/v1/health" || true
done
grep -q "CircuitBreaker 'platform'" "$LOG_DIR/gateway.log" \
    || fail "the platform breaker never recorded a failure (see $LOG_DIR/gateway.log)"
grep -q "STATE_TRANSITION" "$LOG_DIR/gateway.log" \
    || fail "no circuit breaker state transition in the gateway log (see $LOG_DIR/gateway.log)"
body="$(curl -sS "http://127.0.0.1:$GATEWAY_PORT/api/v1/health" || true)"
echo "$body" | grep -q 'edge_upstream_unavailable' \
    || fail "the fallback body is not what the edge serves on an open breaker: $body"
echo "  platform breaker OPENED and the fallback answer carries edge_upstream_unavailable"

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
assert_registry_is_ours

echo "PASS: cloud plane smoke - eureka + config + gateway"
