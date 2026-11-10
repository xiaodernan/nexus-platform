#!/usr/bin/env bash
# NEXUS cloud lb smoke: start the cloud plane, start the platform with the cloud profile so it
# registers with Eureka, and assert the full triangle — the gateway proxies /api/v1/health THROUGH
# the registry resolution to the platform (not the hardcoded host:port URI).
#
# Usage:  scripts/cloud_lb_smoke.sh
# Env:    NEXUS_SMOKE_EUREKA_PORT, NEXUS_SMOKE_CONFIG_PORT, NEXUS_SMOKE_GATEWAY_PORT, NEXUS_LB_PORT
#         (the last one is the smoke's own platform port, so a live `:8090` is untouched).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
PLATFORM="$ROOT/services/platform"
MVN="${MVN:-mvn}"

module_port() {
    sed -n 's/^[[:space:]]*port:[[:space:]]*${[A-Z_]*:\([0-9]*\)}[[:space:]]*$/\1/p' \
        "$CLOUD/$1/src/main/resources/application.yaml" | head -1
}
EUREKA_PORT="${NEXUS_SMOKE_EUREKA_PORT:-$(module_port eureka-server)}"
CONFIG_PORT="${NEXUS_SMOKE_CONFIG_PORT:-$(module_port config-server)}"
GATEWAY_PORT="${NEXUS_SMOKE_GATEWAY_PORT:-$(module_port gateway)}"
PLATFORM_PORT="${NEXUS_SMOKE_LB_PORT:-18099}"   # dedicated smoke port; not 8090
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-lb-smoke"
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

wait_up() {
    local name="$1" url="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS "$url" 2>/dev/null | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  $name healthy on $url"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never became healthy on $url (see $LOG_DIR/$name.log)"
}

start() {
    local name="$1"; shift
    java -jar "$@" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!)"
}

[ -n "$EUREKA_PORT" ] && [ -n "$CONFIG_PORT" ] && [ -n "$GATEWAY_PORT" ] && [ -n "$PLATFORM_PORT" ] \
    || fail "a module's application.yaml declares no \${ENV:<port>} default this script can read"

echo "== build =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "cloud build"

echo "== start eureka =="
start eureka "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT"
wait_up eureka "http://127.0.0.1:$EUREKA_PORT/actuator/health"

echo "== start config =="
start config "$CLOUD/config-server/target/app.jar" --server.port="$CONFIG_PORT"
wait_up config "http://127.0.0.1:$CONFIG_PORT/actuator/health"

echo "== start platform with cloud profile =="
env NEXUS_PORT="$PLATFORM_PORT" \
    NEXUS_DB_USER="${NEXUS_DB_USER:-nexus_app}" \
    NEXUS_DB_PASSWORD="${NEXUS_DB_PASSWORD:-nexus_dev_app_only}" \
    SPRING_FLYWAY_ENABLED=false \
    SPRING_PROFILES_ACTIVE=dev,cloud \
    NEXUS_DB_URL="${NEXUS_DB_URL:-jdbc:postgresql://127.0.0.1:5433/nexus_verify2}" \
    NEXUS_PLATFORM_DB_URL="${NEXUS_PLATFORM_DB_URL:-${NEXUS_DB_URL:-jdbc:postgresql://127.0.0.1:5433/nexus_verify2}}" \
    NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/" \
    "$MVN" -B -q -f "$PLATFORM/pom.xml" -DskipTests spring-boot:run >"$LOG_DIR/platform-lb.log" 2>&1 &
    PIDS+=("$!")
echo "  platform(lb) started (pid $!)"
wait_up platform "http://127.0.0.1:$PLATFORM_PORT/actuator/health"

echo "== eureka lists NEXUS-PLATFORM =="
registered=0
attempt=0
while [ "$attempt" -lt 90 ]; do
    if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -q 'NEXUS-PLATFORM'; then
        registered=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$registered" = 1 ] || fail "eureka never listed NEXUS-PLATFORM from the platform's cloud profile"
echo "  NEXUS-PLATFORM registered"

echo "== start gateway with cloud profile =="
start gateway "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT" \
    --spring.profiles.active=cloud
wait_up gateway "http://127.0.0.1:$GATEWAY_PORT/actuator/health"

echo "== gateway proxies by name to the platform =="
info="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/api/v1/health" 2>/dev/null)" \
    || fail "gateway /api/v1/health failed (see $LOG_DIR/gateway.log)"
case "$info" in
    *'"status":"ok"'*) echo "  /api/v1/health through the gateway: ok" ;;
    *) fail "gateway /api/v1/health returned no ok status: $info" ;;
esac
routes="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/gateway/routes" 2>/dev/null)"
echo "$routes" | grep -q 'lb://NEXUS-PLATFORM' || fail "gateway does not carry lb://NEXUS-PLATFORM in its route table"
echo "  gateway route table carries lb://NEXUS-PLATFORM"

echo "PASS: cloud lb smoke — eureka + config + platform(cloud profile) + gateway(lb://)"
