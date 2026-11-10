#!/usr/bin/env bash
# NEXUS D896 (Phase G / G2) — trace context survives DEGRADATION, measured on the wire.
#
#   D884 proved W3C propagation on ONE path: a 200 from a healthy echo fixture. But the
#   EdgeTracingFilter javadoc makes a stronger, never-measured claim — "a limiter's 429, a
#   breaker's 503 and a route miss all carry the id" — because the filter sets the response
#   headers BEFORE delegating, at HIGHEST_PRECEDENCE + 1. A claim in a comment is not a proof.
#
#   This smoke sends ONE inbound traceparent down THREE different gateway answers and requires
#   the SAME caller trace id to come back on each wire:
#
#     A. 200  /api/v1/health  -> healthy fixture          (the D884 case, kept as a control)
#     B. 503  /ai/v1/health   -> dead upstream, breaker fallback (edge_upstream_unavailable)
#     C. 429  /api/v1/health  -> rate-limited edge         (edge_rate_limited)
#
#   B and C are gateway-LOCAL answers: no downstream response exists, so the correlation id is
#   the only thing joining the refusal to the caller's trace. The two gateways differ only in
#   their limiter budget (1000 vs 1 token, no replenish) so each answer is attributable.
#
#   FALSIFIER ARM: NEXUS_TRACE_FALLBACK_NO_DEGRADE=1 points the AI route at the HEALTHY fixture
#   too. Case B then gets a 200 instead of an honest 503 and the unchanged assertion MUST fail,
#   while case A and both processes are proven up. See falsify_cloud_trace_fallback_smoke.sh.
#
#   NOT CLAIMED: a collector, span export, a real platform/AI product, an incident correlated
#   in logs, or trace propagation past a fallback into a downstream service (there is none).
#   This measures three response HEADERS on one throwaway gateway plane.
#
# Usage:  bash scripts/cloud_trace_fallback_smoke.sh
# Env:    NEXUS_TRACE_FALLBACK_FIXTURE_PORT (18103), NEXUS_TRACE_FALLBACK_GATEWAY_PORT (18095),
#         NEXUS_TRACE_FALLBACK_LIMIT_PORT (18096), NEXUS_TRACE_FALLBACK_SKIP_BUILD=1 (jar must exist),
#         NEXUS_TRACE_FALLBACK_NO_DEGRADE=1 (the falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
FIXTURE_PORT="${NEXUS_TRACE_FALLBACK_FIXTURE_PORT:-18103}"
GATEWAY_PORT="${NEXUS_TRACE_FALLBACK_GATEWAY_PORT:-18095}"
LIMIT_PORT="${NEXUS_TRACE_FALLBACK_LIMIT_PORT:-18096}"
NO_DEGRADE="${NEXUS_TRACE_FALLBACK_NO_DEGRADE:-0}"

LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-trace-fallback"
if [ "$NO_DEGRADE" = 1 ]; then LOG_DIR="${LOG_DIR}-no-degrade"; fi
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

INBOUND="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
TRACE="4bf92f3577b34da6a3ce929d0e0e4736"
INBOUND_SPAN="00f067aa0ba902b7"

header_of() {
    tr -d '\r' < "$1" | grep -i "^$2:" | head -1 | awk '{print $2}'
}
json_field() {
    python -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$1" "$2"
}
nested_field() {
    python -c 'import json,sys; print((json.load(open(sys.argv[1])).get(sys.argv[2]) or {}).get(sys.argv[3]) or "")' "$1" "$2" "$3"
}
wait_gateway() {
    local port="$1" attempt=0
    while [ "$attempt" -lt 120 ]; do
        if curl -fsS --max-time 2 "http://127.0.0.1:$port/actuator/health" 2>/dev/null \
            | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  gateway healthy on :$port"; return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "gateway on :$port never became healthy (see $LOG_DIR/gateway-$port.log)"
}
assert_trace_headers() {
    local label="$1" h="$2"
    local got_trace got_span
    got_trace="$(header_of "$h" 'x-trace-id')"
    got_span="$(header_of "$h" 'x-trace-span-id')"
    [ "$got_trace" = "$TRACE" ] \
        || fail "$label echoed X-Trace-Id '$got_trace' instead of the caller's '$TRACE'"
    [[ "$got_span" =~ ^[0-9a-f]{16}$ ]] \
        || fail "$label X-Trace-Span-Id is not a 16-hex child span: '$got_span'"
    [ "$got_span" != "$INBOUND_SPAN" ] \
        || fail "$label propagated the caller's span id instead of minting a child span"
    echo "  $label kept trace=$got_trace child_span=$got_span"
}

if [ "${NEXUS_TRACE_FALLBACK_SKIP_BUILD:-0}" != 1 ]; then
    echo "== build gateway =="
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl gateway -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/gateway/target/app.jar" ] || fail "skip requested but the gateway jar is missing"
fi

echo "== start trace-echo fixture on :$FIXTURE_PORT =="
TRACE_PORT="$FIXTURE_PORT" python "$ROOT/scripts/fixture_trace_echo.py" \
    >"$LOG_DIR/fixture.log" 2>&1 &
PIDS+=("$!")
fixture_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$FIXTURE_PORT/ready" -o /dev/null 2>/dev/null; then
        fixture_ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$fixture_ready" = 1 ] || fail "fixture never came up (see $LOG_DIR/fixture.log)"
echo "  fixture up on :$FIXTURE_PORT"

if [ "$NO_DEGRADE" = 1 ]; then
    AI_URI="http://127.0.0.1:$FIXTURE_PORT"
    echo "== NO-DEGRADE ARM: the AI route is deliberately pointed at the healthy fixture =="
else
    AI_URI="http://127.0.0.1:9"
fi

echo "== start gateway on :$GATEWAY_PORT (normal + fallback answers) =="
env NEXUS_EUREKA_URI="http://127.0.0.1:9/eureka/" \
    NEXUS_CONFIG_URI="http://127.0.0.1:9" \
    NEXUS_PLATFORM_URI="http://127.0.0.1:$FIXTURE_PORT" \
    NEXUS_AI_URI="$AI_URI" \
    NEXUS_WEB_URI="http://127.0.0.1:9" \
    NEXUS_GATEWAY_RATE_BURST=1000 \
    java -jar "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT" \
    >"$LOG_DIR/gateway-$GATEWAY_PORT.log" 2>&1 &
PIDS+=("$!")
wait_gateway "$GATEWAY_PORT"

echo "== case A: a NORMAL 200 still carries the caller's trace (control) =="
code="$(curl -s -D "$LOG_DIR/a.headers" -o "$LOG_DIR/a.json" -w '%{http_code}' --max-time 30 \
    -H "traceparent: $INBOUND" "http://127.0.0.1:$GATEWAY_PORT/api/v1/health")"
[ "$code" = "200" ] || fail "case A returned $code, expected a healthy 200"
assert_trace_headers "case A (200)" "$LOG_DIR/a.headers"
a_tp="$(json_field "$LOG_DIR/a.json" traceparent)"
[[ "$a_tp" == 00-"$TRACE"-* ]] \
    || fail "case A downstream saw a different traceparent: '$a_tp'"
[ "$(json_field "$LOG_DIR/a.json" x_trace_id)" = "$TRACE" ] \
    || fail "case A the fixture saw a different X-Trace-Id than the caller's"
echo "  case A: normal 200 keeps the caller's trace id, and the downstream saw it"

echo "== case B: a breaker's 503 FALLBACK still echoes the caller's trace =="
code="$(curl -s -D "$LOG_DIR/b.headers" -o "$LOG_DIR/b.json" -w '%{http_code}' --max-time 30 \
    -H "traceparent: $INBOUND" "http://127.0.0.1:$GATEWAY_PORT/ai/v1/health")"
[ "$code" = "503" ] \
    || fail "case B returned $code, expected an honest 503 fallback (the upstream was deliberately $AI_URI)"
assert_trace_headers "case B (503)" "$LOG_DIR/b.headers"
[ "$(nested_field "$LOG_DIR/b.json" error code)" = "edge_upstream_unavailable" ] \
    || fail "case B answered 503 but not the honest fallback envelope: $(cat "$LOG_DIR/b.json")"
b_req="$(nested_field "$LOG_DIR/b.json" error request_id)"
[ -n "$b_req" ] && [ "$b_req" != "unknown" ] \
    || fail "case B's fallback lost its request_id: '$b_req'"
echo "  case B: 503 fallback keeps the caller's trace id, request_id=$b_req"

echo "== start gateway on :$LIMIT_PORT with a one-token limiter (429 answer) =="
env NEXUS_EUREKA_URI="http://127.0.0.1:9/eureka/" \
    NEXUS_CONFIG_URI="http://127.0.0.1:9" \
    NEXUS_PLATFORM_URI="http://127.0.0.1:$FIXTURE_PORT" \
    NEXUS_AI_URI="http://127.0.0.1:9" \
    NEXUS_WEB_URI="http://127.0.0.1:9" \
    NEXUS_GATEWAY_RATE_BURST=1 \
    NEXUS_GATEWAY_RATE_REPLENISH=0 \
    java -jar "$CLOUD/gateway/target/app.jar" --server.port="$LIMIT_PORT" \
    >"$LOG_DIR/gateway-$LIMIT_PORT.log" 2>&1 &
PIDS+=("$!")
wait_gateway "$LIMIT_PORT"
# Management paths are exempt, so readiness polling did NOT consume the single token.

echo "== case C: the limiter's 429 still echoes the caller's trace =="
rate_limited=0
for i in $(seq 1 12); do
    code="$(curl -s -D "$LOG_DIR/c.headers" -o "$LOG_DIR/c.json" -w '%{http_code}' --max-time 30 \
        -H "traceparent: $INBOUND" "http://127.0.0.1:$LIMIT_PORT/api/v1/health")"
    if [ "$code" = "429" ]; then rate_limited=1; break; fi
done
[ "$rate_limited" = 1 ] || fail "no 429 was ever observed on the one-token edge (last code $code)"
assert_trace_headers "case C (429)" "$LOG_DIR/c.headers"
[ "$(nested_field "$LOG_DIR/c.json" error code)" = "edge_rate_limited" ] \
    || fail "case C answered 429 but not the honest limiter envelope: $(cat "$LOG_DIR/c.json")"
echo "  case C: 429 keeps the caller's trace id"

echo "PASS: cloud trace fallback smoke — 200 / 503 / 429 all echo the caller's W3C trace id"
