#!/usr/bin/env bash
# NEXUS D900 (Phase H / H1) — the fifth service joins the W3C trace plane as a PARTICIPANT.
#
#   D884 made the gateway the only trace-id ORIGIN and the FastAPI service a participant.
#   `nexus-insight` — the one component that CALLS two other services through lb:// — was still
#   trace-blind. D900 adds a strict participant filter plus a Feign RequestInterceptor. This smoke
#   proves the wire, not the source:
#
#     A. one inbound traceparent -> `/insight/plane` answers 200 with both upstreams UP, the
#        RESPONSE echoes the caller's X-Trace-Id under a NEW child span, and BOTH registered
#        fixtures log a traceparent with that SAME trace id (the Feign interceptor propagated it);
#     B. a second insight with Eureka DISABLED -> the Feign fallback answers `unavailable` yet
#        its RESPONSE still echoes the SAME caller trace id, so a degraded hop is correlatable.
#
#   The service MINTS NOTHING: a malformed or absent context gets no invented headers (the unit
#   tests own that case). Propagation is not export — there is no collector on this plane.
#
#   FALSIFIER ARM: NEXUS_INSIGHT_TRACE_DISABLE=1 boots insight with
#   `--nexus.insight.trace.enabled=false`. The same wire assertions MUST fail while the registry,
#   both fixtures and the 200 plane view are proven healthy, so the red is attributable to the
#   missing participation and not to a dead JVM or an unregistered upstream.
#
#   NOT CLAIMED: a collector, span export, a real platform/AI product (the upstreams are D887's
#   self-registering fixtures), trace propagation into a gateway-minted root, or a span tree.
#
# Usage:  bash scripts/insight_trace_smoke.sh
# Env:    NEXUS_INSIGHT_TRACE_EUREKA_PORT (18766), NEXUS_INSIGHT_TRACE_PLATFORM_PORT (19131),
#         NEXUS_INSIGHT_TRACE_AI_PORT (19132), NEXUS_INSIGHT_TRACE_PORT (19567),
#         NEXUS_INSIGHT_TRACE_DEGRADED_PORT (19568), NEXUS_INSIGHT_TRACE_SKIP_BUILD=1,
#         NEXUS_INSIGHT_TRACE_DISABLE=1 (the falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
PY="${PY:-python}"
EUREKA_PORT="${NEXUS_INSIGHT_TRACE_EUREKA_PORT:-18766}"
PLATFORM_PORT="${NEXUS_INSIGHT_TRACE_PLATFORM_PORT:-19131}"
AI_PORT="${NEXUS_INSIGHT_TRACE_AI_PORT:-19132}"
INSIGHT_PORT="${NEXUS_INSIGHT_TRACE_PORT:-19567}"
DEGRADED_PORT="${NEXUS_INSIGHT_TRACE_DEGRADED_PORT:-19568}"
DISABLE="${NEXUS_INSIGHT_TRACE_DISABLE:-0}"

INBOUND="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
TRACE="4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN="00f067aa0ba902b7"

LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-trace"
if [ "$DISABLE" = 1 ]; then LOG_DIR="${LOG_DIR}-disabled"; fi
mkdir -p "$LOG_DIR"
EUREKA_BASE="http://127.0.0.1:$EUREKA_PORT/eureka"
EUREKA_URL="$EUREKA_BASE/"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

header_of() { tr -d '\r' < "$1" | grep -i "^$2:" | head -1 | awk '{print $2}'; }
plane_is() {
    "$PY" - "$1" "$2" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
mode = sys.argv[2]
rows = body.get('upstreams') or []
assert len(rows) == 2, rows
if mode == 'ALL_UP':
    assert body.get('all_up') is True, body
    assert all(r.get('status') == 'UP' and r.get('source') == 'upstream' for r in rows), rows
    print('  plane A: all_up=true, both rows UP')
elif mode == 'DEGRADED':
    assert body.get('all_up') is False, body
    assert all(r.get('status') != 'UP' for r in rows), rows
    print(f"  plane B: all_up=false, both rows non-UP: {[(r['name'], r['status']) for r in rows]}")
else:
    raise SystemExit(f'unknown mode {mode}')
PY
}
assert_trace() {
    local label="$1" h="$2"
    local got_trace got_span
    got_trace="$(header_of "$h" 'x-trace-id')"
    got_span="$(header_of "$h" 'x-trace-span-id')"
    [ "$got_trace" = "$TRACE" ] \
        || fail "the response did not echo the caller's X-Trace-Id ($label): got '$got_trace', want '$TRACE'"
    [[ "$got_span" =~ ^[0-9a-f]{16}$ ]] \
        || fail "$label X-Trace-Span-Id is not a child span: '$got_span'"
    [ "$got_span" != "$PARENT_SPAN" ] \
        || fail "$label propagated the caller's span id instead of minting a child span"
    echo "  $label kept trace=$got_trace child_span=$got_span"
}

if [ "${NEXUS_INSIGHT_TRACE_SKIP_BUILD:-0}" != 1 ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl eureka-server,insight-service -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/eureka-server/target/app.jar" ] && [ -f "$CLOUD/insight-service/target/app.jar" ] \
        || fail "skip requested but a required jar is missing"
fi

echo "== boot Eureka on :$EUREKA_PORT =="
java -jar "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT" \
    --eureka.server.use-read-only-response-cache=false \
    --eureka.server.response-cache-update-interval-ms=3000 \
    --eureka.server.enable-self-preservation=false \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
eureka_ready=0; attempt=0
while [ "$attempt" -lt 90 ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$EUREKA_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then eureka_ready=1; break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$eureka_ready" = 1 ] || fail "Eureka never became healthy (see $LOG_DIR/eureka.log)"
echo "  Eureka up on :$EUREKA_PORT"

start_fixture() {
    local app="$1" port="$2" path="$3" log="$4"
    INSIGHT_FIXTURE_APP="$app" INSIGHT_FIXTURE_PORT="$port" \
        INSIGHT_FIXTURE_PATH="$path" INSIGHT_FIXTURE_EUREKA="$EUREKA_URL" \
        "$PY" -u "$ROOT/scripts/fixture_insight_upstream.py" >"$LOG_DIR/$log" 2>&1 &
    PIDS+=("$!")
    local ok=0 n=0
    while [ "$n" -lt 60 ]; do
        if curl -fsS --max-time 2 "http://127.0.0.1:$port/__control/ping" 2>/dev/null \
            | grep -qF "$app"; then ok=1; break; fi
        n=$((n + 1)); sleep 1
    done
    [ "$ok" = 1 ] || fail "$app fixture never listened (see $LOG_DIR/$log)"
    echo "  $app fixture on :$port answers $path"
}

echo "== register both upstreams BEFORE insight boots =="
start_fixture NEXUS-PLATFORM "$PLATFORM_PORT" api/v1/health platform.log
start_fixture NEXUS-AI "$AI_PORT" ai/v1/health ai.log

echo "== boot insight on :$INSIGHT_PORT against that registry =="
INSIGHT_ARGS=("--server.port=$INSIGHT_PORT"
    "--eureka.client.service-url.defaultZone=$EUREKA_URL"
    "--eureka.client.registry-fetch-interval-seconds=5")
if [ "$DISABLE" = 1 ]; then
    INSIGHT_ARGS+=("--nexus.insight.trace.enabled=false")
    echo "  FALSIFIER ARM: trace participation deliberately disabled in this process"
fi
java -jar "$CLOUD/insight-service/target/app.jar" "${INSIGHT_ARGS[@]}" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$INSIGHT_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then ready=1; break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$ready" = 1 ] || fail "insight never became healthy (see $LOG_DIR/insight.log)"
echo "  insight UP on :$INSIGHT_PORT"
sleep 5

echo "== phase A: ONE inbound traceparent reaches BOTH lb:// upstreams =="
code="$(curl -s -D "$LOG_DIR/a.headers" -o "$LOG_DIR/a.json" -w '%{http_code}' --max-time 25 \
    -H "traceparent: $INBOUND" "http://127.0.0.1:$INSIGHT_PORT/insight/plane")"
[ "$code" = "200" ] || fail "phase A returned $code, expected 200 (see $LOG_DIR/insight.log)"
plane_is "$LOG_DIR/a.json" ALL_UP || fail "phase A did not reach both live upstreams"
assert_trace "phase A (200)" "$LOG_DIR/a.headers"
for pair in "NEXUS-PLATFORM:platform.log" "NEXUS-AI:ai.log"; do
    app="${pair%%:*}"; log="${pair##*:}"
    grep -qF "traceparent=00-$TRACE-" "$LOG_DIR/$log" \
        || fail "no propagated traceparent reached the upstreams ($app fixture logged no child context for trace $TRACE)"
    echo "  $app fixture logged the propagated traceparent"
done

echo "== phase B: a DEGRADED insight still echoes the same caller trace =="
env NEXUS_INSIGHT_EUREKA_ENABLED=false NEXUS_CONFIG_URI="http://127.0.0.1:9" \
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$DEGRADED_PORT" \
    >"$LOG_DIR/insight-degraded.log" 2>&1 &
PIDS+=("$!")
degraded_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$DEGRADED_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then degraded_ready=1; break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$degraded_ready" = 1 ] || fail "the degraded insight never became healthy (see $LOG_DIR/insight-degraded.log)"
code="$(curl -s -D "$LOG_DIR/b.headers" -o "$LOG_DIR/b.json" -w '%{http_code}' --max-time 25 \
    -H "traceparent: $INBOUND" "http://127.0.0.1:$DEGRADED_PORT/insight/plane")"
[ "$code" = "200" ] || fail "phase B returned $code, expected 200"
plane_is "$LOG_DIR/b.json" DEGRADED || fail "phase B did not degrade honestly"
assert_trace "phase B (fallback)" "$LOG_DIR/b.headers"

echo "PASS: insight trace smoke — the fifth service propagates one W3C context through lb:// and echoes it on fallback"
