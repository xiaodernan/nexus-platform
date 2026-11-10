#!/usr/bin/env bash
# NEXUS D885 — the independent service's honest degradation, measured against a live process.
#
#   1. build services/cloud/insight-service into target/app.jar
#   2. boot it with Eureka DISABLED, so neither NEXUS-PLATFORM nor NEXUS-AI has an instance
#   3. GET /insight/plane -> 200, all_up=false, and BOTH upstreams reported unavailable
#   4. assert no row impersonates a healthy upstream (no "UP", no faked fallback body)
#
# This deliberately proves the FALLBACK half. It does NOT claim service discovery succeeded, that a
# real platform/AI answered, or that the container path was exercised. Those need a live registry
# and are named as not-claimed in docs/CLOUD.md.
#
# Usage:  bash scripts/insight_smoke.sh
# Env:    NEXUS_SMOKE_INSIGHT_PORT (default 19556)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
INSIGHT_PORT="${NEXUS_SMOKE_INSIGHT_PORT:-19556}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-insight"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== build insight-service =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl insight-service -DskipTests package || fail "maven build"

echo "== boot insight on :$INSIGHT_PORT with Eureka DISABLED =="
# Measured on this host (D885): passing the port ONLY through ${NEXUS_INSIGHT_PORT:19555} in the
# module's YAML left `server.port` empty, so Boot picked a random high port (65245) and collided
# with a bound one. Spring's own command-line argument has the highest precedence and is what the
# other cloud smokes use (cloud_retry_smoke.sh: `--server.port=`). Eureka stays off by env.
NEXUS_INSIGHT_EUREKA_ENABLED=false \
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")

ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$INSIGHT_PORT/actuator/health" 2>/dev/null \
        | grep -qE '"status":"UP"'; then
        ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$ready" = 1 ] || fail "insight never became healthy (see $LOG_DIR/insight.log)"
echo "  insight UP on :$INSIGHT_PORT"

echo "== GET /insight/plane with no registry and no upstream =="
code="$(curl -s -o "$LOG_DIR/plane.json" -w '%{http_code}' --max-time 45 \
    "http://127.0.0.1:$INSIGHT_PORT/insight/plane")"
[ "$code" = "200" ] || fail "/insight/plane returned $code, expected 200 (see $LOG_DIR/insight.log)"

python - "$LOG_DIR/plane.json" <<'PY' || fail "the aggregated plane is not honest"
import json, sys

body = json.load(open(sys.argv[1], encoding='utf-8'))
assert body.get('service') == 'nexus-insight', body
assert body.get('plane') == 'spring-cloud-sidecar', body
assert body.get('all_up') is False, f"all_up must be false with no upstream: {body}"
rows = body.get('upstreams') or []
assert len(rows) == 2, f"expected exactly two upstream rows: {rows}"
assert {r.get('name') for r in rows} == {'NEXUS-PLATFORM', 'NEXUS-AI'}, rows
for row in rows:
    assert row.get('route', '').startswith('lb://'), row
    assert row.get('status') != 'UP', f"a fallback was reported as UP: {row}"
    assert row.get('status') in ('unavailable', 'unknown'), row
    assert row.get('source') in ('fallback', 'exception', 'upstream-without-status', 'empty-response'), row
print(f"  both upstreams reported honestly: {[(r['name'], r['status'], r['source']) for r in rows]}")
PY

echo "== the actuator window exists for Spring Boot Admin =="
curl -fsS "http://127.0.0.1:$INSIGHT_PORT/actuator/info" -o "$LOG_DIR/info.json" --max-time 10 \
    || fail "/actuator/info unreachable"
echo "  /actuator/info reachable"

echo "PASS: insight smoke — with no registry the service reports unavailable, never a faked UP"
