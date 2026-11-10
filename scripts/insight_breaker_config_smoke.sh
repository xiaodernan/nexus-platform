#!/usr/bin/env bash
# NEXUS D899 (Phase G / G7) — the tuned breaker thresholds reach the breakers that ACTUALLY open.
#
#   D895 found a real mismatch: `application.yaml` declared resilience4j instances under the
#   REGISTRY names (`NEXUS-PLATFORM` / `NEXUS-AI`), but `/actuator/circuitbreakers` showed Feign
#   opening `PlatformHealthClienthealth` / `AiHealthClienthealth`. So the per-instance tuning was
#   DEAD CONFIG and every Feign breaker silently ran on `configs.default`.
#
#   D899 renames the declared instances to the REAL Feign names and gives them DIFFERENT,
#   measurable thresholds: AI `minimumNumberOfCalls: 3` / `failureRateThreshold: 40`,
#   platform `5` / `60`. This smoke does not trust the yaml. It reads
#   `/actuator/circuitbreakers` at boot and requires the aligned names with those exact visible
#   thresholds, then drives `/insight/plane` exactly FIVE times (each call exercises both Feign
#   clients) and requires the state to follow the tuning call by call:
#
#       call 1, 2   AI CLOSED          platform CLOSED
#       call 3      AI OPEN            platform CLOSED   <- AI's tuned minimum
#       call 4      platform CLOSED
#       call 5      platform OPEN                         <- platform's tuned minimum
#
#   A config edit that only LOOKS right (instances still under the old names) leaves both breakers
#   on `default` (minimum 3) and would open platform on call 3, so it cannot pass.
#
#   FALSIFIER ARM: NEXUS_BREAKER_FALSIFY=1 overrides BOTH instances' minimumNumberOfCalls to 10
#   from the command line. Everything else is identical; with a higher threshold the unchanged
#   "AI opens on call 3" assertion MUST fail. That red proves the green was caused by the tuned
#   threshold, not by a breaker that opens regardless of configuration.
#
#   NOT CLAIMED: recovery to CLOSED, half-open timing, production thresholds, metrics persistence,
#   a real platform/AI product, or that the registry names were ever valid breaker names.
#
# Usage:  bash scripts/insight_breaker_config_smoke.sh
# Env:    NEXUS_BREAKER_PORT (19564), NEXUS_BREAKER_SKIP_BUILD=1 (jar must exist),
#         NEXUS_BREAKER_FALSIFY=1 (the raised-threshold arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
PORT="${NEXUS_BREAKER_PORT:-19564}"
FALSIFY="${NEXUS_BREAKER_FALSIFY:-0}"

LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-breaker-config"
if [ "$FALSIFY" = 1 ]; then LOG_DIR="${LOG_DIR}-falsify"; fi
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

if [ "${NEXUS_BREAKER_SKIP_BUILD:-0}" != 1 ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl insight-service -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/insight-service/target/app.jar" ] || fail "skip requested but the insight jar is missing"
fi

echo "== boot insight on :$PORT with Eureka DISABLED =="
ARGS=("--server.port=$PORT")
if [ "$FALSIFY" = 1 ]; then
    # A command-line property REPLACES the whole `instances` map (measured: supplying only
    # minimumNumberOfCalls dropped both failureRateThreshold values back to default 50). So the
    # arm restates every instance property and changes EXACTLY ONE value per instance. The
    # actuator then still shows the aligned names and the 60/40 thresholds, so a red can only be
    # caused by the raised minimumNumberOfCalls, not by an instance that failed to bind.
    ARGS+=(
        "--resilience4j.circuitbreaker.instances[PlatformHealthClienthealth].baseConfig=default"
        "--resilience4j.circuitbreaker.instances[PlatformHealthClienthealth].failureRateThreshold=60"
        "--resilience4j.circuitbreaker.instances[PlatformHealthClienthealth].minimumNumberOfCalls=10"
        "--resilience4j.circuitbreaker.instances[AiHealthClienthealth].baseConfig=default"
        "--resilience4j.circuitbreaker.instances[AiHealthClienthealth].failureRateThreshold=40"
        "--resilience4j.circuitbreaker.instances[AiHealthClienthealth].minimumNumberOfCalls=10"
    )
    echo "  FALSIFIER ARM: both minimumNumberOfCalls raised to 10 on the command line"
fi
env NEXUS_INSIGHT_EUREKA_ENABLED=false NEXUS_CONFIG_URI="http://127.0.0.1:9" \
    java -jar "$CLOUD/insight-service/target/app.jar" "${ARGS[@]}" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
ready=0; attempt=0
while [ "$attempt" -lt 90 ]; do
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
cbs = json.load(open(sys.argv[1], encoding='utf-8')).get('circuitBreakers', {}) or {}
mode = sys.argv[2]
P, A = 'PlatformHealthClienthealth', 'AiHealthClienthealth'
def read(name):
    v = cbs.get(name) or {}
    return str(v.get('state', '')).upper(), str(v.get('failureRateThreshold', '')), int(v.get('bufferedCalls') or 0)
try:
    if mode == 'BASELINE':
        assert P in cbs and A in cbs, f"the aligned breaker names are absent; actuator lists {sorted(cbs)}"
        assert 'NEXUS-PLATFORM' not in cbs and 'NEXUS-AI' not in cbs, \
            f"the old registry-name instances are still declared: {sorted(cbs)}"
        ps, pf, _ = read(P)
        ai_s, ai_f, _ = read(A)
        assert pf == '60.0%', f"platform threshold was not applied: {pf}"
        assert ai_f == '40.0%', f"AI threshold was not applied: {ai_f}"
        assert ps == 'CLOSED' and ai_s == 'CLOSED', f"a fresh process already has an open breaker: {ps}/{ai_s}"
        print(f"  actuator: aligned names, thresholds {pf} / {ai_f}, both CLOSED")
    else:
        k = int(mode.split(':')[1])
        ps, _, pb = read(P)
        ai_s, _, ab = read(A)
        print(f"  call {k}: AI={ai_s}(buffered={ab}) platform={ps}(buffered={pb})")
        if k in (1, 2):
            assert ai_s == 'CLOSED', f"AI opened before its tuned minimumNumberOfCalls=3 (call {k})"
        if k == 3:
            assert ai_s in ('OPEN', 'HALF_OPEN'), \
                f"AI breaker did not open at its tuned minimumNumberOfCalls=3 (state={ai_s}, buffered={ab})"
        if k in (1, 2, 3, 4):
            assert ps == 'CLOSED', f"platform opened before its tuned minimumNumberOfCalls=5 (call {k})"
        if k == 5:
            assert ps in ('OPEN', 'HALF_OPEN'), \
                f"platform breaker did not open at its tuned minimumNumberOfCalls=5 (state={ps}, buffered={pb})"
except AssertionError as exc:
    print(f"  waiting: {exc}")
    raise SystemExit(1)
PY
}

echo "== the actuator shows the TUNED thresholds on the SAME names that will open =="
baseline=0; attempt=0
while [ "$attempt" -lt 20 ]; do
    if fetch_breakers && probe_breakers "$LOG_DIR/breakers.json" BASELINE >"$LOG_DIR/probe.log" 2>&1; then
        baseline=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$baseline" = 1 ] || { cat "$LOG_DIR/probe.log" 2>/dev/null; fail "the actuator does not show aligned, tuned breaker instances (see $LOG_DIR/insight.log)"; }

echo "== drive the plane view call by call and require the states to follow the tuning =="
for k in 1 2 3 4 5; do
    curl -fsS --max-time 20 "http://127.0.0.1:$PORT/insight/plane" -o "$LOG_DIR/plane.json" 2>/dev/null \
        || fail "drive call $k failed (see $LOG_DIR/insight.log)"
    if ! fetch_breakers || ! probe_breakers "$LOG_DIR/breakers.json" "CALL:$k" >"$LOG_DIR/probe.log" 2>&1; then
        cat "$LOG_DIR/probe.log" 2>/dev/null
        fail "breaker state did not follow the tuned thresholds at call $k"
    fi
    cat "$LOG_DIR/probe.log"
done

echo "== the degraded view is still honest =="
python - "$LOG_DIR/plane.json" <<'PY' || fail "a fallback impersonated health after both breakers opened"
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
assert body.get('all_up') is False, body
rows = body.get('upstreams') or []
assert len(rows) == 2, rows
assert all(r.get('status') != 'UP' for r in rows), f"a fallback was reported as UP: {rows}"
print(f"  both rows still non-UP: {[(r['name'], r['status']) for r in rows]}")
PY

echo "PASS: insight breaker config smoke — the tuned thresholds reached the breakers that opened"
