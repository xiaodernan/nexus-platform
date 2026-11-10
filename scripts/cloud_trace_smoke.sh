#!/usr/bin/env bash
# NEXUS D884 — W3C trace-context propagation, measured on the wire.
#
#   1. boot a throwaway upstream that ECHOES the trace headers it receives
#   2. boot the gateway with NEXUS_PLATFORM_URI pointed at that fixture
#   3. a request with NO traceparent -> the edge mints a valid context, injects it downstream,
#      and echoes X-Trace-Id / X-Trace-Span-Id to the caller
#   4. a request WITH a valid traceparent -> the trace-id and flags survive, the span-id changes
#   5. a request with a MALFORMED traceparent -> a fresh trace-id, never the caller's bad one
#
# This proves propagation only. No collector, no span storage, no sampling claim.
#
# Usage:  bash scripts/cloud_trace_smoke.sh
# Env:    TRACE_PORT (fixture, default 18102), NEXUS_SMOKE_TRACE_GATEWAY_PORT (default 18094)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
TRACE_PORT="${TRACE_PORT:-18102}"
GATEWAY_PORT="${NEXUS_SMOKE_TRACE_GATEWAY_PORT:-18094}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-trace"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

wait_gateway() {
    local attempt=0
    while [ "$attempt" -lt 120 ]; do
        if curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/health" 2>/dev/null \
            | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  gateway healthy on :$GATEWAY_PORT"; return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "gateway never became healthy (see $LOG_DIR/gateway.log)"
}

header_of() {
    tr -d '\r' < "$1" | grep -i "^$2:" | head -1 | awk '{print $2}'
}
json_field() {
    python -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$1" "$2"
}
split_tp() {
    # echoes "traceid spanid flags" from a W3C traceparent string
    python -c 'import sys; p=sys.argv[1].split("-"); print(p[1],p[2],p[3]) if len(p)==4 else print("","","")' "$1"
}

echo "== build gateway =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl gateway -DskipTests package || fail "maven build"

echo "== start trace-echo fixture on :$TRACE_PORT =="
TRACE_PORT="$TRACE_PORT" python "$ROOT/scripts/fixture_trace_echo.py" >"$LOG_DIR/fixture.log" 2>&1 &
PIDS+=("$!")
fixture_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS "http://127.0.0.1:$TRACE_PORT/ready" -o /dev/null --max-time 2 2>/dev/null; then
        fixture_ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$fixture_ready" = 1 ] || fail "fixture never came up (see $LOG_DIR/fixture.log)"
echo "  fixture up on :$TRACE_PORT"

echo "== start gateway against the fixture =="
export NEXUS_EUREKA_URI="http://127.0.0.1:9/eureka/"
export NEXUS_CONFIG_URI="http://127.0.0.1:9"
export NEXUS_PLATFORM_URI="http://127.0.0.1:$TRACE_PORT"
export NEXUS_AI_URI="http://127.0.0.1:9"
export NEXUS_WEB_URI="http://127.0.0.1:9"
export NEXUS_GATEWAY_RATE_BURST=1000
java -jar "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT" \
    >"$LOG_DIR/gateway.log" 2>&1 &
PIDS+=("$!")
wait_gateway

URL="http://127.0.0.1:$GATEWAY_PORT/api/v1/health"

echo "== case 1: no inbound traceparent — the edge mints and injects =="
code="$(curl -s -D "$LOG_DIR/a.headers" -o "$LOG_DIR/a.json" -w '%{http_code}' --max-time 30 "$URL")"
[ "$code" = "200" ] || fail "case 1 returned $code, expected 200 (see $LOG_DIR/gateway.log)"
a_trace="$(header_of "$LOG_DIR/a.headers" 'x-trace-id')"
a_span="$(header_of "$LOG_DIR/a.headers" 'x-trace-span-id')"
[[ "$a_trace" =~ ^[0-9a-f]{32}$ ]] || fail "case 1 X-Trace-Id is not a 32-hex trace id: '$a_trace'"
[[ "$a_span" =~ ^[0-9a-f]{16}$ ]] || fail "case 1 X-Trace-Span-Id is not a 16-hex span id: '$a_span'"
a_tp="$(json_field "$LOG_DIR/a.json" traceparent)"
[[ "$a_tp" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] || fail "case 1 downstream saw no valid traceparent: '$a_tp'"
read -r tp_trace tp_span tp_flags <<< "$(split_tp "$a_tp")"
[ "$tp_trace" = "$a_trace" ] || fail "case 1 downstream trace id ($tp_trace) != echoed X-Trace-Id ($a_trace)"
[ "$tp_span" = "$a_span" ] || fail "case 1 downstream span id ($tp_span) != echoed X-Trace-Span-Id ($a_span)"
[ "$(json_field "$LOG_DIR/a.json" x_trace_id)" = "$a_trace" ] \
    || fail "case 1 X-Trace-Id header the fixture saw differs from the response header"
echo "  minted trace=$a_trace span=$a_span, downstream saw the same context"

echo "== case 2: a valid inbound context is continued, not restarted =="
INBOUND="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
code="$(curl -s -D "$LOG_DIR/b.headers" -o "$LOG_DIR/b.json" -w '%{http_code}' --max-time 30 \
    -H "traceparent: $INBOUND" "$URL")"
[ "$code" = "200" ] || fail "case 2 returned $code, expected 200"
b_trace="$(header_of "$LOG_DIR/b.headers" 'x-trace-id')"
[ "$b_trace" = "4bf92f3577b34da6a3ce929d0e0e4736" ] \
    || fail "case 2 trace id did not survive the hop: '$b_trace'"
b_tp="$(json_field "$LOG_DIR/b.json" traceparent)"
read -r b_tp_trace b_tp_span b_tp_flags <<< "$(split_tp "$b_tp")"
[ "$b_tp_trace" = "4bf92f3577b34da6a3ce929d0e0e4736" ] \
    || fail "case 2 downstream trace id changed: '$b_tp_trace'"
[ "$b_tp_span" != "00f067aa0ba902b7" ] \
    || fail "case 2 the edge propagated the caller's span id instead of minting a child span"
[ "$b_tp_flags" = "01" ] || fail "case 2 trace flags were not carried: '$b_tp_flags'"
echo "  trace id and flags preserved; child span=$b_tp_span"

echo "== case 3: a malformed context is replaced, never laundered =="
BAD="00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
code="$(curl -s -D "$LOG_DIR/c.headers" -o "$LOG_DIR/c.json" -w '%{http_code}' --max-time 30 \
    -H "traceparent: $BAD" "$URL")"
[ "$code" = "200" ] || fail "case 3 returned $code, expected 200"
c_trace="$(header_of "$LOG_DIR/c.headers" 'x-trace-id')"
[[ "$c_trace" =~ ^[0-9a-f]{32}$ ]] || fail "case 3 did not mint a fresh valid trace id: '$c_trace'"
[ "$c_trace" != "4bf92f3577b34da6a3ce929d0e0e4736" ] \
    || fail "case 3 echoed the malformed caller's trace id instead of replacing it"
c_tp="$(json_field "$LOG_DIR/c.json" traceparent)"
[[ "$c_tp" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] || fail "case 3 downstream saw an invalid context: '$c_tp'"
echo "  malformed header replaced with a fresh context ($c_trace)"

echo "PASS: cloud trace smoke — W3C traceparent minted, continued and rejected honestly across the edge"
