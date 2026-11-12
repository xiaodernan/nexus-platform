#!/usr/bin/env bash
# NEXUS D993 — a config-repo edit lands at the SEVENTH service without a restart.
#
# The gateway (D857), the monolith (D872), insight (D889) — and dispatcher (D973) — all import the
# Config Server. Insight has a hot-refresh smoke (insight_config_smoke.sh); every service that
# advertises a config label needs the same proof, dispatcher was the missing member. This smoke:
#   1. boots a Config Server against a THROWAWAY config repo (the committed config-repo is never touched)
#   2. boots dispatcher against it with Eureka disabled; /dispatcher/config shows "refresh-v1"
#   3. rewrites the repo file to "refresh-v2"
#   4. POSTs /actuator/refresh — no restart, the same pid serves the next read
#   5. /dispatcher/config now shows "refresh-v2", proving @RefreshScope rebound the value
#
# A config server that serves a file at boot is a snapshot. Config you cannot flip at runtime is
# decoration. The changed-key list from /actuator/refresh is checked too, so a 200 that changed
# nothing cannot pass.
#
# Usage:  bash scripts/dispatcher_config_smoke.sh
# Env:    NEXUS_DISPATCHER_CONFIG_PORT (18891), NEXUS_DISPATCHER_CONFIG_SVC_PORT (19570)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TMP_REPO="$(mktemp -d /tmp/nexus-dispatcher-config.XXXXXX 2>/dev/null || mktemp -d)"

# D994: the throwaway plane picks ITS OWN free ports instead of trusting fixed coordinates — a
# stale listener from an aborted run would otherwise be mistaken for the just-started Config
# Server/dispatcher and silently poison the round trip (observed: refresh answered `[]` while a
# leftover JVM served the /actuator/refresh from its own dead repo). Env override still wins when
# the caller pins a port; otherwise the probe scans upward from the default until something free
# answers CONNECT refused.
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
CONFIG_PORT="${NEXUS_DISPATCHER_CONFIG_PORT:-$(free_port 18891)}"
DISPATCHER_PORT="${NEXUS_DISPATCHER_CONFIG_SVC_PORT:-$(free_port 19570)}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-dispatcher-config"
mkdir -p "$LOG_DIR"
{
    echo "config_port=$CONFIG_PORT dispatcher_port=$DISPATCHER_PORT" > "$LOG_DIR/ports.txt"
}

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

dispatcher_label() {
    curl -fsS --max-time 5 "http://127.0.0.1:$DISPATCHER_PORT/dispatcher/config" 2>/dev/null \
        | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4
}

echo "== build config-server + dispatcher-service (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,dispatcher-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (v1) =="
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

served_v1="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-dispatcher/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-dispatcher/default"
echo "$served_v1" | grep -q 'refresh-v1' || fail "config server did not serve v1: $served_v1"
echo "  config server serves refresh-v1"

echo "== boot dispatcher on :$DISPATCHER_PORT (Eureka off, config server on) =="
NEXUS_DISPATCHER_EUREKA_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/dispatcher-service/target/app.jar" --server.port="$DISPATCHER_PORT" \
    >"$LOG_DIR/dispatcher.log" 2>&1 &
DISPATCHER_PID=$!
PIDS+=("$DISPATCHER_PID")
wait_health dispatcher "http://127.0.0.1:$DISPATCHER_PORT/actuator/health"

label_v1="$(dispatcher_label)"
[ "$label_v1" = "refresh-v1" ] \
    || fail "dispatcher resolved '$label_v1' instead of the repo's refresh-v1 (is spring.config.import wired?)"
echo "  /dispatcher/config carries refresh-v1 (the Config Server round trip is real)"

echo "== rewrite the repo to v2 =="
cat >"$TMP_REPO/nexus-dispatcher.yml" <<'YAML'
nexus:
  dispatcher:
    label: refresh-v2
YAML
served_v2="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-dispatcher/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-dispatcher/default after the rewrite"
echo "$served_v2" | grep -q 'refresh-v2' || fail "config server still serves v1: $served_v2"
echo "  config server serves refresh-v2"

echo "== POST /actuator/refresh (no restart — pid $DISPATCHER_PID) =="
refresh_body="$(curl -sS --max-time 15 -X POST \
    "http://127.0.0.1:$DISPATCHER_PORT/actuator/refresh" \
    -H 'Content-Type: application/json' -w '\n%{http_code}' 2>/dev/null)"
refresh_code="$(printf '%s' "$refresh_body" | tail -1)"
[ "$refresh_code" = "200" ] || fail "POST /actuator/refresh answered ${refresh_code:-<none>} (see $LOG_DIR/dispatcher.log)"
printf '%s' "$refresh_body" | grep -q 'nexus.dispatcher.label' \
    || fail "refresh returned 200 but changed nothing useful: $refresh_body"
echo "  /actuator/refresh -> 200, changed keys include nexus.dispatcher.label"

label_v2="$(dispatcher_label)"
[ "$label_v2" = "refresh-v2" ] \
    || fail "after refresh /dispatcher/config still carries '$label_v2' — @RefreshScope did not rebind"
kill -0 "$DISPATCHER_PID" 2>/dev/null || fail "dispatcher died during the refresh (a restart would be a different claim)"
[ "$(dispatcher_label)" = "refresh-v2" ] || fail "inconsistent read after refresh"
echo "  /dispatcher/config carries refresh-v2, same pid — no restart"

echo "PASS: dispatcher config smoke — the seventh member imports the Config Server and hot-refreshes without a restart"
