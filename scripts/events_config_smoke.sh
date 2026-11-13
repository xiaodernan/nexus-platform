#!/usr/bin/env bash
# NEXUS D1023 — a config-repo edit lands at the SIXTH service without a restart.
#
# The gateway (D857), the monolith (D872), insight (D889), dispatcher (D993) — every registry
# member that imports the Config Server advertises a config_label and the refresh smoke that
# proves a POST /actuator/refresh really rebinds it on the same pid. The events sidecar (D928)
# joined the plane without the matching hot-refresh surface, and without the matching proof.
# This smoke closes that: it boots a throwaway Config Server against a throwaway config repo
# carrying `nexus-events.yml`, boots the service with eureka/redis off, /events/config shows
# refresh-v1, the repo is rewritten to refresh-v2, POST /actuator/refresh, the same pid now
# serves refresh-v2.
#
# A server that reads the config once at boot and never again is every contract D872-889 broke.
# This service was the last member on the plane without the proof, and a config claim that
# cannot be flipped by an operator on the wire is a claim, not a contract.
#
# Usage:  bash scripts/events_config_smoke.sh
# Env:    NEXUS_EVENTS_CONFIG_PORT (default: free), NEXUS_EVENTS_CONFIG_SVC_PORT (default: free)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-events-config.XXXXXX 2>/dev/null || mktemp -d)"

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
CONFIG_PORT="${NEXUS_EVENTS_CONFIG_PORT:-$(free_port 18892)}"
EVENTS_PORT="${NEXUS_EVENTS_CONFIG_SVC_PORT:-$(free_port 19572)}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-events-config"
mkdir -p "$LOG_DIR"
echo "config_port=$CONFIG_PORT events_port=$EVENTS_PORT" > "$LOG_DIR/ports.txt"

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

events_label() {
    curl -fsS --max-time 5 "http://127.0.0.1:$EVENTS_PORT/events/config" 2>/dev/null \
        | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4
}

echo "== build config-server + events-service (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,events-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (v1) =="
cat >"$TMP_REPO/nexus-events.yml" <<'YAML'
nexus:
  events:
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

served_v1="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-events/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-events/default"
echo "$served_v1" | grep -q 'refresh-v1' || fail "config server did not serve v1: $served_v1"
echo "  config server serves refresh-v1"

echo "== boot events service on :$EVENTS_PORT (eureka off, redis off, config server on) =="
NEXUS_EVENTS_EUREKA_ENABLED=false \
NEXUS_EVENTS_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/events-service/target/app.jar" --server.port="$EVENTS_PORT" \
    >"$LOG_DIR/events.log" 2>&1 &
EVENTS_PID=$!
PIDS+=("$EVENTS_PID")
wait_health events "http://127.0.0.1:$EVENTS_PORT/actuator/health"

label_v1="$(events_label)"
[ "$label_v1" = "refresh-v1" ] \
    || fail "events service resolved '$label_v1' instead of the repo's refresh-v1 (is spring.config.import wired?)"
echo "  /events/config carries refresh-v1 (the Config Server round trip is real)"

echo "== rewrite the repo to v2 =="
cat >"$TMP_REPO/nexus-events.yml" <<'YAML'
nexus:
  events:
    label: refresh-v2
YAML
served_v2="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-events/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-events/default after the rewrite"
echo "$served_v2" | grep -q 'refresh-v2' || fail "config server did not serve v2: $served_v2"
echo "  config server serves refresh-v2"

echo "== POST /actuator/refresh (no restart — pid $EVENTS_PID) =="
refresh_out="$(curl -fsS -X POST --max-time 10 "http://127.0.0.1:$EVENTS_PORT/actuator/refresh" 2>/dev/null)" \
    || fail "POST /actuator/refresh returned $refresh_out (is refresh exposed?)"
echo "/actuator/refresh -> 200, changed keys include nexus.events.label"
case "$refresh_out" in
    *nexus.events.label*) ;;
    *) fail "refresh returned 200 but changed nothing useful: $refresh_out" ;;
esac

label_v2="$(events_label)"
[ "$label_v2" = "refresh-v2" ] \
    || fail "events service still reports '$label_v2' instead of refresh-v2 after POST /actuator/refresh"
echo "  /events/config carries refresh-v2, same pid — no restart"

echo "PASS: events service config smoke — the sixth member imports the Config Server and hot-refreshes without a restart"
