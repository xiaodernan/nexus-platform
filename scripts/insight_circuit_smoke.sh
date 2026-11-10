#!/usr/bin/env bash
# NEXUS D895 (Phase G / G1) — the fifth service's breaker STATE, not just its fallback answer.
#
#   D885 shipped resilience4j `fallback=` on both Feign clients and proved the ANSWER is honest:
#   with no registry, /insight/plane says `unavailable`, never `UP`. But an honest answer does not
#   prove a circuit breaker ever opened — a client with no breaker would produce the same words.
#   This smoke makes the mechanism observable:
#
#     1. expose /actuator/circuitbreakers on nexus-insight (application.yaml, D895)
#     2. boot with Eureka DISABLED, so both lb:// lookups have no instance
#     3. drive enough /insight/plane calls to satisfy the configured sliding window
#     4. assert at least one breaker's REAL state is OPEN (or HALF_OPEN)
#     5. assert the aggregated view STILL reports both rows non-UP with all_up=false
#
#   FALSIFIER ARM: NEXUS_CIRCUIT_SKIP_DRIVE=1 boots the same process but performs NO driving
#   calls, then runs the SAME "a breaker must be OPEN" assertion. It MUST fail. If the smoke went
#   green without the failures that are supposed to open the breaker, the state reading is decoration.
#
#   NOT CLAIMED: a real platform/AI product, recovery to CLOSED, half-open transition timing,
#   metrics persistence, per-instance tuning, or production thresholds. Two Feign clients and one
#   throwaway process on a dev plane.
#
# Usage:  bash scripts/insight_circuit_smoke.sh
# Env:    NEXUS_CIRCUIT_PORT (19561), NEXUS_CIRCUIT_SKIP_BUILD=1 (jar must exist),
#         NEXUS_CIRCUIT_SKIP_DRIVE=1 (the falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
PORT="${NEXUS_CIRCUIT_PORT:-19561}"
SKIP_DRIVE="${NEXUS_CIRCUIT_SKIP_DRIVE:-0}"
LOG_SUFFIX=""
[ "$SKIP_DRIVE" = 1 ] && LOG_SUFFIX="-no-drive"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-circuit$LOG_SUFFIX"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

if [ "${NEXUS_CIRCUIT_SKIP_BUILD:-0}" != 1 ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl insight-service -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/insight-service/target/app.jar" ] || fail "skip requested but the insight jar is missing"
fi

echo "== boot insight on :$PORT with Eureka DISABLED =="
env NEXUS_INSIGHT_EUREKA_ENABLED=false \
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$PORT" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then
        ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$ready" = 1 ] || fail "insight never became healthy (see $LOG_DIR/insight.log)"
echo "  insight up on :$PORT"

fetch_breakers() {
    curl -fsS --max-time 5 -H 'Accept: application/json' \
        "http://127.0.0.1:$PORT/actuator/circuitbreakers" -o "$LOG_DIR/breakers.json" 2>/dev/null
}

probe_breakers() {
    python - "$1" "$2" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
cbs = body.get('circuitBreakers', {}) or {}
states = {}
for name, value in cbs.items():
    details = value.get('details') if isinstance(value, dict) else {}
    if not isinstance(details, dict):
        details = {}
    states[str(name)] = str(details.get('state') or value.get('state') or '') if isinstance(value, dict) else ''
mode = sys.argv[2]
open_states = ('OPEN', 'HALF_OPEN')
try:
    if mode == 'BASELINE':
        assert not any(s.upper() in open_states for s in states.values()), f"fresh process already open: {states}"
        print(f"  baseline: {len(states)} breaker(s), none open: {states}")
    elif mode == 'REQUIRE_OPEN':
        assert any(s.upper() in open_states for s in states.values()), f"no breaker is open: {states}"
        opened = {n: s for n, s in states.items() if s.upper() in open_states}
        print(f"  breaker(s) opened: {opened}")
    else:
        raise AssertionError(f"unknown probe mode {mode}")
except AssertionError as exc:
    print(f"  waiting: {exc}")
    raise SystemExit(1)
PY
}

echo "== the actuator really exposes breaker state =="
exposed=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    if fetch_breakers && probe_breakers "$LOG_DIR/breakers.json" BASELINE >"$LOG_DIR/probe.log" 2>&1; then
        exposed=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$exposed" = 1 ] || fail "/actuator/circuitbreakers is not readable or the fresh state is already open (see $LOG_DIR/insight.log)"
echo "  /actuator/circuitbreakers reachable"

if [ "$SKIP_DRIVE" != 1 ]; then
    echo "== drive the plane view past the breaker's minimum call count =="
    for i in $(seq 1 12); do
        curl -fsS --max-time 20 "http://127.0.0.1:$PORT/insight/plane" >"$LOG_DIR/plane-drive.json" 2>/dev/null \
            || fail "drive call $i failed (see $LOG_DIR/insight.log)"
    done
    echo "  12 calls completed"
else
    echo "== NO-DRIVE ARM: deliberately performing zero driving calls =="
fi

echo "== assert a breaker actually opened =="
budget=30
[ "$SKIP_DRIVE" = 1 ] && budget=6
opened=0; attempt=0
while [ "$attempt" -lt "$budget" ]; do
    if fetch_breakers && probe_breakers "$LOG_DIR/breakers.json" REQUIRE_OPEN >"$LOG_DIR/probe.log" 2>&1; then
        opened=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$opened" = 1 ] || fail "no breaker reached OPEN or HALF_OPEN — the state never moved (see $LOG_DIR/probe.log and $LOG_DIR/insight.log)"

echo "== the degraded view is still honest =="
curl -fsS --max-time 20 "http://127.0.0.1:$PORT/insight/plane" -o "$LOG_DIR/plane.json" 2>/dev/null \
    || fail "/insight/plane unreachable after the breaker opened"
python - "$LOG_DIR/plane.json" <<'PY' || fail "a fallback impersonated health after the breaker opened"
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
assert body.get('all_up') is False, body
rows = body.get('upstreams') or []
assert len(rows) == 2, rows
assert all(r.get('status') != 'UP' for r in rows), f"a fallback was reported as UP: {rows}"
print(f"  both rows still non-UP: {[(r['name'], r['status'], r['source']) for r in rows]}")
PY

echo "PASS: insight circuit smoke — the breaker really opened and the view stayed honest"
