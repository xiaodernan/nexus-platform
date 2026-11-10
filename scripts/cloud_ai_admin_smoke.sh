#!/usr/bin/env bash
# NEXUS cloud AI-admin smoke (D877): prove the Spring Boot Admin sees the PYTHON service as UP.
#
# The admin-server — the plane's one window — can probe any instance that answers the actuator
# protocol. FastAPI is not a Spring app, and nothing about it ever will be; what it has is a
# three-endpoint shim (/actuator, /actuator/health, /actuator/info) that speaks the EXACT shape
# Spring Boot Admin parses (`{"status":"UP","groups":[...]}`).
#
#   1. boot eureka (the registry the AI registers into, opt-in)
#   2. boot the AI with NEXUS_AI_EUREKA_ENABLED=true (its own opt-in, unchanged)
#   3. boot the admin against the SAME eureka
#   4. poll :ADMIN/instances until NEXUS-AI is listed with status UP — the whole promise of D859
#      extended to the one non-JVM service on the plane
#
# Usage:  scripts/cloud_ai_admin_smoke.sh
# Env:    LAUNCH_AI_PORT (default 8012), NEXUS_SMOKE_EUREKA_PORT, NEXUS_SMOKE_AI_ADMIN_PORT (default 19451)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
AI_PORT="${LAUNCH_AI_PORT:-8012}"
EUREKA_PORT="${NEXUS_SMOKE_EUREKA_PORT:-18761}"
ADMIN_PORT="${NEXUS_SMOKE_AI_ADMIN_PORT:-19451}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-ai-admin"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
        kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    echo "logs: $LOG_DIR" >&2
    exit 1
}

module_port() {
    sed -n 's/^[[:space:]]*port:[[:space:]]*${[A-Z_]*:\([0-9]*\)}[[:space:]]*$/\1/p' \
        "$CLOUD/$1/src/main/resources/application.yaml" | head -1
}

wait_up() {
    local name="$1" url="$2" attempt=0
    while [ "$attempt" -lt 120 ]; do
        if curl -fsS "$url" 2>/dev/null | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  $name up on $url"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never came up on $url (see $LOG_DIR/$name.log)"
}

start() {
    local name="$1"; shift
    java -jar "$@" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!)"
}

if [ ! -x "$CLOUD/admin-server/target/app.jar" ] && [ ! -f "$CLOUD/admin-server/target/app.jar" ]; then
    echo "== admin-server jar missing — building reactor (this can take a while) =="
    mvn -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "reactor build"
fi

echo "== start eureka =="
start eureka "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT"
wait_up eureka "http://127.0.0.1:$EUREKA_PORT/actuator/health"

echo "== start the AI service with eureka opt-in on :$AI_PORT =="
env NEXUS_AI_HOST_PORT="$AI_PORT" \
    NEXUS_DATABASE_URL="${NEXUS_DATABASE_URL:-postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus_verify2}" \
    NEXUS_LLM_PROVIDER=mock \
    NEXUS_AI_EUREKA_ENABLED=true \
    NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/" \
    uv --directory "$ROOT/apps/ai" run python start_ai.py >"$LOG_DIR/ai.log" 2>&1 &
PIDS+=("$!")
echo "  ai started (pid $!)"
wait_up ai "http://127.0.0.1:$AI_PORT/actuator/health"

echo "== eureka lists NEXUS-AI =="
registered=0
attempt=0
while [ "$attempt" -lt 90 ]; do
    if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -q 'NEXUS-AI'; then
        registered=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$registered" = 1 ] || fail "eureka never listed NEXUS-AI (see $LOG_DIR/ai.log)"
echo "  NEXUS-AI registered (opt-in)"

echo "== start the admin against the same eureka =="
export NEXUS_ADMIN_PORT="$ADMIN_PORT"
export NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/"
start admin "$CLOUD/admin-server/target/app.jar" --server.port="$ADMIN_PORT"
wait_up admin "http://127.0.0.1:$ADMIN_PORT/actuator/health"

echo "== the admin shows NEXUS-AI as UP =="
found=0
attempt=0
while [ "$attempt" -lt 120 ]; do
    body="$(curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$ADMIN_PORT/instances" 2>/dev/null)"
    if printf '%s' "$body" | grep -q '"name":"NEXUS-AI"' && printf '%s' "$body" | grep -q '"status":"UP"'; then
        found=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$found" = 1 ] || fail "the admin never surfaced NEXUS-AI as UP (see $LOG_DIR/admin.log and :$ADMIN_PORT/instances)"
echo "  /instances carries NEXUS-AI with status UP — the AI speaks the admin protocol"

echo "PASS: cloud ai-admin smoke — the FastAPI service is visible UP in the Spring Boot Admin window"
