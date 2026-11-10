#!/usr/bin/env bash
# NEXUS D889 — a config-repo edit lands at the FIFTH service without a restart.
#
# The gateway (D857) and the monolith (D872) already import the Config Server; nexus-insight did
# not. This smoke proves the fifth member's round trip end to end:
#   1. boot a Config Server against a THROWAWAY repo (the committed config-repo is never touched)
#   2. boot insight against it with Eureka disabled; /insight/config shows "refresh-v1"
#   3. rewrite the repo file to "refresh-v2"
#   4. POST /actuator/refresh — no restart, the same pid serves the next read
#   5. /insight/config now shows "refresh-v2", proving @RefreshScope rebound the value
#
# A config server that serves a file at boot is a snapshot. Config you cannot flip at runtime is
# decoration. The changed-key list from /actuator/refresh is checked too, so a 200 that changed
# nothing cannot pass.
#
# Usage:  bash scripts/insight_config_smoke.sh
# Env:    NEXUS_INSIGHT_CONFIG_PORT (18889), NEXUS_INSIGHT_CONFIG_SVC_PORT (19559)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
CONFIG_PORT="${NEXUS_INSIGHT_CONFIG_PORT:-18889}"
INSIGHT_PORT="${NEXUS_INSIGHT_CONFIG_SVC_PORT:-19559}"
TMP_REPO="$(mktemp -d /tmp/nexus-insight-config-repo.XXXXXX 2>/dev/null || mktemp -d)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-config"
mkdir -p "$LOG_DIR"

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

config_label() {
    curl -fsS --max-time 5 "http://127.0.0.1:$INSIGHT_PORT/insight/config" 2>/dev/null \
        | grep -o '"config_label":"[^"]*"' | cut -d'"' -f4
}

echo "== build config-server + insight (offline) =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl config-server,insight-service -DskipTests package \
    || fail "maven build"

echo "== write a throwaway config repo (v1) =="
cat >"$TMP_REPO/nexus-insight.yml" <<'YAML'
nexus:
  insight:
    label: refresh-v1
YAML

echo "== start Config Server on :$CONFIG_PORT against the throwaway repo =="
# Git Bash's mktemp dir lives in MSYS2's /tmp, which the JVM cannot resolve as a Windows path;
# cygpath -m gives the drive-letter spelling, as scripts/cloud_refresh.sh already established.
TMP_REPO_JAVA="file:///$(cygpath -m "$TMP_REPO" | sed 's|\\|/|g')"
java -jar "$CLOUD/config-server/target/app.jar" \
    --server.port="$CONFIG_PORT" \
    --spring.cloud.config.server.native.search-locations="$TMP_REPO_JAVA" \
    >"$LOG_DIR/config.log" 2>&1 &
PIDS+=("$!")
wait_health config "http://127.0.0.1:$CONFIG_PORT/actuator/health"

served_v1="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-insight/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-insight/default"
echo "$served_v1" | grep -q 'refresh-v1' || fail "config server did not serve v1: $served_v1"
echo "  config server serves refresh-v1"

echo "== boot insight on :$INSIGHT_PORT (Eureka off, config server on) =="
NEXUS_INSIGHT_EUREKA_ENABLED=false \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
    >"$LOG_DIR/insight.log" 2>&1 &
INSIGHT_PID=$!
PIDS+=("$INSIGHT_PID")
wait_health insight "http://127.0.0.1:$INSIGHT_PORT/actuator/health"

label_v1="$(config_label)"
[ "$label_v1" = "refresh-v1" ] \
    || fail "insight resolved '$label_v1' instead of the repo's refresh-v1 (is spring.config.import wired?)"
echo "  /insight/config carries refresh-v1 (the Config Server round trip is real)"

echo "== rewrite the repo to v2 =="
cat >"$TMP_REPO/nexus-insight.yml" <<'YAML'
nexus:
  insight:
    label: refresh-v2
YAML
served_v2="$(curl -fsS --max-time 5 "http://127.0.0.1:$CONFIG_PORT/nexus-insight/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-insight/default after the rewrite"
echo "$served_v2" | grep -q 'refresh-v2' || fail "config server still serves v1: $served_v2"
echo "  config server serves refresh-v2"

echo "== POST /actuator/refresh (no restart — pid $INSIGHT_PID) =="
refresh_body="$(curl -sS --max-time 15 -X POST \
    "http://127.0.0.1:$INSIGHT_PORT/actuator/refresh" \
    -H 'Content-Type: application/json' -w '\n%{http_code}' 2>/dev/null)"
refresh_code="$(printf '%s' "$refresh_body" | tail -1)"
[ "$refresh_code" = "200" ] || fail "POST /actuator/refresh answered ${refresh_code:-<none>} (see $LOG_DIR/insight.log)"
printf '%s' "$refresh_body" | grep -q 'nexus.insight.label' \
    || fail "refresh returned 200 but changed nothing useful: $refresh_body"
echo "  /actuator/refresh -> 200, changed keys include nexus.insight.label"

label_v2="$(config_label)"
[ "$label_v2" = "refresh-v2" ] \
    || fail "after refresh /insight/config still carries '$label_v2' — @RefreshScope did not rebind"
kill -0 "$INSIGHT_PID" 2>/dev/null || fail "insight died during the refresh (a restart would be a different claim)"
[ "$(config_label)" = "refresh-v2" ] || fail "inconsistent read after refresh"
echo "  /insight/config carries refresh-v2, same pid — no restart"

echo "PASS: insight config smoke — the fifth member imports the Config Server and hot-refreshes without a restart"
