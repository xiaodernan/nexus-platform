#!/usr/bin/env bash
# NEXUS cloud refresh smoke: prove the edge picks up a config-repo edit WITHOUT a restart.
#
#   1. boot a config server against a THROWAWAY repo dir (the committed config-repo is never touched)
#   2. boot the gateway against it; /cloud/info shows the label from the repo (refresh-v1)
#   3. rewrite the repo file with a new label (refresh-v2)
#   4. POST the gateway's /actuator/refresh (no restart — the same pid serves the next read)
#   5. /cloud/info now shows refresh-v2: the config hot-refresh round trip actually works
#
# Why: "config server serves a file" (cloud_smoke.sh) proves a snapshot; config you cannot flip
# without a restart is decoration. This smoke is the difference.
#
# Usage:  scripts/cloud_refresh.sh
# Env:    NEXUS_SMOKE_EUREKA_PORT (unused), NEXUS_SMOKE_CONFIG_PORT, NEXUS_SMOKE_GATEWAY_PORT —
#         default to the modules' own declared ports, read the same way as cloud_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
module_port() {
    sed -n 's/^[[:space:]]*port:[[:space:]]*${[A-Z_]*:\([0-9]*\)}[[:space:]]*$/\1/p' \
        "$CLOUD/$1/src/main/resources/application.yaml" | head -1
}
CONFIG_PORT="${NEXUS_SMOKE_CONFIG_PORT:-$(module_port config-server)}"
GATEWAY_PORT="${NEXUS_SMOKE_GATEWAY_PORT:-$(module_port gateway)}"
TMP_REPO="$(mktemp -d /tmp/nexus-refresh-repo.XXXXXX 2>/dev/null || mktemp -d)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-refresh"
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
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS "$url" 2>/dev/null | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  $name healthy"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never became healthy (see $LOG_DIR/$name.log)"
}

info_label() {
    curl -fsS "http://127.0.0.1:$GATEWAY_PORT/cloud/info" 2>/dev/null \
        | grep -o '"label":"[^"]*"' | cut -d'"' -f4
}

[ -n "$CONFIG_PORT" ] && [ -n "$GATEWAY_PORT" ] \
    || fail "a module's application.yaml declares no \${ENV:<port>} default this script can read"

echo "== build =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "maven build"

echo "== write a throwaway repo (v1) =="
cat >"$TMP_REPO/nexus-gateway.yml" <<'YAML'
nexus:
  edge:
    label: refresh-v1
YAML
echo "  $TMP_REPO/nexus-gateway.yml carries refresh-v1"

echo "== start config server against the throwaway repo =="
# D993: method from cloud_monolith_refresh.sh — mktemp -d yields an absolute POSIX path on Linux
# (/tmp/...), which is already a valid file:// URI and must be used AS-IS; only Git Bash/MSYS2 needs
# cygpath -m to spell it as a drive letter (D:/...) the JVM can resolve. An unconditional cygpath made
# CI's Linux runner emit a bare "file:///" (command not found -> empty substitution), so the config
# server read the filesystem root, never saw nexus-gateway.yml, and the gateway fell back to label
# 'local' instead of the repo's refresh-v1. Guard on the command's presence, never assume it.
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

echo "== start gateway against it =="
export NEXUS_CONFIG_URI="http://127.0.0.1:$CONFIG_PORT"
export NEXUS_EUREKA_URI="http://127.0.0.1:18761/eureka/"
export NEXUS_PLATFORM_URI="http://127.0.0.1:9"
export NEXUS_AI_URI="http://127.0.0.1:9"
export NEXUS_WEB_URI="http://127.0.0.1:9"
export NEXUS_GATEWAY_RATE_BURST=1000
GATEWAY_PID=""
java -jar "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT" >"$LOG_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
PIDS+=("$GATEWAY_PID")
echo "  gateway started (pid $GATEWAY_PID)"
wait_health gateway "http://127.0.0.1:$GATEWAY_PORT/actuator/health"

label_v1="$(info_label)"
[ "$label_v1" = "refresh-v1" ] || fail "gateway resolved label '$label_v1' instead of the repo's refresh-v1"
echo "  /cloud/info carries refresh-v1 (the edge resolved the throwaway repo)"

echo "== rewrite the repo to v2 =="
cat >"$TMP_REPO/nexus-gateway.yml" <<'YAML'
nexus:
  edge:
    label: refresh-v2
YAML
served="$(curl -fsS "http://127.0.0.1:$CONFIG_PORT/nexus-gateway/default" 2>/dev/null)" \
    || fail "config server did not serve nexus-gateway/default after the rewrite"
echo "$served" | grep -q 'refresh-v2' || fail "config server still serves v1 after the rewrite: $served"
echo "  config server serves refresh-v2"

echo "== POST /actuator/refresh (no gateway restart — pid $GATEWAY_PID) =="
refresh_body="$(curl -sS -X POST "http://127.0.0.1:$GATEWAY_PORT/actuator/refresh" -H 'Content-Type: application/json' -w '\n%{http_code}')"
refresh_code="$(printf '%s' "$refresh_body" | tail -1)"
[ "$refresh_code" = "200" ] || fail "POST /actuator/refresh answered $refresh_code (see $LOG_DIR/gateway.log)"
echo "  /actuator/refresh -> 200$( [ -n "$(printf '%s' "$refresh_body" | head -1)" ] && printf ' (changed: %s)' "$(printf '%s' "$refresh_body" | head -1)")"

label_v2="$(info_label)"
[ "$label_v2" = "refresh-v2" ] \
    || fail "after refresh /cloud/info still carries '$label_v2' — the hot-refresh did not reach the bean"
echo "  /cloud/info carries refresh-v2 — the edge picked up the repo edit without a restart"

gateway_still=""
kill -0 "$GATEWAY_PID" 2>/dev/null && gateway_still=yes
[ "$gateway_still" = "yes" ] || fail "the gateway process died during the refresh"
[ "$(info_label)" = "refresh-v2" ] || fail "inconsistent read after refresh"

echo "PASS: cloud refresh smoke — a config-repo edit landed at the edge with no restart"
