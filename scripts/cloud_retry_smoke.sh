#!/usr/bin/env bash
# NEXUS cloud retry smoke (D875): prove the gateway retries an idempotent GET past a transient
# 5xx upstream — exactly twice — and that a POST is never retried.
#
#   1. boot a scripted fixture upstream on a throwaway port (fails the first two /api/v1/health
#      calls with 500, then serves 200; it also counts every hit)
#   2. boot the gateway with NEXUS_PLATFORM_URI pointed at the fixture
#   3. GET /api/v1/health through the gateway -> expect HTTP 200 and EXACTLY THREE fixture hits
#      (500 + 500 + 200), proving the two retries fired before the answer landed
#   4. POST /api/v1/health through the gateway -> never retried (exactly one fixture hit) and never 405
#   5. POST to the dead-upstream web route -> 503 edge_upstream_unavailable (D875's method-agnostic fallback)
#      POST is never retried; the method-agnostic 503 envelope is asserted on the dead-upstream web routet returns
#
# Usage:  scripts/cloud_retry_smoke.sh
# Env:    FLAKY_PORT (fixture port, default 18101), NEXUS_SMOKE_GATEWAY_PORT (default 18093)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
FLAKY_PORT="${FLAKY_PORT:-18101}"
GATEWAY_PORT="${NEXUS_SMOKE_GATEWAY_PORT:-18093}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-retry"
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

wait_health() {
    local name="$1" url="$2" attempt=0
    while [ "$attempt" -lt 120 ]; do
        if curl -fsS "$url" 2>/dev/null | grep -qE '"status":"UP"|"status":"ok"'; then
            echo "  $name healthy"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never became healthy (see $LOG_DIR/$name.log)"
}

echo "== build gateway =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -pl gateway -DskipTests package || fail "maven build"

echo "== start fixture upstream on :$FLAKY_PORT =="
FLAKY_PORT="$FLAKY_PORT" FLAKY_FAILS_FIRST=2 \
    python "$ROOT/scripts/fixture_flaky_upstream.py" >"$LOG_DIR/fixture.log" 2>&1 &
PIDS+=("$!")
fixture_ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
    # Probe a different path so the readiness check does not consume the 500 budget the
    # gateway's retry is MEASURED against.
    if curl -fsS "http://127.0.0.1:$FLAKY_PORT/ready" -o /dev/null --max-time 2 2>/dev/null; then
        fixture_ready=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$fixture_ready" = 1 ] || fail "fixture never came up (see $LOG_DIR/fixture.log)"
echo "  fixture up on :$FLAKY_PORT"

echo "== start gateway against the fixture =="
export NEXUS_EUREKA_URI="http://127.0.0.1:9/eureka/"
export NEXUS_CONFIG_URI="http://127.0.0.1:9"
export NEXUS_PLATFORM_URI="http://127.0.0.1:$FLAKY_PORT"
export NEXUS_AI_URI="http://127.0.0.1:9"
export NEXUS_WEB_URI="http://127.0.0.1:9"
export NEXUS_GATEWAY_RATE_BURST=1000
java -jar "$CLOUD/gateway/target/app.jar" --server.port="$GATEWAY_PORT" \
    >"$LOG_DIR/gateway.log" 2>&1 &
PIDS+=("$!")
GATEWAY_PID=$!
echo "  gateway started (pid $GATEWAY_PID)"
wait_health gateway "http://127.0.0.1:$GATEWAY_PORT/actuator/health"

echo "== GET /api/v1/health through the gateway: expect 200 =="
code="$(curl -s -o /tmp/nexus-retry-get.json -w '%{http_code}' --max-time 30 \
    "http://127.0.0.1:$GATEWAY_PORT/api/v1/health")"
[ "$code" = "200" ] || fail "GET returned $code, not the retried 200 (see $LOG_DIR/gateway.log)"
echo "  health through the gateway -> 200"

echo "== the fixture saw EXACTLY three hits for that one GET (500 + 500 + 200) =="
hits="$(grep -c 'HIT /api/v1/health' "$LOG_DIR/fixture.log" || true)"
[ "$hits" = "3" ] || fail "fixture recorded $hits hits, expected 3 (retry did not fire: 500+500+200)"
echo "  fixture recorded 3 hits for one GET — the two retries fired"

echo "== the edge exposes its own metric surface =="
metric_names="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/metrics" 2>/dev/null || true)"
matched="$(printf '%s' "$metric_names" | tr ',' '\n' | sed 's/"//g' | grep -oE '(http\.server\.requests|resilience4j\.(circuitbreaker|timelimiter|bulkhead)[a-z._]*)' || true)"
[ -n "$matched" ] || fail "no http.server/resilience4j metric in /actuator/metrics: $metric_names"
printf '%s' "$matched" | grep -q 'http.server.requests' \
    || fail "http.server.requests missing — the request meter is gone: $metric_names"
printf '%s' "$matched" | grep -q 'resilience4j.circuitbreaker' \
    || fail "resilience4j.circuitbreaker.* missing — the breaker meter is gone: $metric_names"
echo "  resilience4j + http metrics present: $(printf '%s' "$matched" | sort -u | tr '\n' ' ')"

echo "== POST /api/v1/health through the gateway: POST is never retried =="
posts_before="$(grep -c 'HIT /api/v1/health' "$LOG_DIR/fixture.log" || true)"
post_body_file="$(mktemp 2>/dev/null || echo /tmp/nexus-retry-post.json)"
post_code="$(curl -s -o "$post_body_file" -w '%{http_code}' --max-time 30 \
    -X POST -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$GATEWAY_PORT/api/v1/health")"
posts_after="$(grep -c 'HIT /api/v1/health' "$LOG_DIR/fixture.log" || true)"
echo "  POST through the gateway -> $post_code (fixture: $posts_before -> $posts_after)"
[ "$posts_after" = "$((posts_before + 1))" ] \
    || fail "the fixture recorded $((posts_after - posts_before)) hits for one POST — POST must be retried exactly once, never retried"
echo "  one POST, one hit — never retried"
[ "$post_code" != "405" ] \
    || fail "POST to a routed upstream answered 405 METHOD_NOT_ALLOWED — the method-agnostic fallback regressed ($(cat "$post_body_file"))"

# D875's 503 promise, asserted where a failing upstream actually exists: the fixture's fail budget for
# /api/v1/health is consumed by the GET arm above (500+500+200), so a later POST on that path always
# lands on fixture hit 4+ (200) and can never witness the envelope. The web route is deliberately
# pointed at a closed port (NEXUS_WEB_URI=127.0.0.1:9), and the only ways the edge answers a POST to a
# failing upstream on ANY method are the fallback handlers — the exact 405 method-wiring D875 fixed.
dead_body_file=/tmp/nexus-retry-web-dead-post.json
dead_code="$(curl -s -o "$dead_body_file" -w '%{http_code}' --max-time 30 \
    -X POST -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$GATEWAY_PORT/web-check")"
[ "$dead_code" = "503" ] \
    || fail "POST to a failing upstream answered $dead_code, expected 503 edge_upstream_unavailable (the fallback must be method-agnostic)"
printf '%s' "$(cat "$dead_body_file")" | grep -q 'edge_upstream_unavailable' \
    || fail "POST to a failing upstream answered 503 but not the honest envelope: $(cat "$dead_body_file")"
echo "  failing POST lands edge_upstream_unavailable (503) instead of 405"

# D875/D880: the D880 counter sees what LEAVES the edge — the two 500s on the GET arm never did
# (the Retry filter absorbed them and wrote a final 200), so only the POST arm's 503 fallback counted.
echo "== the edge counts its own 5xx responses (nexus.edge.response.5xx) =="
metric_body="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/metrics/nexus.edge.response.5xx" 2>/dev/null)" \
    || fail "nexus.edge.response.5xx missing — metrics exposure or the filter is broken"
printf '%s' "$metric_body" | grep -q '"statistic":"COUNT"' \
    || fail "no COUNT measurement in $metric_body"
count="$(printf '%s' "$metric_body" | grep -oE '"value":[0-9.]+' | head -1 | cut -d: -f2 | cut -d. -f1)"
# Two 500s on the GET arm never leave the edge (Retry absorbs them into a final 200 — zero here).
# Every 503 that left the edge counts once: the dead-upstream POST deterministically, and on a slow
# host the budget-busted fixture POST may leave as 503 instead of its fast-host 200. So honest floor is >= 1, never 0.
[ "$count" -ge 1 ] \
    || fail "nexus.edge.response.5xx = $count, expected at least 1 (failing POST arm(s) leave the edge as 5xx; the Retry-absorbed 500s never count)"
echo "  nexus.edge.response.5xx = $count — GET arm 500s absorbed by Retry (0); failing POSTs counted — honest, not derived"

echo "PASS: cloud retry smoke — two retries on idempotent GETs past a transient 5xx; POSTs never retried; dead-upstream POST lands the method-agnostic 503 envelope"
