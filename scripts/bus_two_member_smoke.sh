#!/usr/bin/env bash
# NEXUS D1025 — the plane's refresh bus, proven across TWO members in one shot.
#
# D1024 proved the lane end to end on the dispatcher (Phase 0/1/2: refusal, round trip).
# D1025 gives a SECOND registry member the subscriber + publisher halves (insight), making the
# bus a real two-member lane rather than a pair of copies. This smoke proves both halves live:
#
#   Scenario 1 — target=all: one POST /insight/bus/refresh rebinds BOTH members through the bus;
#                dispatcher's /dispatcher/config AND insight's /insight/config both advance
#                refresh-v1 → refresh-v2 on the same pids.
#   Scenario 2 — target=insight: the second POST flips ONLY the named member; insight advances
#                refresh-v2 → refresh-v3; the dispatcher stays refresh-v2 — the negative arm that
#                proves the target grammar is real, not decorative.
#
# Redis is the ci_ensure_redis.sh throwaway on :6380 — ci_ensure_redis.sh provides it.
#
# Usage:  bash scripts/bus_two_member_smoke.sh
# Env:    NEXUS_BUS_TWO_CONFIG_PORT (default: free), NEXUS_BUS_TWO_DISPATCHER_PORT / _INSIGHT_PORT (defaults: free)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-bus-two.XXXXXX 2>/dev/null || mktemp -d)"

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
CONFIG_PORT="${NEXUS_BUS_TWO_CONFIG_PORT:-$(free_port 18898)}"
DISPATCHER_PORT="${NEXUS_BUS_TWO_DISPATCHER_PORT:-$(free_port 19584)}"
INSIGHT_PORT="${NEXUS_BUS_TWO_INSIGHT_PORT:-$(free_port 19586)}"
REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-bus-two-member"
mkdir -p "$LOG_DIR"
echo "config_port=$CONFIG_PORT dispatcher_port=$DISPATCHER_PORT insight_port=$INSIGHT_PORT redis=$REDIS_URL" > "$LOG_DIR/ports.txt"

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

bus_post() { # $1 = target
    curl -s -o "$LOG_DIR/bus_answer.body" -w '%{http_code}' -X POST --max-time 10 \
        "http://127.0.0.1:$INSIGHT_PORT/insight/bus/refresh?target=$1" 2>/dev/null
}

wait_label() { # $1 = function name, $2 = want, $3 = tries (per-member 30 x 1s)
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

echo "== build config-server + dispatcher-service + insight-service (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,dispatcher-service,insight-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (v1: BOTH members on tag refresh-v1) =="
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

echo "== boot BOTH members (bus armed, eureka off, redis on) =="
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
wait_health dispatcher "http://127.0.0.1:$DISPATCHER_PORT/actuator/health"
wait_health insight    "http://127.0.0.1:$INSIGHT_PORT/actuator/health"

label_d="$(dispatcher_label)"; label_i="$(insight_label)"
[ "$label_d" = "refresh-v1" ] || fail "dispatcher resolved '$label_d' instead of refresh-v1"
[ "$label_i" = "refresh-v1" ] || fail "insight resolved '$label_i' instead of refresh-v1"
echo "  both members resolve refresh-v1 (the Config Server round trip is real for each)"

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

echo "== Scenario 1: POST /insight/bus/refresh?target=all — BOTH members must rebind =="
http_code="$(bus_post all)"
[ "$http_code" = "202" ] || fail "scenario1: expected 202, got HTTP $http_code (body: $(cat "$LOG_DIR/bus_answer.body"))"
grep -q '"receivers"' "$LOG_DIR/bus_answer.body" || fail "scenario1: no receivers in body: $(cat "$LOG_DIR/bus_answer.body")"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/bus_answer.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 2 ] || fail "scenario1: expected receivers >= 2 (both subscribers), got $receivers"
echo "  /insight/bus/refresh?target=all -> 202, receivers=$receivers"
label_i2="$(wait_label insight_label refresh-v2 30)" || [ "$label_i2" = "refresh-v2" ] || fail "insight still '$label_i2' instead of refresh-v2 after the target=all bus flip"
label_d2="$(wait_label dispatcher_label refresh-v2 30)" || [ "$label_d2" = "refresh-v2" ] || fail "dispatcher still '$label_d2' instead of refresh-v2 after the target=all bus flip"
echo "  /insight/config carries refresh-v2 AND /dispatcher/config carries refresh-v2, same pids — the bus rebound BOTH"

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

echo "== Scenario 2: POST /insight/bus/refresh?target=insight — ONLY the named member must rebind =="
http_code="$(bus_post insight)"
[ "$http_code" = "202" ] || fail "scenario2: expected 202, got HTTP $http_code (body: $(cat "$LOG_DIR/bus_answer.body"))"
receivers="$(grep -o '"receivers":[0-9]*' "$LOG_DIR/bus_answer.body" | cut -d: -f2)"
[ "${receivers:-0}" -ge 1 ] || fail "scenario2: expected receivers >= 1, got $receivers"
echo "  /insight/bus/refresh?target=insight -> 202, receivers=$receivers"
label_i3="$(wait_label insight_label refresh-v3 30)" || [ "$label_i3" = "refresh-v3" ] || fail "insight still '$label_i3' instead of refresh-v3 after the target=insight bus flip"
label_d3="$(dispatcher_label)"
[ "$label_d3" = "refresh-v2" ] \
    || fail "dispatcher REBOUND on a target=insight flip ('$label_d3' instead of refresh-v2) — the target grammar is not being enforced"
echo "  /insight/config carries refresh-v3; /dispatcher/config carries refresh-v2 — the target grammar held; no restart anywhere"

echo "PASS: two-member bus smoke — target=all flips both members, target=insight flips only the named one, same pids"
