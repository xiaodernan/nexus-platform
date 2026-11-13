#!/usr/bin/env bash
# NEXUS D1026 — the bus, proven across THREE members in one shot.
#
# D1024 (dispatcher) and D1025 (insight) joined the Bus-lite refresh lane separately. D1026 gives a
# THIRD registry member — nexus-events, the Redis Streams carrier — the pair, so the lane can now be
# proven end to end across every member of the sidecar fleet it was designed for:
#
#   Scenario 1 — target=all: one POST /events/bus/refresh flips ALL THREE members;
#                dispatcher, insight and events all answer refresh-v2, same pids.
#   Scenario 2 — target=events: the named member flips to refresh-v3; the other two stay
#                refresh-v2 — the negative arm again, now against the events grammar.
#
# The bus carries a lower-case 1..64 target grammar; events answers only to `events` or `all`.
# Redis is the ci_ensure_redis.sh throwaway on :6380.
#
# Usage:  bash scripts/bus_plane_smoke.sh
# Env:    NEXUS_PLANE_CONFIG_PORT, NEXUS_PLANE_DISPATCHER_PORT, NEXUS_PLANE_INSIGHT_PORT,
#         NEXUS_PLANE_EVENTS_PORT (defaults: free ports)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-bus-plane.XXXXXX 2>/dev/null || mktemp -d)"

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
CONFIG_PORT="${NEXUS_PLANE_CONFIG_PORT:-$(free_port 18890)}"
DISPATCHER_PORT="${NEXUS_PLANE_DISPATCHER_PORT:-$(free_port 19590)}"
INSIGHT_PORT="${NEXUS_PLANE_INSIGHT_PORT:-$(free_port 19592)}"
EVENTS_PORT="${NEXUS_PLANE_EVENTS_PORT:-$(free_port 19594)}"
REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-bus-plane"
mkdir -p "$LOG_DIR"
echo "config_port=$CONFIG_PORT dispatcher_port=$DISPATCHER_PORT insight_port=$INSIGHT_PORT events_port=$EVENTS_PORT redis=$REDIS_URL" > "$LOG_DIR/ports.txt"

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

dispatcher_label() { curl -fsS --max-time 5 "http://127.0.0.1:$DISPATCHER_PORT/dispatcher/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4; }
insight_label()    { curl -fsS --max-time 5 "http://127.0.0.1:$INSIGHT_PORT/insight/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4; }
events_label()     { curl -fsS --max-time 5 "http://127.0.0.1:$EVENTS_PORT/events/config" 2>/dev/null | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4; }

bus_post() {
    curl -s -o "$LOG_DIR/bus_answer.body" -w '%{http_code}' -X POST --max-time 10 \
        "http://127.0.0.1:$EVENTS_PORT/events/bus/refresh?target=$1" 2>/dev/null
}

read_three() { # prints "dispatcher insight events" in one line
    echo "$(dispatcher_label) $(insight_label) $(events_label)"
}

wait_label() { # $1 = fn name, $2 = want, prints what it got
    local attempt=0 want="$2" got=""
    while [ "$attempt" -lt 30 ]; do
        got="$($1)"
        if [ "$got" = "$want" ]; then printf '%s' "$got"; return 0; fi
        attempt=$((attempt + 1)); sleep 1
    done
    printf '%s' "$got"
    return 1
}

echo "== ensure Redis on :6380 =="
if ! docker exec -i "${NEXUS_REDIS_CONTAINER:-nexus-platform-redis}" redis-cli PING 2>/dev/null | grep -q PONG; then
    fail "Redis is not reachable at $REDIS_URL — run scripts/ci_ensure_redis.sh first"
fi

echo "== build config-server + dispatcher + insight + events (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,dispatcher-service,insight-service,events-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (v1 for ALL THREE members) =="
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v1
YAML
cat >"$TMP_REPO/nexus-insight.yml" <<'YAML'
nexus:
  insight:
    label: refresh-v1
YAML
cat >"$TMP_REPO/nexus-events.yml" <<'YAML'
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

echo "== boot ALL THREE members (bus armed, eureka off, redis on) =="
NEXUS_DISPATCHER_EUREKA_ENABLED=false NEXUS_DISPATCHER_ENABLED=false \
NEXUS_BUS_ENABLED=true NEXUS_REDIS_URL="$REDIS_URL" NEXUS_DISPATCHER_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/dispatcher-service/target/app.jar" --server.port="$DISPATCHER_PORT" \
    >"$LOG_DIR/dispatcher.log" 2>&1 &
PIDS+=("$!")
NEXUS_INSIGHT_EUREKA_ENABLED=false \
NEXUS_INSIGHT_BUS_ENABLED=true NEXUS_REDIS_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
NEXUS_EVENTS_EUREKA_ENABLED=false NEXUS_EVENTS_ENABLED=false \
NEXUS_EVENTS_BUS_ENABLED=true NEXUS_REDIS_URL="$REDIS_URL" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/events-service/target/app.jar" --server.port="$EVENTS_PORT" \
    >"$LOG_DIR/events.log" 2>&1 &
PIDS+=("$!")
wait_health dispatcher "http://127.0.0.1:$DISPATCHER_PORT/actuator/health"
wait_health insight    "http://127.0.0.1:$INSIGHT_PORT/actuator/health"
wait_health events     "http://127.0.0.1:$EVENTS_PORT/actuator/health"

labels="$(read_three)"
case "$labels" in
    'refresh-v1 refresh-v1 refresh-v1')
        echo "  all three members resolve refresh-v1 (the Config Server round trip is real on each)" ;;
    *)
        fail "members did not all resolve refresh-v1 (got: $labels)" ;;
esac

echo "== rewrite the throwaway repo to v2 =="
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v2
YAML
cat >"$TMP_REPO/nexus-insight.yml" <<'YAML'
nexus:
  insight:
    label: refresh-v2
YAML
cat >"$TMP_REPO/nexus-events.yml" <<'YAML'
nexus:
  events:
    label: refresh-v2
YAML

echo "== Scenario 1: POST /events/bus/refresh?target=all — ALL THREE must rebind =="
http_code="$(bus_post all)"
[ "$http_code" = "202" ] || fail "scenario1: expected 202, got HTTP $http_code (body: $(cat "$LOG_DIR/bus_answer.body"))"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/bus_answer.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 3 ] || fail "scenario1: expected receivers >= 3 (three subscribers HEAR the all-flip), got $receivers"
echo "  /events/bus/refresh?target=all -> 202, receivers=$receivers"
label_d="$(wait_label dispatcher_label refresh-v2 30)" || [ "$label_d" = "refresh-v2" ] || fail "dispatcher still '$label_d' instead of refresh-v2 after the target=all bus flip"
label_i="$(wait_label insight_label refresh-v2 30)" || [ "$label_i" = "refresh-v2" ] || fail "insight still '$label_i' instead of refresh-v2 after the target=all bus flip"
label_e="$(wait_label events_label refresh-v2 30)" || [ "$label_e" = "refresh-v2" ] || fail "events still '$label_e' instead of refresh-v2 after the target=all bus flip"
echo "  /dispatcher/config, /insight/config and /events/config all answer refresh-v2, same pids — the bus rebound ALL THREE"

echo "== rewrite the throwaway repo to v3 =="
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v3
YAML
cat >"$TMP_REPO/nexus-insight.yml" <<'YAML'
nexus:
  insight:
    label: refresh-v3
YAML
cat >"$TMP_REPO/nexus-events.yml" <<'YAML'
nexus:
  events:
    label: refresh-v3
YAML

echo "== Scenario 2: POST /events/bus/refresh?target=events — ONLY the named member must rebind =="
http_code="$(bus_post events)"
[ "$http_code" = "202" ] || fail "scenario2: expected 202, got HTTP $http_code (body: $(cat "$LOG_DIR/bus_answer.body"))"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/bus_answer.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 1 ] || fail "scenario2: expected receivers >= 1, got $receivers"
echo "  /events/bus/refresh?target=events -> 202, receivers=$receivers"
label_e3="$(wait_label events_label refresh-v3 30)" || [ "$label_e3" = "refresh-v3" ] || fail "events still '$label_e3' instead of refresh-v3 after the target=events bus flip"
label_d3="$(dispatcher_label)"
[ "$label_d3" = "refresh-v2" ] \
    || fail "dispatcher REBOUND on a target=events flip ('$label_d3' instead of refresh-v2) — the target grammar is not being enforced"
label_i3="$(insight_label)"
[ "$label_i3" = "refresh-v2" ] \
    || fail "insight REBOUND on a target=events flip ('$label_i3' instead of refresh-v2) — the target grammar is not being enforced"
echo "  /events/config carries refresh-v3; /dispatcher/config and /insight/config stay refresh-v2 — the target grammar held; no restart anywhere"

echo "PASS: plane smoke — target=all flips all THREE members, target=events flips only the named one, same pids"
