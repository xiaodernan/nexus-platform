#!/usr/bin/env bash
# NEXUS D919 (Phase H / H2) — the no-kill arm: a HEALTHY fixture must remain registered.
# D918 follows this shape: absence as falsifier. Here the falsifier proves the eviction
# reading was not a weather artifact: if a heartbeat-keeping fixture disappeared too,
# then "eviction works" is decoration.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_E="${NEXUS_EVICT_EUREKA_PORT:-18772}"
PORT_F="${NEXUS_EVICT_FIXTURE_PORT:-19172}"
APP="${NEXUS_EVICT_FIXTURE_APP:-NEXUS-EVICT-PROBE}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-eureka-eviction-falsify"
mkdir -p "$LOG_DIR"
PIDS=()
cleanup() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== boot single-node Eureka on :$PORT_E (NO-KILL arm) =="
java -jar "$ROOT/services/cloud/eureka-server/target/app.jar" --server.port="$PORT_E" \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT_E/actuator/health" 2>/dev/null \
      | grep -q '"status":"UP"' && { ready=1; break; }
  attempt=$((attempt + 1)); sleep 2
done
[ "$ready" = 1 ] || fail "eureka never came up (see $LOG_DIR/eureka.log)"

echo "== register the HEALTHY fixture as $APP =="
env INSIGHT_FIXTURE_APP="$APP" \
    INSIGHT_FIXTURE_PORT="$PORT_F" \
    INSIGHT_FIXTURE_PATH='evict/health' \
    INSIGHT_FIXTURE_EUREKA="http://127.0.0.1:$PORT_E/eureka/" \
    python "$ROOT/scripts/fixture_insight_upstream.py" >"$LOG_DIR/fixture.log" 2>&1 &
PIDS+=("$!")
registered=0; attempt=0
while [ "$attempt" -lt 90 ]; do
  if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$PORT_E/eureka/apps" 2>/dev/null \
      | grep -q "\"name\":\"$APP\""; then
    registered=1; break
  fi
  attempt=$((attempt + 1)); sleep 1
done
[ "$registered" = 1 ] || fail "fixture never registered (see $LOG_DIR/fixture.log)"

echo "== let it sit 65s with a 5s heartbeat — a healthy instance must not be evicted =="
sleep 65
if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$PORT_E/eureka/apps" 2>/dev/null \
    | grep -q "\"name\":\"$APP\""; then
  echo "  still listed after 65s: a heartbeat keeps its lease"
else
  fail "the HEALTHY fixture disappeared while being heartbeated — the D919 measurement is not trustworthy until this arm passes"
fi
echo "PASS: eureka eviction falsifier — a live, heartbeating instance stays listed (the kill was the signal)"
