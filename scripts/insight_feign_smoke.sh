#!/usr/bin/env bash
# NEXUS D887 — a declarative Feign client really reaches a LIVE, registry-resolved upstream.
#
# D885 proved the FALLBACK half (Eureka disabled, both rows `unavailable`). D886 proved that
# nexus-insight itself REGISTERS. What neither proved is the third, load-bearing claim in
# docs/CLOUD.md: `@FeignClient(name="...")` resolves `lb://NEXUS-PLATFORM` and `lb://NEXUS-AI`
# through Eureka + Spring Cloud LoadBalancer and copies what those instances actually answered.
#
# This smoke closes it with two throwaway upstream fixtures that register themselves by name:
#   1. Eureka boots with its read-only response cache OFF so registrations are visible at once.
#   2. NEXUS-PLATFORM (:19101, /api/v1/health) and NEXUS-AI (:19102, /ai/v1/health) register.
#   3. insight boots LAST against that registry, so its first fetch already sees both names.
#   4. phase A: /insight/plane must say all_up=true, both rows status=UP, source=upstream.
#   5. phase B: the AI fixture is switched to a NON-UP status at runtime; the view must report
#      that exact value (still source=upstream) and all_up=false. A cached or faked answer, a
#      fallback, or a hardcoded UP cannot survive this.
#   6. the fixtures' own access logs must show the two health paths were really requested.
#
# This is NOT a claim that the real platform/AI services were booted (they were not), that SBA
# listed anything, that HA replication works (D858), or that Docker was exercised (D853). The
# fixtures are not the products; they are registered instances answering the contract paths.
#
# Usage:  bash scripts/insight_feign_smoke.sh
# Env:    NEXUS_FEIGN_EUREKA_PORT (18763), NEXUS_FEIGN_PLATFORM_PORT (19101),
#         NEXUS_FEIGN_AI_PORT (19102), NEXUS_FEIGN_INSIGHT_PORT (19558)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
PY="${PY:-python}"
EUREKA_PORT="${NEXUS_FEIGN_EUREKA_PORT:-18763}"
PLATFORM_PORT="${NEXUS_FEIGN_PLATFORM_PORT:-19101}"
AI_PORT="${NEXUS_FEIGN_AI_PORT:-19102}"
INSIGHT_PORT="${NEXUS_FEIGN_INSIGHT_PORT:-19558}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-feign"
mkdir -p "$LOG_DIR"
# REST paths need NO trailing slash — `$EUREKA_URL/apps` would become `/eureka//apps`, which
# Eureka's Jersey endpoint answers with a measured 404 (`path":"/eureka//apps"`). The fixture and
# `eureka.client.service-url.defaultZone` DO want the trailing `/eureka/` form. Two variables, one
# host coordinate: a double slash is not a harmless spelling difference here.
EUREKA_BASE="http://127.0.0.1:$EUREKA_PORT/eureka"
EUREKA_URL="$EUREKA_BASE/"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

# CI always builds. On a saturated host a rerun can reuse jars that a sibling smoke just produced;
# the guard refuses to skip when either jar is absent, so skipping can never mean "test stale code".
if [ "${NEXUS_FEIGN_SKIP_BUILD:-0}" = "1" ]; then
    echo "== build SKIPPED (NEXUS_FEIGN_SKIP_BUILD=1; both jars are checked) =="
    [ -f "$CLOUD/eureka-server/target/app.jar" ] || fail "eureka jar absent; unset the skip flag"
    [ -f "$CLOUD/insight-service/target/app.jar" ] || fail "insight jar absent; unset the skip flag"
else
    echo "== build eureka + insight (offline) =="
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl eureka-server,insight-service -DskipTests package \
        || fail "maven build"
fi

echo "== boot Eureka on :$EUREKA_PORT with the read-only response cache OFF =="
java -jar "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT" \
    --eureka.server.use-read-only-response-cache=false \
    --eureka.server.response-cache-update-interval-ms=3000 \
    --eureka.server.enable-self-preservation=false \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
# /actuator/health is the readiness signal every other cloud smoke uses: it is a cheap servlet
# endpoint, and measured at 6s after boot here. /eureka/apps is a Jersey/XStream endpoint that
# initialises lazily on its first call — using IT as the readiness probe made the loop time out
# while Eureka's own log said "Started EurekaServerApplication". No `curl -o` either: TMPDIR is a
# `C:\...` path on this host and the native curl does not reliably write it.
eureka_ready=0; attempt=0
while [ "$attempt" -lt 90 ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$EUREKA_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then
        eureka_ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$eureka_ready" = 1 ] || fail "Eureka never became healthy (see $LOG_DIR/eureka.log)"
echo "  Eureka up on :$EUREKA_PORT"

apps_ready=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    if curl -fsS --max-time 6 -H 'Accept: application/json' "$EUREKA_BASE/apps" 2>/dev/null \
        | grep -q 'applications'; then apps_ready=1; break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$apps_ready" = 1 ] || fail "Eureka's /eureka/apps never answered (see $LOG_DIR/eureka.log)"
echo "  /eureka/apps answers"

start_fixture() {
    local app="$1" port="$2" path="$3" log="$4"
    INSIGHT_FIXTURE_APP="$app" INSIGHT_FIXTURE_PORT="$port" \
        INSIGHT_FIXTURE_PATH="$path" INSIGHT_FIXTURE_EUREKA="$EUREKA_URL" \
        "$PY" -u "$ROOT/scripts/fixture_insight_upstream.py" >"$LOG_DIR/$log" 2>&1 &
    PIDS+=("$!")
    local ok=0 n=0
    while [ "$n" -lt 60 ]; do
        # Fixed-string match, not a `"app":"NAME"` literal: Python's json.dumps puts a SPACE after
        # the colon (`"app": "NEXUS-PLATFORM"`), so the tight grep silently never matched while the
        # fixture was in fact listening. A readiness probe that cannot recognise a healthy answer is
        # worse than no probe.
        if curl -fsS --max-time 2 "http://127.0.0.1:$port/__control/ping" 2>/dev/null \
            | grep -qF "$app"; then ok=1; break; fi
        n=$((n + 1)); sleep 1
    done
    [ "$ok" = 1 ] || fail "$app fixture never listened (see $LOG_DIR/$log)"
    grep -q "REGISTERED $app" "$LOG_DIR/$log" || fail "$app never registered (see $LOG_DIR/$log)"
    echo "  $app fixture on :$port answers $path and registered"
}

echo "== register both upstreams BEFORE insight boots =="
# NO leading slash in these path arguments: Git Bash rewrites a `/...` env value into a Windows
# path before the native Python process sees it (measured). The fixture puts the slash back.
start_fixture NEXUS-PLATFORM "$PLATFORM_PORT" api/v1/health platform.log
start_fixture NEXUS-AI "$AI_PORT" ai/v1/health ai.log

echo "== Eureka lists BOTH names =="
for app in NEXUS-PLATFORM NEXUS-AI; do
    seen=0; attempt=0
    while [ "$attempt" -lt 60 ]; do
        if curl -fsS --max-time 3 -H 'Accept: application/json' \
            "$EUREKA_BASE/apps/$app" 2>/dev/null | grep -q "NEXUS-"; then seen=1; break; fi
        attempt=$((attempt + 1)); sleep 1
    done
    [ "$seen" = 1 ] || fail "Eureka never listed $app"
    echo "  $app visible in /eureka/apps"
done

echo "== boot insight on :$INSIGHT_PORT against that registry =="
java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
    --eureka.client.service-url.defaultZone="$EUREKA_URL" \
    --eureka.client.registry-fetch-interval-seconds=5 \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
insight_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$INSIGHT_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then insight_ready=1; break; fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$insight_ready" = 1 ] || fail "insight never became healthy (see $LOG_DIR/insight.log)"
echo "  insight UP on :$INSIGHT_PORT"
# Give the discovery client's first registry fetch and the LoadBalancer's instance-list supplier
# one interval to settle. The upstreams were registered BEFORE the process started, so this is a
# settle, not a retry of a failed claim.
sleep 5

echo "== phase A: both upstreams answer UP through lb:// =="
plane_a=""
for i in 1 2 3; do
    plane_a="$(curl -fsS --max-time 20 "http://127.0.0.1:$INSIGHT_PORT/insight/plane" 2>/dev/null)" || plane_a=""
    if printf '%s' "$plane_a" | "$PY" -c '
import json,sys
b=json.load(sys.stdin)
assert b.get("all_up") is True, b
rows={r["name"]:r for r in b["upstreams"]}
assert set(rows)=={"NEXUS-PLATFORM","NEXUS-AI"}, rows
for n,route in [("NEXUS-PLATFORM","lb://NEXUS-PLATFORM"),("NEXUS-AI","lb://NEXUS-AI")]:
    r=rows[n]
    assert r["status"]=="UP", r
    assert r["source"]=="upstream", r
    assert r["route"]==route, r
    assert "insight_fallback" not in r, r
print("OK")
' 2>/dev/null; then break; fi
    plane_a=""
    sleep 3
done
[ -n "$plane_a" ] || fail "phase A: /insight/plane did not report two REAL upstream UP answers (got: ${plane_a:-<empty>})"
echo "  all_up=true; NEXUS-PLATFORM and NEXUS-AI: status=UP, source=upstream, route=lb://..."

echo "== phase B: switch the AI instance to a non-UP status; the view must copy it =="
curl -fsS --max-time 5 -X POST "http://127.0.0.1:$AI_PORT/__control/status/DEGRADED" \
    >"$LOG_DIR/control.json" 2>/dev/null || fail "AI fixture control endpoint failed"
grep -q 'DEGRADED' "$LOG_DIR/control.json" || fail "AI fixture did not accept the status switch"
plane_b="$(curl -fsS --max-time 20 "http://127.0.0.1:$INSIGHT_PORT/insight/plane" 2>/dev/null)" \
    || fail "phase B: /insight/plane did not answer"
printf '%s' "$plane_b" | "$PY" -c '
import json,sys
b=json.load(sys.stdin)
assert b.get("all_up") is False, b
rows={r["name"]:r for r in b["upstreams"]}
p,a=rows["NEXUS-PLATFORM"],rows["NEXUS-AI"]
assert p["status"]=="UP" and p["source"]=="upstream", p
assert a["status"]=="DEGRADED", a
assert a["source"]=="upstream", a
assert "insight_fallback" not in a, a
print("OK")
' || fail "phase B: a non-UP upstream status was not reported honestly (got: $plane_b)"
echo "  AI instance now DEGRADED -> the view reports DEGRADED / upstream / all_up=false (nothing cached)"

echo "== the fixtures really received the Feign calls =="
grep -q 'SERVE /api/v1/health' "$LOG_DIR/platform.log" \
    || fail "NEXUS-PLATFORM fixture never served /api/v1/health — Feign did not reach it"
grep -q 'SERVE /ai/v1/health' "$LOG_DIR/ai.log" \
    || fail "NEXUS-AI fixture never served /ai/v1/health — Feign did not reach it"
echo "  both health paths were requested at the registered instances"

echo "PASS: insight Feign smoke — lb:// names resolved to live registered instances, and their own status values were reported unchanged"
