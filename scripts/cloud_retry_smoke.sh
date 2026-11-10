#!/usr/bin/env bash
# NEXUS cloud retry smoke (D875): prove the gateway retries an idempotent GET past a transient
# 5xx upstream — exactly twice — and that a POST is never retried.
#
#   1. boot a scripted fixture upstream on a throwaway port (fails the first two /api/v1/health
#      calls with 500, then serves 200; it also counts every hit)
#   2. boot the gateway with NEXUS_PLATFORM_URI pointed at the fixture
#   3. GET /api/v1/health through the gateway -> expect HTTP 200 and EXACTLY THREE fixture hits
#      (500 + 500 + 200), proving the two retries fired before the answer landed
#   4. POST /api/v1/health through the gateway -> expect HTTP 500 and EXACTLY ONE fixture hit —
#      POST is never retried, no matter which status it returns
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

# D875: a failing POST must land the honest 503 envelope, never a SpringMethodNotAllowed 405
post_body="$(cat "$post_body_file" 2>/dev/null || true)"
[ "$post_code" = "503" ] \
    || fail "POST to a failing upstream answered $post_code, expected 503 edge_upstream_unavailable (the fallback must be method-agnostic)"
printf '%s' "$post_body" | grep -q 'edge_upstream_unavailable' \
    || fail "POST to a failing upstream answered 503 but not the honest envelope: $post_body"
echo "  failing POST lands edge_upstream_unavailable (503) instead of 405"

# D875/D880: the D880 counter sees what LEAVES the edge — the two 500s on the GET arm never did
# (the Retry filter absorbed them and wrote a final 200), so only the POST arm's 503 fallback counted.
echo "== the edge counts its own 5xx responses (nexus.edge.response.5xx) =="
metric_body="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/metrics/nexus.edge.response.5xx" 2>/dev/null)" \
    || fail "nexus.edge.response.5xx missing — metrics exposure or the filter is broken"
printf '%s' "$metric_body" | grep -q '"statistic":"COUNT"' \
    || fail "no COUNT measurement in $metric_body"
count="$(printf '%s' "$metric_body" | grep -oE '"value":[0-9.]+' | head -1 | cut -d: -f2 | cut -d. -f1)"
[ "$count" = "1" ] \
    || fail "nexus.edge.response.5xx = $count, expected exactly 1 (the POST fallback 503; the 500s never leave the edge — the Retry filter writes a final 200)"
echo "  nexus.edge.response.5xx = $count — the two 500s were absorbed by Retry; the 503 fallback counted — honest, not derived"

echo "PASS: cloud retry smoke — two retries on idempotent GETs past a transient 5xx; POSTs never retried"
