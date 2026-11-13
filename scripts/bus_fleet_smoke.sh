#!/usr/bin/env bash
# NEXUS D1035 — the whole Bus-lite fleet flips from ONE notice, proven live end to end.
#
# D1024 (dispatcher), D1025 (insight, two-member), D1026 (events, three-member) and D1034 (gateway,
# the edge) each armed against their sidecar. The one question nobody asked on the wire yet:
# CAN ONE NOTICE MOVE EVERY MEMBER OF THE PLANE'S REGISTRY AT ONCE?
#
# This smoke answers it with a live four-member boot on the throwaway plane:
#
#   Scenario 1 — target=all from the GATEWAY'S door: one POST /gateway/bus/refresh →
#                receivers >= 4; /gateway|dispatcher|insight|events/config all answer `refresh-v2`,
#                same pids.
#   Scenario 2 — target=gateway: only the gateway rebinds to refresh-v3; the three sidecars stay
#                at refresh-v2 — the negative arm for the full fleet, once more, against the
#                hottest path of the product.
#
# Redis is the ci_ensure_redis.sh throwaway on :6380 — provided by CI as usual.
#
# Usage:  bash scripts/bus_fleet_smoke.sh
# Env:    NEXUS_FLEET_CONFIG_PORT, NEXUS_FLEET_GATEWAY_PORT, NEXUS_FLEET_DISPATCHER_PORT,
#         NEXUS_FLEET_INSIGHT_PORT, NEXUS_FLEET_EVENTS_PORT (defaults: free ports)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-bus-fleet.XXXXXX 2>/dev/null || mktemp -d)"

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
CONFIG_PORT="${NEXUS_FLEET_CONFIG_PORT:-$(free_port 18900)}"
GATEWAY_PORT="${NEXUS_FLEET_GATEWAY_PORT:-$(free_port 19602)}"
DISPATCHER_PORT="${NEXUS_FLEET_DISPATCHER_PORT:-$(free_port 19604)}"
INSIGHT_PORT="${NEXUS_FLEET_INSIGHT_PORT:-$(free_port 19606)}"
EVENTS_PORT="${NEXUS_FLEET_EVENTS_PORT:-$(free_port 19608)}"
REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-bus-fleet"
mkdir -p "$LOG_DIR"
echo "config_port=$CONFIG_PORT gateway_port=$GATEWAY_PORT dispatcher_port=$DISPATCHER_PORT insight_port=$INSIGHT_PORT events_port=$EVENTS_PORT redis=$REDIS_URL" > "$LOG_DIR/ports.txt"

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

cfg() {
    case "$1" in
        gateway)    curl -fsS --max-time 5 "http://127.0.0.1:$GATEWAY_PORT/gateway/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4 ;;
        dispatcher) curl -fsS --max-time 5 "http://127.0.0.1:$DISPATCHER_PORT/dispatcher/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4 ;;
        insight)    curl -fsS --max-time 5 "http://127.0.0.1:$INSIGHT_PORT/insight/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4 ;;
        events)     curl -fsS --max-time 5 "http://127.0.0.1:$EVENTS_PORT/events/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4 ;;
        *) echo "unknown member: $1" ;;
    esac
}

read_all() { echo "$(cfg gateway) $(cfg dispatcher) $(cfg insight) $(cfg events)"; }

wait_all() { # $1 = want
    local attempt=0 got="" want="$1"
    while [ "$attempt" -lt 30 ]; do
        got="$(read_all)"
        if [ "$got" = "$want $want $want $want" ]; then printf '%s' "$got"; return 0; fi
        attempt=$((attempt + 1)); sleep 1
    done
    printf '%s' "$got"
    return 1
}

echo "== ensure Redis on :6380 =="
if ! docker exec -i "${NEXUS_REDIS_CONTAINER:-nexus-platform-redis}" redis-cli PING 2>/dev/null | grep -q PONG; then
    fail "Redis is not reachable at $REDIS_URL — run scripts/ci_ensure_redis.sh first"
fi

echo "== build config-server + all four members (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,gateway,dispatcher-service,insight-service,events-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (v1 for ALL FOUR members) =="
cat >"$TMP_REPO/nexus-gateway.yml"    <<'YAML'
nexus:
  gateway:
    label: refresh-v1
YAML
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v1
YAML
cat >"$TMP_REPO/nexus-insight.yml"    <<'YAML'
nexus:
  insight:
    label: refresh-v1
YAML
cat >"$TMP_REPO/nexus-events.yml"     <<'YAML'
nexus:
  events:
    label: refresh-v1
YAML

echo "== start Config Server on :$CONFIG_PORT =="
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

echo "== boot ALL FOUR members (bus armed) =="
NEXUS_GATEWAY_BUS_ENABLED=true NEXUS_GATEWAY_EUREKA_ENABLED=false NEXUS_REDIS_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT" \
    >"$LOG_DIR/gateway.log" 2>&1 &
PIDS+=("$!")
NEXUS_BUS_ENABLED=true NEXUS_DISPATCHER_EUREKA_ENABLED=false NEXUS_DISPATCHER_ENABLED=false \
NEXUS_REDIS_URL="$REDIS_URL" NEXUS_DISPATCHER_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/dispatcher-service/target/app.jar" --server.port="$DISPATCHER_PORT" \
    >"$LOG_DIR/dispatcher.log" 2>&1 &
PIDS+=("$!")
NEXUS_INSIGHT_BUS_ENABLED=true NEXUS_INSIGHT_EUREKA_ENABLED=false NEXUS_REDIS_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
NEXUS_EVENTS_BUS_ENABLED=true NEXUS_EVENTS_EUREKA_ENABLED=false NEXUS_EVENTS_ENABLED=false NEXUS_REDIS_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/events-service/target/app.jar" --server.port="$EVENTS_PORT" \
    >"$LOG_DIR/events.log" 2>&1 &
PIDS+=("$!")
wait_health gateway    "http://127.0.0.1:$GATEWAY_PORT/actuator/health"
wait_health dispatcher "http://127.0.0.1:$DISPATCHER_PORT/actuator/health"
wait_health insight    "http://127.0.0.1:$INSIGHT_PORT/actuator/health"
wait_health events     "http://127.0.0.1:$EVENTS_PORT/actuator/health"

labels="$(read_all)"
case "$labels" in
    'refresh-v1 refresh-v1 refresh-v1 refresh-v1')
        echo "  all four members resolve refresh-v1" ;;
    *)
        fail "members did not all resolve refresh-v1 (got: $labels)" ;;
esac

echo "== rewrite the throwaway repo to v2 =="
cat >"$TMP_REPO/nexus-gateway.yml"    <<'YAML'
nexus:
  gateway:
    label: refresh-v2
YAML
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v2
YAML
cat >"$TMP_REPO/nexus-insight.yml"    <<'YAML'
nexus:
  insight:
    label: refresh-v2
YAML
cat >"$TMP_REPO/nexus-events.yml"     <<'YAML'
nexus:
  events:
    label: refresh-v2
YAML

echo "== Scenario 1: POST /gateway/bus/refresh?target=all from the EDGE — all FOUR rebind =="
code="$(curl -s -o "$LOG_DIR/fleet.body" -w '%{http_code}' -X POST --max-time 15 "http://127.0.0.1:$GATEWAY_PORT/gateway/bus/refresh?target=all" 2>/dev/null)"
[ "$code" = "202" ] || fail "scenario1: expected 202, got HTTP $code (body: $(cat "$LOG_DIR/fleet.body"))"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/fleet.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 4 ] || fail "scenario1: expected receivers >= 4 (four subscribers HEAR the all-flip), got $receivers"
echo "  /gateway/bus/refresh?target=all -> 202, receivers=$receivers"
labels_v2="$(wait_all refresh-v2)" || fail "not all members rebound to refresh-v2 (got: $labels_v2)"
echo "  gateway + dispatcher + insight + events all answer refresh-v2, same pids — the notice flipped the FLEET"

echo "== rewrite the throwaway repo to v3 =="
cat >"$TMP_REPO/nexus-gateway.yml"    <<'YAML'
nexus:
  gateway:
    label: refresh-v3
YAML
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v3
YAML
cat >"$TMP_REPO/nexus-insight.yml"    <<'YAML'
nexus:
  insight:
    label: refresh-v3
YAML
cat >"$TMP_REPO/nexus-events.yml"     <<'YAML'
nexus:
  events:
    label: refresh-v3
YAML

echo "== Scenario 2: POST /gateway/bus/refresh?target=gateway — only the EDGE rebinds =="
code="$(curl -s -o "$LOG_DIR/fleet2.body" -w '%{http_code}' -X POST --max-time 15 "http://127.0.0.1:$GATEWAY_PORT/gateway/bus/refresh?target=gateway" 2>/dev/null)"
[ "$code" = "202" ] || fail "scenario2: expected 202, got HTTP $code (body: $(cat "$LOG_DIR/fleet2.body"))"
label_g3=""
attempt=0
while [ "$attempt" -lt 30 ]; do
    label_g3="$(cfg gateway)"
    if [ "$label_g3" = "refresh-v3" ]; then break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$label_g3" = "refresh-v3" ] || fail "gateway still '$label_g3' instead of refresh-v3 after the target=gateway bus flip"
for member in dispatcher insight events; do
    label_n="$(cfg $member)"
    [ "$label_n" = "refresh-v2" ] \
        || fail "$member REBOUND on a target=gateway flip ('$label_n' instead of refresh-v2) — the target grammar is not being enforced"
done
echo "  /gateway/config answers refresh-v3; dispatcher/insight/events stay refresh-v2 — the target grammar held fleet-wide"

echo "PASS: fleet smoke — one notice moved all four members; target=gateway moved only the gateway; same pids"
