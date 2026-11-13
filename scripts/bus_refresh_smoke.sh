#!/usr/bin/env bash
# NEXUS D1024 — the Spring Cloud Bus-lite lane, proven end to end on this plane.
#
# One member (the dispatcher) opts the plane into a Redis pub/sub refresh bus: POST
# /dispatcher/bus/refresh publishes {"target":…,"source":"dispatcher-service"} on
# `nexus:bus:refresh`; every member that subscribed (NEXUS_BUS_ENABLED=true) rebinds its
# @RefreshScope beans via RefreshScope.refreshAll() — the same call the /actuator/refresh
# endpoint makes — on the SAME pid.
#
# This smoke proves exactly that, and nothing more:
#   Phase 0 (off by default): the dispatcher boots with the bus unset; POST
#           /dispatcher/bus/refresh answers 409 bus_disabled — no connection is opened.
#   Phase 1 (the round trip):   the dispatcher boots with NEXUS_BUS_ENABLED=true against a
#           throwaway Config Server serving nexus-dispatcher.yml (label refresh-v1) and
#           Eureka disabled; /dispatcher/config answers refresh-v1; the repo is rewritten to
#           refresh-v2; POST /dispatcher/bus/refresh answers 202 with receivers >= 1; the
#           SAME pid serves refresh-v2 from /dispatcher/config — no restart.
#
# Usage:  bash scripts/bus_refresh_smoke.sh
# Env:    NEXUS_BUS_CONFIG_PORT (default: free), NEXUS_BUS_SVC_PORT (default: free),
#         NEXUS_REDIS_URL (default: redis://127.0.0.1:6380/0 — ci_ensure_redis.sh provides it)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-bus-config.XXXXXX 2>/dev/null || mktemp -d)"

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
CONFIG_PORT="${NEXUS_BUS_CONFIG_PORT:-$(free_port 18894)}"
PHASE0_PORT="${NEXUS_BUS_PHASE0_PORT:-$(free_port 19576)}"
PHASE1_PORT="${NEXUS_BUS_PHASE1_PORT:-$(free_port 19578)}"
REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-bus-refresh"
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
        if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  $name healthy on $url"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never became healthy (see $LOG_DIR/$name.log)"
}

dispatcher_label() { # $1 = port
    curl -fsS --max-time 5 "http://127.0.0.1:$1/dispatcher/config" 2>/dev/null \
        | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4
}

echo "== ensure Redis on :${REDIS_URL##*:} (ci_ensure_redis.sh contract) =="
if ! docker exec -i "${NEXUS_REDIS_CONTAINER:-nexus-platform-redis}" redis-cli PING 2>/dev/null | grep -q PONG; then
    fail "Redis is not reachable at $REDIS_URL — run scripts/ci_ensure_redis.sh first"
fi

echo "== build config-server + dispatcher-service (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,dispatcher-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (nexus-dispatcher.yml, refresh-v1) =="
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
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

echo "== Phase 0: bus DISABLED by default — POST /dispatcher/bus/refresh must answer 409 =="
NEXUS_DISPATCHER_EUREKA_ENABLED=false \
NEXUS_DISPATCHER_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/dispatcher-service/target/app.jar" --server.port="$PHASE0_PORT" \
    >"$LOG_DIR/phase0.log" 2>&1 &
PHASE0_PID=$!
PIDS+=("$PHASE0_PID")
wait_health phase0 "http://127.0.0.1:$PHASE0_PORT/actuator/health"
body="$(curl -s -o "$LOG_DIR/phase0.body" -w '%{http_code}' -X POST --max-time 10 "http://127.0.0.1:$PHASE0_PORT/dispatcher/bus/refresh" 2>/dev/null)"
[ "$body" = "409" ] || fail "phase0: expected 409 bus_disabled, got HTTP $body (body: $(cat "$LOG_DIR/phase0.body"))"
grep -q 'bus_disabled' "$LOG_DIR/phase0.body" || fail "phase0: 409 body does not name bus_disabled: $(cat "$LOG_DIR/phase0.body")"
echo "  409 bus_disabled — the plane refuses to publish without opting in"
kill "$PHASE0_PID" 2>/dev/null || true
wait "$PHASE0_PID" 2>/dev/null || true

echo "== Phase 1: bus ENABLED — the config flip rides the bus, not a restart =="
NEXUS_BUS_ENABLED=true \
NEXUS_DISPATCHER_URL="$REDIS_URL" \
NEXUS_DISPATCHER_EUREKA_ENABLED=false \
NEXUS_DISPATCHER_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/dispatcher-service/target/app.jar" --server.port="$PHASE1_PORT" \
    >"$LOG_DIR/phase1.log" 2>&1 &
PHASE1_PID=$!
PIDS+=("$PHASE1_PID")
wait_health phase1 "http://127.0.0.1:$PHASE1_PORT/actuator/health"

label_v1="$(dispatcher_label "$PHASE1_PORT")"
[ "$label_v1" = "refresh-v1" ] \
    || fail "dispatcher resolved '$label_v1' instead of the repo's refresh-v1 (is spring.config.import wired?)"
echo "  /dispatcher/config carries refresh-v1 (the Config Server round trip is real)"

echo "== rewrite the throwaway repo to refresh-v2 =="
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v2
YAML
served_v2="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-dispatcher/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-dispatcher/default after the rewrite"
echo "$served_v2" | grep -q 'refresh-v2' || fail "config server did not serve v2: $served_v2"
echo "  config server serves refresh-v2"

echo "== POST /dispatcher/bus/refresh (no restart — pid $PHASE1_PID) =="
http_code="$(curl -s -o "$LOG_DIR/phase1.body" -w '%{http_code}' -X POST --max-time 10 "http://127.0.0.1:$PHASE1_PORT/dispatcher/bus/refresh" 2>/dev/null)"
[ "$http_code" = "202" ] || fail "phase1: expected 202 published, got HTTP $http_code (body: $(cat "$LOG_DIR/phase1.body"))"
grep -q '"receivers"' "$LOG_DIR/phase1.body" || fail "phase1: 202 body carries no receivers: $(cat "$LOG_DIR/phase1.body")"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/phase1.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 1 ] || fail "phase1: bus received by nobody (receivers=$receivers) — the subscriber is not connected"
echo "  /dispatcher/bus/refresh -> 202, receivers=$receivers (the subscriber heard it)"

# pub/sub delivery is async; give the subscriber a moment to rebind.
label_v2=""
attempt=0
while [ "$attempt" -lt 30 ]; do
    label_v2="$(dispatcher_label "$PHASE1_PORT")"
    if [ "$label_v2" = "refresh-v2" ]; then break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$label_v2" = "refresh-v2" ] \
    || fail "dispatcher still reports '$label_v2' instead of refresh-v2 after the bus refresh (same pid, 30s budget)"
echo "  /dispatcher/config carries refresh-v2, same pid — the bus rebound it, not a restart"

echo "PASS: bus refresh smoke — refresh-v1 → POST /dispatcher/bus/refresh → refresh-v2, same pid, two phases"
