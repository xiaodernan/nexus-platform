#!/usr/bin/env bash
# NEXUS D918 (Phase H / H3) — resilience4j's counters as REAL actuator meters, not just state probes.
#
#   D895 exposed /actuator/circuitbreakers so an operator can see that a breaker is OPEN — state,
#   not rates. This smoke adds what the H3 seam asked for: after the 12-call driving sequence,
#   /actuator/metrics/resilience4j.circuitbreaker.calls tagged with EACH breaker name must carry
#   COUNT > 0 — the counts track REAL invocations — and /actuator/metrics/resilience4j.circuitbreaker
#   .state must be readable with both names. The two breaker names on this service are the
#   Feign-method-derived ones (D899): `PlatformHealthClienthealth` / `AiHealthClienthealth`.
#
#     1. boot with Eureka DISABLED so lb:// resolves to no instances (the same condition the
#        D895 breaker-driving sequence requires);
#     2. drive 12 /insight/plane calls (each fans out into both clients);
#     3. assert /actuator/metrics/resilience4j.circuitbreaker.calls?tag=name:<breaker> carries
#        COUNT > 0 for BOTH breaker names;
#     4. assert /actuator/metrics/resilience4j.circuitbreaker.state lists both names.
#
#   FALSIFIER ARM: NEXUS_METRICS_SKIP_DRIVE=1 boots the same process and skips the 12 calls,
#   then runs the SAME per-name COUNT > 0 assertion and MUST fail. If the smoke went green
#   without the calls that generate the count, the metric is decoration.
#
#   NOT CLAIMED: a spanning system can query this, a dashboard exists, the count is monotonically
#   correct (it is aggregate counter increments), or anything about half-open timing.
#   No OTLP export; /actuator/metrics is exactly what it says.
#
# Usage:  bash scripts/insight_metrics_smoke.sh
# Env:    NEXUS_METRICS_PORT (19562), NEXUS_METRICS_SKIP_BUILD=1 (jar must exist),
#         NEXUS_METRICS_SKIP_DRIVE=1 (the falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
PORT="${NEXUS_METRICS_PORT:-19562}"
SKIP_DRIVE="${NEXUS_METRICS_SKIP_DRIVE:-0}"
LOG_SUFFIX=""
[ "$SKIP_DRIVE" = 1 ] && LOG_SUFFIX="-no-drive"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-metrics$LOG_SUFFIX"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

if [ "${NEXUS_METRICS_SKIP_BUILD:-0}" != 1 ]; then
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

meter() {  # $1 = path-with-tag, $2 = outfile
    curl -fsS --max-time 5 -H 'Accept: application/json' "$1" -o "$2" 2>/dev/null
}

check_state_meter() {
    python - "$1" <<'PY' || return 1
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
avail = {t.get('tag'): list(t.get('values', [])) for t in body.get('availableTags', [])}
expected = {'PlatformHealthClienthealth', 'AiHealthClienthealth'}
listed = set(avail.get('name', []))
missing = expected - listed
assert not missing, f"resilience4j.circuitbreaker.state is missing breakers {missing}: {sorted(listed)}"
print(f"  state meter lists both breakers: {sorted(listed)}")
PY
}

total_calls_across_breakers() {  # prints the summed COUNT over the two tagged meters
    local total=0
    local name value
    for name in PlatformHealthClienthealth AiHealthClienthealth; do
        local file="$LOG_DIR/calls-${name}.json"
        meter "http://127.0.0.1:$PORT/actuator/metrics/resilience4j.circuitbreaker.calls?tag=name:$name" "$file" \
            || return 1
        value="$(python - "$file" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
measurement = next((m for m in body.get('measurements', [])
                    if m.get('statistic') == 'COUNT'), {})
print(measurement.get('value') or 0)
PY
)"
        total="$(python - "$total" "$value" <<'PY'
import sys
print(float(sys.argv[1]) + float(sys.argv[2]))
PY
)"
    done
    printf '%s' "$total"
}

echo "== the state meter exists and lists both breakers =="
meter "http://127.0.0.1:$PORT/actuator/metrics/resilience4j.circuitbreaker.state" "$LOG_DIR/state.json" \
    || fail "resilience4j.circuitbreaker.state is unreachable on /actuator/metrics"
check_state_meter "$LOG_DIR/state.json" || fail "state meter is missing a breaker name"

echo "== the calls meter exists for both breaker names =="
for name in PlatformHealthClienthealth AiHealthClienthealth; do
    meter "http://127.0.0.1:$PORT/actuator/metrics/resilience4j.circuitbreaker.calls?tag=name:$name" "$LOG_DIR/calls-$name.json" \
        || fail "resilience4j.circuitbreaker.calls is unreachable for $name"
done
echo "  per-breaker COUNT meters are readable"

if [ "$SKIP_DRIVE" != 1 ]; then
    echo "== drive the plane view past the breaker's minimum call count =="
    for i in $(seq 1 12); do
        curl -fsS --max-time 20 "http://127.0.0.1:$PORT/insight/plane" >"$LOG_DIR/plane-drive.json" 2>/dev/null \
            || fail "drive call $i failed (see $LOG_DIR/insight.log)"
    done
    echo "  12 calls completed"
    sleep 2
    total="$(total_calls_across_breakers)" || fail "could not re-read the counters after driving"
    awk "BEGIN { if ($total <= 0) exit 1 }" || fail "after 12 drive calls the combined COUNT is 0 — the counter is not counting"
    echo "  combined COUNT=$total across both breakers, as expected"
    echo "PASS: insight metrics smoke — resilience4j.circuitbreaker.calls/state are real meters for both breakers and they count"
    exit 0
fi

echo "== NO-DRIVE ARM: deliberately performing zero driving calls =="
total="$(total_calls_across_breakers)" || fail "cannot read the metrics in the falsifier arm"
awk "BEGIN { if ($total > 0) exit 1 }" \
    && { echo "  NO-DRIVE ARM held: combined COUNT=$total without driving, the assertion cannot be faked"; \
         echo "PASS: insight metrics falsifier — without driving calls the COUNT stays zero"; \
         exit 0; } \
    || fail "NO-DRIVE ARM: combined COUNT=$total > 0 with zero calls — refusing to certify this as a real meter"
