#!/usr/bin/env bash
# NEXUS cloud monolith-refresh smoke (D872): prove the MONOLITH picks up a config-repo edit
# WITHOUT a restart.
#
#   1. boot a config server against a THROWAWAY repo dir (the committed config-repo is never touched)
#   2. boot the platform (dev,cloud) against it with flyway off; /api/v1/cloud/info shows the
#      banner from the repo (monolith-refresh-v1) and config_source=config-server
#   3. rewrite the repo file with a new banner (monolith-refresh-v2)
#   4. POST the monolith's /actuator/refresh (no restart)
#   5. /api/v1/cloud/info now shows v2 — the monolith hot-refreshed too, not just the edge
#
# Why: D857 proved the EDGE hot-refreshes. The monolith never had an equivalent: this smoke is the
# platform half of the promise, and the difference between "config server serves a file" (a snapshot)
# and "config you can flip on the monolith without a restart" (a plane you can run on).
#
# Usage:  scripts/cloud_monolith_refresh.sh
# Env:    NEXUS_SMOKE_CONFIG_PORT, NEXUS_SMOKE_PLATFORM_PORT — default 18888/18098 (the module's
#         declared port values and a throwaway monolith port, never the demo's 18888/8090)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
PLATFORM="$ROOT/services/platform"
MVN="${MVN:-mvn}"
CONFIG_PORT="${NEXUS_SMOKE_CONFIG_PORT:-18888}"
MONOLITH_PORT="${NEXUS_SMOKE_PLATFORM_PORT:-18098}"
TMP_REPO="$(mktemp -d /tmp/nexus-monolith-refresh.XXXXXX 2>/dev/null || mktemp -d)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-monolith-refresh"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
        kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    rm -rf "$TMP_REPO"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    echo "logs: $LOG_DIR" >&2
    exit 1
}

wait_health() {
    local name="$1" url="$2" attempt=0
    while [ "$attempt" -lt 120 ]; do
        if curl -fsS "$url" 2>/dev/null | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  $name healthy"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never became healthy (see $LOG_DIR/$name.log)"
}

banner_now() {
    curl -fsS "http://127.0.0.1:$MONOLITH_PORT/api/v1/cloud/info" 2>/dev/null \
        | grep -o '"banner":"[^"]*"' | cut -d'"' -f4
}

source_now() {
    curl -fsS "http://127.0.0.1:$MONOLITH_PORT/api/v1/cloud/info" 2>/dev/null \
        | grep -o '"config_source":"[^"]*"' | cut -d'"' -f4
}

echo "== build =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -pl config-server -DskipTests package || fail "config-server build"
"$MVN" -q -B -f "$PLATFORM/pom.xml" -DskipTests package || fail "platform build"

echo "== write a throwaway repo (v1) =="
cat >"$TMP_REPO/nexus-platform.yml" <<'YAML'
nexus:
  platform:
    banner: monolith-refresh-v1
YAML
echo "  $TMP_REPO/nexus-platform.yml carries monolith-refresh-v1"

echo "== start config server against the throwaway repo =="
# Windows (Git Bash) needs drive-letter + forward slashes for the JVM; Linux CI already has an
# absolute POSIX path. Use cygpath only when present — a bare "file://$TMP_REPO" is correct on Linux.
if command -v cygpath >/dev/null 2>&1; then
    TMP_REPO_JAVA="file:///$(cygpath -m "$TMP_REPO" | sed 's|\\|/|g')"
else
    TMP_REPO_JAVA="file://$TMP_REPO"
fi
echo "  config repo location: $TMP_REPO_JAVA"
java -jar "$CLOUD/config-server/target/app.jar" \
    --server.port="$CONFIG_PORT" \
    --spring.cloud.config.server.native.search-locations="$TMP_REPO_JAVA" \
    >"$LOG_DIR/config.log" 2>&1 &
PIDS+=("$!")
wait_health config "http://127.0.0.1:$CONFIG_PORT/actuator/health"

echo "== start the monolith with the dev,cloud profile =="
PIDS_MONOLITH=""
cd "$PLATFORM"
SPRING_PROFILES_ACTIVE=dev,cloud \
NEXUS_PORT="$MONOLITH_PORT" \
NEXUS_DB_PASSWORD="${NEXUS_DB_PASSWORD:-nexus_dev_app_only}" \
SPRING_FLYWAY_ENABLED=false \
NEXUS_PLATFORM_DB_URL="${NEXUS_PLATFORM_DB_URL:-jdbc:postgresql://127.0.0.1:5433/nexus_verify2}" \
NEXUS_DB_URL="${NEXUS_DB_URL:-jdbc:postgresql://127.0.0.1:5433/nexus_verify2}" \
NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT" \
NEXUS_EUREKA_URI="http://127.0.0.1:9/eureka/" \
java -jar target/nexus-platform.jar >"$LOG_DIR/monolith.log" 2>&1 &
PIDS+=("$!")
MONOLITH_PID=$!
echo "  monolith started (pid $MONOLITH_PID)"
wait_health monolith "http://127.0.0.1:$MONOLITH_PORT/actuator/health"

banner_v1="$(banner_now)"
[ "$banner_v1" = "monolith-refresh-v1" ] \
    || fail "monolith resolved banner '$banner_v1' instead of the repo's monolith-refresh-v1"
case "$(source_now)" in
    config-server) echo "  /api/v1/cloud/info carries monolith-refresh-v1 (config_source=config-server)" ;;
    *)             fail "config_source '$(source_now)' instead of config-server" ;;
esac

echo "== rewrite the repo to v2 =="
cat >"$TMP_REPO/nexus-platform.yml" <<'YAML'
nexus:
  platform:
    banner: monolith-refresh-v2
YAML
served="$(curl -fsS "http://127.0.0.1:$CONFIG_PORT/nexus-platform/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-platform/default after the rewrite"
echo "$served" | grep -q 'monolith-refresh-v2' || fail "config server still serves v1: $served"
echo "  config server serves monolith-refresh-v2"

echo "== POST /actuator/refresh (no monolith restart — pid $MONOLITH_PID) =="
refresh_body="$(curl -sS -X POST "http://127.0.0.1:$MONOLITH_PORT/actuator/refresh" -H 'Content-Type: application/json' -w '\n%{http_code}')"
refresh_code="$(printf '%s' "$refresh_body" | tail -1)"
[ "$refresh_code" = "200" ] || fail "POST /actuator/refresh answered $refresh_code (see $LOG_DIR/monolith.log)"
echo "  /actuator/refresh -> 200$( [ -n "$(printf '%s' "$refresh_body" | head -1)" ] && printf ' (changed: %s)' "$(printf '%s' "$refresh_body" | head -1)")"

banner_v2="$(banner_now)"
[ "$banner_v2" = "monolith-refresh-v2" ] \
    || fail "after refresh /api/v1/cloud/info still carries '$banner_v2' — the hot-refresh did not reach the bean"
echo "  /api/v1/cloud/info carries monolith-refresh-v2 — the monolith picked up the repo edit without a restart"

monolith_still=""
kill -0 "$MONOLITH_PID" 2>/dev/null && monolith_still=yes
[ "$monolith_still" = "yes" ] || fail "the monolith process died during the refresh"

echo "PASS: cloud monolith-refresh smoke — a config-repo edit landed on the monolith with no restart"
