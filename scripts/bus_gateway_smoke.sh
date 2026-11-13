#!/usr/bin/env bash
# NEXUS D1034 — a FOURTH member of the bus: the gateway (nexus-gateway) joins the lane.
#
# D1024 (dispatcher), D1025 (insight), D1026 (events) — all sidecars. The gateway is the plane's
# single EDGE: WebFlux, reactive, zero views, resident in the path of every request the product
# serves. Giving it the refresh lane proves the lane survives its hardest member — the one for
# whom a blocked event loop is not an option. The subscriber runs on Lettuce's own event loop and
# never shares the WebFlux loop.
#
#   Phase 0 — bus DISABLED by default: POST /gateway/bus/refresh answers 409 bus_disabled.
#   Phase 1 — bus ENABLED: throwaway Config Server serves nexus-gateway.yml (label refresh-v1);
#             /gateway/config answers refresh-v1; the repo is rewritten to refresh-v2; POST
#             /gateway/bus/refresh answers 202 receivers >= 1; the SAME pid serves refresh-v2 —
#             the bus rebinds the edge without a restart.
#
# Usage:  bash scripts/bus_gateway_smoke.sh
# Env:    NEXUS_GATEWAY_BUS_CONFIG_PORT, NEXUS_GATEWAY_BUS_SVC_PORT (defaults: free ports)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-gateway-bus.XXXXXX 2>/dev/null || mktemp -d)"

free_port() {
    local start="$1" p="$1" attempts=0
    while [ "$attempts" -lt 100 ]; do
        if ! (echo >/dev/tcp/127.0.0.1/"$p") 2>/dev/null; then
            printf '%s' "$p"; return 0
        fi
        p=$((p + 1)); attempts=$((attempts + 1))
    done
    echo "no free port found from $start (100 tried)" >&2; exit 2
}
CONFIG_PORT="${NEXUS_GATEWAY_BUS_CONFIG_PORT:-$(free_port 18893)}"
PHASE0_PORT="${NEXUS_GATEWAY_BUS_PHASE0_PORT:-$(free_port 19596)}"
PHASE1_PORT="${NEXUS_GATEWAY_BUS_PHASE1_PORT:-$(free_port 19598)}"
REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-gateway-bus"
mkdir -p "$LOG_DIR"
echo "config_port=$CONFIG_PORT phase0_port=$PHASE0_PORT phase1_port=$PHASE1_PORT redis=$REDIS_URL" > "$LOG_DIR/ports.txt"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    rm -rf "$TMP_REPO"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

wait_health() {
    local name="$1" url="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -qE '"status":"UP"'; then
            echo "  $name healthy on $url"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never became healthy (see $LOG_DIR/$name.log)"
}

gateway_label() {
    curl -fsS --max-time 5 "http://127.0.0.1:$1/gateway/config" 2>/dev/null \
        | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4
}

echo "== ensure Redis on :6380 =="
if ! docker exec -i "${NEXUS_REDIS_CONTAINER:-nexus-platform-redis}" redis-cli PING 2>/dev/null | grep -q PONG; then
    fail "Redis is not reachable at $REDIS_URL — run scripts/ci_ensure_redis.sh first"
fi

echo "== build config-server + gateway (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,gateway -DskipTests package \
    || fail "maven build"

echo "== write a THROWAWAY config repo (nexus-gateway.yml, refresh-v1) =="
cat >"$TMP_REPO/nexus-gateway.yml" <<'YAML'
nexus:
  gateway:
    label: refresh-v1
YAML

echo "== start Config Server on :$CONFIG_PORT against the throwaway repo =="
if command -v cygpath >/dev/null 2>&1; then
    TMP_REPO_JAVA="file:///$(cygpath -m "$TMP_REPO" | sed 's|\\|/|g')"
else
    TMP_REPO_JAVA="file://$TMP_REPO"
fi
java -jar "$CLOUD/config-server/target/app.jar" \
    --server.port="$CONFIG_PORT" \
    --spring.cloud.config.server.native.search-locations="$TMP_REPO_JAVA" \
    >"$LOG_DIR/config.log" 2>&1 &
PIDS+=("$!")
wait_health config "http://127.0.0.1:$CONFIG_PORT/actuator/health"

echo "== Phase 0: bus DISABLED by default — POST /gateway/bus/refresh must answer 409 =="
NEXUS_GATEWAY_EUREKA_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/gateway/target/app.jar" --server.port="$PHASE0_PORT" \
    >"$LOG_DIR/phase0.log" 2>&1 &
PHASE0_PID=$!
PIDS+=("$PHASE0_PID")
wait_health phase0 "http://127.0.0.1:$PHASE0_PORT/actuator/health"
code="$(curl -s -o "$LOG_DIR/phase0.body" -w '%{http_code}' -X POST --max-time 10 "http://127.0.0.1:$PHASE0_PORT/gateway/bus/refresh" 2>/dev/null)"
[ "$code" = "409" ] || fail "phase0: expected 409 bus_disabled, got HTTP $code (body: $(cat "$LOG_DIR/phase0.body"))"
grep -q 'bus_disabled' "$LOG_DIR/phase0.body" || fail "phase0: 409 body does not name bus_disabled: $(cat "$LOG_DIR/phase0.body")"
echo "  409 bus_disabled — the edge refuses to publish without opting in"
kill "$PHASE0_PID" 2>/dev/null || true
wait "$PHASE0_PID" 2>/dev/null || true

echo "== Phase 1: bus ENABLED — the config flip rides the bus, not a restart =="
NEXUS_GATEWAY_BUS_ENABLED=true \
NEXUS_REDIS_URL="$REDIS_URL" \
NEXUS_GATEWAY_EUREKA_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/gateway/target/app.jar" --server.port="$PHASE1_PORT" \
    >"$LOG_DIR/phase1.log" 2>&1 &
PHASE1_PID=$!
PIDS+=("$PHASE1_PID")
wait_health phase1 "http://127.0.0.1:$PHASE1_PORT/actuator/health"

label_v1="$(gateway_label "$PHASE1_PORT")"
[ "$label_v1" = "refresh-v1" ] \
    || fail "gateway resolved '$label_v1' instead of the repo's refresh-v1 (is spring.config.import wired?)"
echo "  /gateway/config carries refresh-v1 (the Config Server round trip is real)"

echo "== rewrite the throwaway repo to refresh-v2 =="
cat >"$TMP_REPO/nexus-gateway.yml" <<'YAML'
nexus:
  gateway:
    label: refresh-v2
YAML
served_v2="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-gateway/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-gateway/default after the rewrite"
echo "$served_v2" | grep -q 'refresh-v2' || fail "config server did not serve v2: $served_v2"
echo "  config server serves refresh-v2"

echo "== POST /gateway/bus/refresh (no restart — pid $PHASE1_PID) =="
code="$(curl -s -o "$LOG_DIR/phase1.body" -w '%{http_code}' -X POST --max-time 10 "http://127.0.0.1:$PHASE1_PORT/gateway/bus/refresh" 2>/dev/null)"
[ "$code" = "202" ] || fail "phase1: expected 202 published, got HTTP $code (body: $(cat "$LOG_DIR/phase1.body"))"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/phase1.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 1 ] || fail "phase1: bus received by nobody (receivers=$receivers) — the subscriber is not connected"
echo "  /gateway/bus/refresh -> 202, receivers=$receivers (the subscriber heard it)"

label_v2=""
attempt=0
while [ "$attempt" -lt 30 ]; do
    label_v2="$(gateway_label "$PHASE1_PORT")"
    if [ "$label_v2" = "refresh-v2" ]; then break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$label_v2" = "refresh-v2" ] \
    || fail "gateway still reports '$label_v2' instead of refresh-v2 after POST /gateway/bus/refresh (same pid, 30s budget)"
echo "  /gateway/config carries refresh-v2, same pid — the edge rebound, it did not restart"

echo "PASS: gateway bus smoke — 409 bus_disabled off, refresh-v1 → POST → refresh-v2 same pid on, two phases"
