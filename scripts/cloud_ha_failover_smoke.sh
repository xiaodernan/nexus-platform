#!/usr/bin/env bash
# NEXUS D897 (Phase G / G3) — a gateway client actually FAILOVERS between two Eureka nodes.
#
#   D894 proved the two SERVERS replicate registrations. It left the obvious next question open:
#   no client was ever pointed at both registries, so "failover" was still an unmeasured word in
#   CLOUD.md. This smoke points the gateway at BOTH Eureka URLs and kills the primary.
#
#   THE DESIGN MATTERS MORE THAN THE GREEN LINE. A simpler "200 before, 200 after killing one
#   node" would prove almost nothing: Spring Cloud's DiscoveryClient keeps a local registry cache,
#   so a green answer could come from stale memory with NO surviving registry at all. Here the
#   gateway boots while BOTH registries are EMPTY of NEXUS-PLATFORM, so its cache never held the
#   upstream. Only AFTER the primary is dead does the fixture register with the SECONDARY node.
#   A 200 answer from the fixture is therefore only possible if the gateway's Eureka client really
#   moved to the second URL and fetched a registry it had never seen before.
#
#   FALSIFIER ARM: NEXUS_HA_FAILOVER_SINGLE=1 gives the gateway ONLY the primary URL. Everything
#   else is identical (pair up, primary killed, fixture registered with the secondary). The same
#   "the gateway resolves lb://NEXUS-PLATFORM" assertion MUST fail. A failover smoke green with
#   one registry is not evidence of failover.
#
#   ISOLATION (declared, not hidden): this throwaway gateway raises the `platform` breaker's
#   minimumNumberOfCalls to 100 and fetches every 3s, so a DISCOVERY delay cannot be misread as
#   a breaker trip while polling. D850/D895 own the real breaker claim; this smoke measures only
#   registry failover. No product configuration file is changed.
#
#   NOT CLAIMED: a deployed HA pair, zero stale-cache eviction, sub-second failover, a third
#   node, authenticated transport, that the gateway retried a request in flight, or that the
#   fixture is the real platform. Two Eureka JVMs, one gateway JVM, one Python fixture on loopback.
#
# Usage:  bash scripts/cloud_ha_failover_smoke.sh
# Env:    NEXUS_HA_FAILOVER_PORT_1 (18963), NEXUS_HA_FAILOVER_PORT_2 (18964),
#         NEXUS_HA_FAILOVER_GATEWAY_PORT (18099), NEXUS_HA_FAILOVER_FIXTURE_PORT (19121),
#         NEXUS_HA_FAILOVER_SKIP_BUILD=1 (jars must exist), NEXUS_HA_FAILOVER_SINGLE=1 (falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
P1="${NEXUS_HA_FAILOVER_PORT_1:-18963}"
P2="${NEXUS_HA_FAILOVER_PORT_2:-18964}"
GW="${NEXUS_HA_FAILOVER_GATEWAY_PORT:-18099}"
FX="${NEXUS_HA_FAILOVER_FIXTURE_PORT:-19121}"
SINGLE="${NEXUS_HA_FAILOVER_SINGLE:-0}"
APP="NEXUS-PLATFORM"

LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-ha-failover"
if [ "$SINGLE" = 1 ]; then LOG_DIR="${LOG_DIR}-single"; fi
mkdir -p "$LOG_DIR"

PIDS=()
NODE1_PID=""
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

if [ "${NEXUS_HA_FAILOVER_SKIP_BUILD:-0}" != 1 ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl eureka-server,gateway -DskipTests package || fail "maven build"
else
    [ -f "$CLOUD/eureka-server/target/app.jar" ] && [ -f "$CLOUD/gateway/target/app.jar" ] \
        || fail "skip requested but a required jar is missing"
fi

start_node() {
    local name="$1" port="$2" host="$3" zone="$4" peer_url="$5"
    java -jar "$CLOUD/eureka-server/target/app.jar" \
        "--server.port=$port" \
        "--eureka.instance.hostname=$host" \
        "--eureka.client.register-with-eureka=false" \
        "--eureka.client.fetch-registry=false" \
        "--eureka.client.region=nexus" \
        "--eureka.client.availability-zones.nexus=$zone" \
        "--eureka.client.service-url.$zone=$peer_url" \
        "--eureka.client.prefer-same-zone-eureka=false" \
        >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    if [ "$name" = eureka1 ]; then NODE1_PID="$!"; fi
    echo "  $name started on :$port (host $host, zone $zone)"
}

wait_up() {
    local name="$1" port="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS --max-time 2 "http://127.0.0.1:$port/actuator/health" 2>/dev/null \
            | grep -q '"status":"UP"'; then
            echo "  $name up on :$port"; return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never came up (see $LOG_DIR/$name.log)"
}

fetch_apps() {
    curl -fsS --max-time 3 -H 'Accept: application/json' \
        "http://127.0.0.1:$1/eureka/apps" -o "$2" 2>/dev/null
}

probe_absent() {
    python - "$1" "$2" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
apps = body.get('applications', {}).get('application', []) or []
if isinstance(apps, dict):
    apps = [apps]
names = [str(a.get('name', '')).upper() for a in apps]
assert sys.argv[2].upper() not in names, f"registry is not clean: {names}"
print(f"  clean registry — no {sys.argv[2]} (apps: {len(names)})")
PY
}

probe_fixture_answer() {
    python - "$1" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
assert body.get('fixture') == 'NEXUS-PLATFORM', f"not the fixture's answer: {body}"
assert body.get('status') == 'UP', f"the upstream did not report its own UP status: {body}"
PY
}

probe_present_up() {
    python - "$1" "$2" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
apps = body.get('applications', {}).get('application', []) or []
if isinstance(apps, dict):
    apps = [apps]
hits = [a for a in apps if str(a.get('name', '')).upper() == sys.argv[2]]
assert hits, f"{sys.argv[2]} is absent; apps: {[a.get('name') for a in apps]}"
inst = hits[0].get('instance', []) or []
if isinstance(inst, dict):
    inst = [inst]
up = [i for i in inst if str(i.get('status', '')).upper() == 'UP']
assert up, f"{sys.argv[2]} present but no UP instance: {inst}"
print(f"  {sys.argv[2]} UP, instanceId={up[0].get('instanceId')}")
PY
}

echo "== boot the HA pair (D894's explicit zones) =="
start_node eureka1 "$P1" 127.0.0.1 zone-b "http://127.0.0.2:$P2/eureka/"
start_node eureka2 "$P2" 127.0.0.2 zone-a "http://127.0.0.1:$P1/eureka/"
wait_up eureka1 "$P1"
wait_up eureka2 "$P2"
echo "  both eureka nodes up (:${P1}, :${P2})"

echo "== clean baseline: NEITHER registry may know the upstream yet =="
clean=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    if fetch_apps "$P1" "$LOG_DIR/apps1.json" && fetch_apps "$P2" "$LOG_DIR/apps2.json" \
        && probe_absent "$LOG_DIR/apps1.json" "$APP" >"$LOG_DIR/probe.log" 2>&1 \
        && probe_absent "$LOG_DIR/apps2.json" "$APP" >>"$LOG_DIR/probe.log" 2>&1; then
        clean=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$clean" = 1 ] || fail "could not read clean registry baselines (see $LOG_DIR/eureka1.log)"

if [ "$SINGLE" = 1 ]; then
    ZONE_URL="http://127.0.0.1:$P1/eureka/"
    echo "== SINGLE-REGISTRY ARM: the gateway is deliberately given ONLY the primary URL =="
else
    ZONE_URL="http://127.0.0.1:$P1/eureka/,http://127.0.0.2:$P2/eureka/"
    echo "== the gateway is given BOTH registry URLs =="
fi
echo "  defaultZone=$ZONE_URL"

echo "== boot the gateway against an EMPTY registry (its cache has never held $APP) =="
env NEXUS_CONFIG_URI="http://127.0.0.1:9" \
    NEXUS_AI_URI="http://127.0.0.1:9" \
    NEXUS_WEB_URI="http://127.0.0.1:9" \
    NEXUS_GATEWAY_RATE_BURST=1000 \
    java -jar "$CLOUD/gateway/target/app.jar" \
    "--server.port=$GW" \
    "--spring.profiles.active=cloud" \
    "--eureka.client.service-url.defaultZone=$ZONE_URL" \
    "--eureka.client.registry-fetch-interval-seconds=3" \
    "--resilience4j.circuitbreaker.instances.platform.minimumNumberOfCalls=100" \
    >"$LOG_DIR/gateway.log" 2>&1 &
PIDS+=("$!")
ready=0; attempt=0
while [ "$attempt" -lt 120 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$GW/actuator/health" 2>/dev/null \
        | grep -qE '"status":"UP"|"status":"ok"'; then
        ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$ready" = 1 ] || fail "gateway never became healthy (see $LOG_DIR/gateway.log)"
echo "  gateway healthy on :$GW"
curl -fsS --max-time 5 "http://127.0.0.1:$GW/actuator/gateway/routes" 2>/dev/null \
    | grep -q 'lb://NEXUS-PLATFORM' \
    || fail "the gateway route table has no lb://NEXUS-PLATFORM (cloud profile did not take)"
echo "  route table carries lb://NEXUS-PLATFORM"

echo "== kill the PRIMARY registry node =="
kill "$NODE1_PID" 2>/dev/null || fail "could not signal the primary eureka process"
down=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    if ! curl -fsS --max-time 1 "http://127.0.0.1:$P1/actuator/health" >/dev/null 2>&1; then
        down=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$down" = 1 ] || fail "the primary eureka node is still answering on :$P1 after kill"
echo "  primary node is down (:${P1} no longer answers)"
curl -fsS --max-time 3 "http://127.0.0.1:$P2/actuator/health" 2>/dev/null \
    | grep -q '"status":"UP"' || fail "the secondary node died too"
echo "  secondary node is still UP on :$P2"

echo "== ONLY NOW register the upstream with the SECONDARY node =="
env INSIGHT_FIXTURE_APP="$APP" INSIGHT_FIXTURE_PORT="$FX" \
    INSIGHT_FIXTURE_PATH="api/v1/health" \
    INSIGHT_FIXTURE_EUREKA="http://127.0.0.2:$P2/eureka/" \
    python "$ROOT/scripts/fixture_insight_upstream.py" >"$LOG_DIR/fixture.log" 2>&1 &
PIDS+=("$!")
registered=0; attempt=0
while [ "$attempt" -lt 40 ]; do
    if fetch_apps "$P2" "$LOG_DIR/apps2.json" \
        && probe_present_up "$LOG_DIR/apps2.json" "$APP" >"$LOG_DIR/probe.log" 2>&1; then
        registered=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$registered" = 1 ] || fail "the upstream never registered with the secondary (see $LOG_DIR/fixture.log)"
echo "  secondary node lists $APP UP"

echo "== the gateway must now resolve lb:// through the SURVIVING registry =="
resolved=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    code="$(curl -s -o "$LOG_DIR/plane.json" -w '%{http_code}' --max-time 20 \
        "http://127.0.0.1:$GW/api/v1/health" 2>/dev/null)"
    if [ "$code" = "200" ] && probe_fixture_answer "$LOG_DIR/plane.json" 2>/dev/null; then
        resolved=1; break
    fi
    attempt=$((attempt + 1)); sleep 2
done
[ "$resolved" = 1 ] \
    || fail "no lb://NEXUS-PLATFORM answer after the primary died (single-registry arm: the gateway was deliberately given only the dead node; see $LOG_DIR/gateway.log)"
echo "  200 from the fixture through lb://: $(cat "$LOG_DIR/plane.json")"
grep -qF 'SERVE /api/v1/health' "$LOG_DIR/fixture.log" \
    || fail "the fixture never served the health path — a cached or fabricated answer cannot pass"
echo "  fixture access log proves the request really arrived"

echo "PASS: cloud HA failover smoke — the gateway resolved lb:// after its primary registry died"
