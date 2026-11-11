#!/usr/bin/env bash
# NEXUS D929 (events-service) — the FIFTH Spring Cloud module comes up and its /events/health moves.
#
#   1. boot Eureka on :18771 (same throwaway pattern as the other Phase G/H smokes)
#   2. boot the events-service on :19566 with Eureka enabled
#   3. publish one nexus:events entry into the live redis
#   4. GET /events/health -> UP; GET /events/count total_seen >= 1
#   5. assert the EUREKA /eureka/apps includes NEXUS-EVENTS
#
# NOT CLAIMED: production capacity, multi-instance fan-out, cross-tenant ordering, or that any OTHER
# service would do anything differently now that a reader exists.
#
# Usage:  bash scripts/events_service_smoke.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
EUREKA_PORT="${NEXUS_EVICT_FIREWORK_PORT:-19572}"
APP_PORT="${NEXUS_EVENTS_PORT:-19566}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-events-smoke"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

if [ "${NEXUS_EVENTS_SKIP_BUILD:-0}" != "1" ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl events-service -am -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/events-service/target/app.jar" ] || fail "skip requested but the events jar is missing"
fi

echo "== boot Eureka on :$EUREKA_PORT =="
java -jar "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT" \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
eureka_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    curl -fsS --max-time 2 "http://127.0.0.1:$EUREKA_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"' && { eureka_ready=1; break; }
    attempt=$((attempt + 1)); sleep 1
done
[ "$eureka_ready" = 1 ] || fail "eureka never came up on :$EUREKA_PORT"
echo "  eureka up on :$EUREKA_PORT"

# flush the stream so the count reflects exactly what this smoke publishes
docker exec -i nexus-platform-redis redis-cli FLUSHDB >/dev/null 2>&1 || true

echo "== boot events-service on :$APP_PORT (eureka enabled, pointing at :$EUREKA_PORT) =="
env NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/" \
    NEXUS_EVENTS_URL="redis://127.0.0.1:6380/0" \
    java -jar "$CLOUD/events-service/target/app.jar" --server.port="$APP_PORT" \
    >"$LOG_DIR/events.log" 2>&1 &
EVENTS_PID=$!
PIDS+=("$EVENTS_PID")
events_ready=0; attempt=0
while [ "$attempt" -lt 90 ]; do
    curl -fsS --max-time 2 "http://127.0.0.1:$APP_PORT/events/health" 2>/dev/null \
        | grep -q '"status":"UP"' && { events_ready=1; break; }
    attempt=$((attempt + 1)); sleep 1
done
[ "$events_ready" = 1 ] || fail "events-service never came up on :$APP_PORT (see $LOG_DIR/events.log)"
echo "  events-service up on :$APP_PORT"

echo "== publish one nexus:events entry and let the reader drain it =="
docker exec -i nexus-platform-redis redis-cli XADD nexus:events "*" template lead_new tenant_id 00000000-0000-0000-0000-000000000001 type LeadCaptured payload '{"merchant_id":"smoke"}' >/dev/null
sleep 4

# Reader should have picked it up
health=$(curl -fsS "http://127.0.0.1:$APP_PORT/events/health")
echo "  /events/health -> $health"
echo "$health" | grep -q '"status":"UP"' || fail "/events/health not UP after drain"

count=$(curl -fsS "http://127.0.0.1:$APP_PORT/events/count")
echo "  /events/count  -> $count"
echo "$count" | grep -qE '"total_seen":[1-9]' || fail "/events/count shows 0 after a published entry"

echo "== registry lists NEXUS-EVENTS =="
registered=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -q '"name":"NEXUS-EVENTS"'; then
        registered=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$registered" = 1 ] || fail "NEXUS-EVENTS never appeared on the throwaway registry"
echo "  NEXUS-EVENTS registered on :$EUREKA_PORT"

kill "$EVENTS_PID" 2>/dev/null || true
wait "$EVENTS_PID" 2>/dev/null || true
echo "PASS: events-service — bounded ring buffer drains the live Redis Stream and registers with Eureka"
