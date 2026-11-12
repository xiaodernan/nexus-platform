#!/usr/bin/env bash
# NEXUS D894 — re-approach D858's HA Eureka blocker with EXPLICIT zones, and prove replication.
#
#   D858 tried three shapes and measured three failures: a comma-separated defaultZone on both
#   nodes ("The replica size seems to be empty"), a LAN-IP zone (ConnectTimeoutException — no
#   hairpin route from loopback), and distinct loopback hostnames with BOTH nodes self-registering
#   (sync flapped, self entries evicting each other). This smoke changes TWO things:
#
#     1. ONE peer URL per node, addressed through an EXPLICIT region/zone map. Node 1 belongs to
#        region `nexus` and is told its availability zone is `zone-b`, whose service-url is node 2;
#        node 2 is told `zone-a`, whose URL is node 1. Neither node's own URL appears in its own
#        zone list, so the replica resolver has nothing to exclude. No LAN address is used:
#        127.0.0.1 and 127.0.0.2 are both loopback-resolvable on this host.
#     2. The registry nodes DO NOT register themselves as instances (`register-with-eureka=false`,
#        `fetch-registry=false`). Peer replication is carried by PeerEurekaNodes, not by a server
#        appearing in its peer's app list. D858's third failure was self entries evicting under
#        this plane's deliberately aggressive 5s eviction, so this removes that whole population.
#
#   THE CLAIM IS A REGISTRATION CROSSING THE WIRE, IN BOTH DIRECTIONS. A throwaway fixture
#   registers with node 1 and another with node 2; each node must then list the OTHER's instance
#   with status UP and the fixture's own instanceId. A shared cache, a shared process or a misread
#   would not produce two `actionType: ADDED` rows on the nodes that were never registered into.
#
#   FALSIFIER ARM: NEXUS_HA_NO_PEER=1 boots the same two nodes WITHOUT the zone/peer wiring and
#   runs the SAME assertion with a short budget. It MUST fail. scripts/falsify_eureka_ha_smoke.sh
#   checks the exit code and the reason. A "replication" smoke that passes with replication off is
#   not evidence.
#
#   NOT CLAIMED: gateway failover, stale-replica eviction, a third node, encrypted/authenticated
#   transport, zero transient socket timeouts during startup, Docker, or production readiness.
#   This is a two-JVM measurement on loopback.
#
# Usage:  bash scripts/eureka_ha_smoke.sh
# Env:    NEXUS_HA_PORT_1 (18961), NEXUS_HA_PORT_2 (18962), NEXUS_HA_PROBE_PORT (19111),
#         NEXUS_HA_SKIP_BUILD=1 (jar must exist), NEXUS_HA_NO_PEER=1 (falsifier arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
P1="${NEXUS_HA_PORT_1:-18961}"
P2="${NEXUS_HA_PORT_2:-18962}"
PROBE_PORT="${NEXUS_HA_PROBE_PORT:-19111}"
PROBE_PORT_B=$((PROBE_PORT + 1))
NO_PEER="${NEXUS_HA_NO_PEER:-0}"
APP_A="NEXUS-HA-PROBE"
APP_B="NEXUS-HA-PROBE-B"
LOG_SUFFIX=""
[ "$NO_PEER" = 1 ] && LOG_SUFFIX="-no-peer"
LOG_DIR="${TMPDIR:-/tmp}/nexus-eureka-ha$LOG_SUFFIX"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() {
    echo "FAIL: $*" >&2
    echo "logs: $LOG_DIR" >&2
    # Same guidance as the LB smoke: the runner is ephemeral; CI failures are unpost-mortem-able
    # unless the failure itself carries the evidence. Dump the child logs the reader would need.
    for f in "$LOG_DIR"/fixture-*.log "$LOG_DIR"/eureka*.log; do
        [ -f "$f" ] || continue
        echo "----- $f"
        tail -n 80 "$f" || true
    done
    exit 1
}

if [ ! -f "$CLOUD/eureka-server/target/app.jar" ] || [ "${NEXUS_HA_SKIP_BUILD:-0}" != 1 ]; then
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl eureka-server -DskipTests package || fail "maven build"
fi

start_node() {
    local name="$1" port="$2" host="$3" zone="$4" peer_url="$5"
    local args=(
        "--server.port=$port"
        "--eureka.instance.hostname=$host"
        "--eureka.client.register-with-eureka=false"
        "--eureka.client.fetch-registry=false"
    )
    if [ "$NO_PEER" != 1 ]; then
        args+=(
            "--eureka.client.region=nexus"
            "--eureka.client.availability-zones.nexus=$zone"
            "--eureka.client.service-url.$zone=$peer_url"
            "--eureka.client.prefer-same-zone-eureka=false"
        )
    fi
    java -jar "$CLOUD/eureka-server/target/app.jar" "${args[@]}" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started on :$port (host $host, zone ${zone:-none})"
}

wait_up() {
    local name="$1" port="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS --max-time 2 "http://127.0.0.1:$port/actuator/health" 2>/dev/null \
            | grep -q '"status":"UP"'; then
            echo "  $name up on :$port"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never came up (see $LOG_DIR/$name.log)"
}

echo "== boot the pair =="
start_node eureka1 "$P1" 127.0.0.1 zone-b "http://127.0.0.2:$P2/eureka/"
start_node eureka2 "$P2" 127.0.0.2 zone-a "http://127.0.0.1:$P1/eureka/"
wait_up eureka1 "$P1"
wait_up eureka2 "$P2"

if [ "$NO_PEER" != 1 ]; then
    sleep 3
    if grep -q "replica size seems to be empty" "$LOG_DIR/eureka1.log" "$LOG_DIR/eureka2.log" 2>/dev/null; then
        fail "the replica resolver still reports an EMPTY replica set — the explicit zone wiring did not take"
    fi
    echo "  neither node reports an empty replica set"
fi

# ONE json predicate, used for the clean baselines and both replicated-registration polls.
probe() {
    python - "$1" "$2" "$3" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
apps = body.get('applications', {}).get('application', []) or []
if isinstance(apps, dict):
    apps = [apps]
mode, app = sys.argv[2], sys.argv[3]
names = [str(a.get('name', '')).upper() for a in apps]
hits = [a for a in apps if str(a.get('name', '')).upper() == app]
try:
    if mode == 'REQUIRE_ABSENT':
        assert not hits, f"baseline not clean; the node already lists {names}"
        print(f"  baseline: no {app} (apps: {len(names)})")
    elif mode == 'REQUIRE_PRESENT':
        assert hits, f"{app} has not arrived; the node lists {names}"
        inst = hits[0].get('instance', []) or []
        if isinstance(inst, dict):
            inst = [inst]
        up = [i for i in inst if str(i.get('status', '')).upper() == 'UP']
        assert up, f"{app} is present but no instance is UP: {inst}"
        ids = [str(i.get('instanceId', '')) for i in up]
        assert ids and ids[0], f"{app} has no instanceId: {up}"
        print(f"  {app} arrived UP, instanceId={ids[0]}, actionType={up[0].get('actionType', '?')}")
    else:
        raise AssertionError(f"unknown probe mode {mode}")
except AssertionError as exc:
    print(f"  waiting: {exc}")
    raise SystemExit(1)
PY
}

fetch_apps() {
    curl -fsS --max-time 3 -H 'Accept: application/json' \
        "http://127.0.0.1:$1/eureka/apps" -o "$2" 2>/dev/null
}

register_fixture() {
    local app="$1" port="$2" eureka_port="$3" logname="$4"
    env INSIGHT_FIXTURE_APP="$app" INSIGHT_FIXTURE_PORT="$port" \
        INSIGHT_FIXTURE_PATH="ha/health" \
        INSIGHT_FIXTURE_EUREKA="http://127.0.0.1:$eureka_port/eureka/" \
        python "$ROOT/scripts/fixture_insight_upstream.py" >"$LOG_DIR/$logname.log" 2>&1 &
    PIDS+=("$!")
}

wait_registered() {
    local app="$1" port="$2" label="$3" out="$4" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if fetch_apps "$port" "$out" && grep -qF "$app" "$out"; then
            echo "  $label directly registered $app"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$app never registered with $label (see $LOG_DIR/fixture-*.log)"
}

poll_replicated() {
    local app="$1" port="$2" label="$3" out="$4" budget="$5" attempt=0
    while [ "$attempt" -lt "$budget" ]; do
        if fetch_apps "$port" "$out" \
            && probe "$out" REQUIRE_PRESENT "$app" >"$LOG_DIR/probe.log" 2>&1; then
            cat "$LOG_DIR/probe.log"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$label never received $app — peer replication did not converge (see $LOG_DIR/eureka1.log and $LOG_DIR/eureka2.log)"
}

echo "== baseline: neither node may already know the probes =="
baseline=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    if fetch_apps "$P1" "$LOG_DIR/apps1.json" && fetch_apps "$P2" "$LOG_DIR/apps2.json" \
        && probe "$LOG_DIR/apps1.json" REQUIRE_ABSENT "$APP_B" >"$LOG_DIR/probe.log" 2>&1 \
        && probe "$LOG_DIR/apps2.json" REQUIRE_ABSENT "$APP_A" >"$LOG_DIR/probe.log" 2>&1; then
        baseline=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$baseline" = 1 ] || fail "could not read clean baselines (see $LOG_DIR/eureka1.log and $LOG_DIR/eureka2.log)"

budget=45
[ "$NO_PEER" = 1 ] && budget=10

echo "== phase A: register with node 1 only, node 2 must learn it =="
register_fixture "$APP_A" "$PROBE_PORT" "$P1" fixture-A
wait_registered "$APP_A" "$P1" node1 "$LOG_DIR/apps1.json"
poll_replicated "$APP_A" "$P2" node2 "$LOG_DIR/apps2.json" "$budget"

echo "== phase B: register with node 2 only, node 1 must learn it =="
register_fixture "$APP_B" "$PROBE_PORT_B" "$P2" fixture-B
wait_registered "$APP_B" "$P2" node2 "$LOG_DIR/apps2.json"
poll_replicated "$APP_B" "$P1" node1 "$LOG_DIR/apps1.json" "$budget"

echo "PASS: eureka HA smoke — registrations crossed the wire in BOTH directions"
