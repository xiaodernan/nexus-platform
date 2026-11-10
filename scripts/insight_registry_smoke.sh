#!/usr/bin/env bash
# NEXUS D886 — the fifth service really joins the registry.
#
#   D885's insight_smoke.sh proves the FALLBACK half with Eureka disabled. This one proves the
#   MEMBERSHIP half that it deliberately did not claim:
#     1. boot a throwaway Eureka node
#     2. boot nexus-insight pointed at it (registration ON)
#     3. poll /eureka/apps until NEXUS-INSIGHT appears with status UP and the plane's instance-id
#
# It does NOT claim that Feign resolved either upstream (they are not running), that Spring Boot
# Admin listed the instance, that HA replication works (D858), or that Docker was exercised (D853).
#
# Usage:  bash scripts/insight_registry_smoke.sh
# Env:    NEXUS_SMOKE_INSIGHT_EUREKA_PORT (default 18762), NEXUS_SMOKE_INSIGHT_REGISTRY_PORT (19557)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
EUREKA_PORT="${NEXUS_SMOKE_INSIGHT_EUREKA_PORT:-18762}"
INSIGHT_PORT="${NEXUS_SMOKE_INSIGHT_REGISTRY_PORT:-19557}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-registry"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== build eureka + insight =="
"$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl eureka-server,insight-service -DskipTests package \
    || fail "maven build"

echo "== boot Eureka on :$EUREKA_PORT =="
java -jar "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT" \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
eureka_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 -H 'Accept: application/json' \
        "http://127.0.0.1:$EUREKA_PORT/eureka/apps" -o "$LOG_DIR/empty.json" 2>/dev/null; then
        eureka_ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$eureka_ready" = 1 ] || fail "Eureka never answered (see $LOG_DIR/eureka.log)"
echo "  Eureka up on :$EUREKA_PORT"

echo "== boot insight on :$INSIGHT_PORT with registration ON =="
java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
    --eureka.client.service-url.defaultZone="http://127.0.0.1:$EUREKA_PORT/eureka/" \
    >"$LOG_DIR/insight.log" 2>&1 &
PIDS+=("$!")
insight_ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$INSIGHT_PORT/actuator/health" 2>/dev/null \
        | grep -q '"status":"UP"'; then
        insight_ready=1; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$insight_ready" = 1 ] || fail "insight never became healthy (see $LOG_DIR/insight.log)"
echo "  insight UP on :$INSIGHT_PORT"

echo "== poll the registry until NEXUS-INSIGHT is listed =="
registered=0; attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS --max-time 3 -H 'Accept: application/json' \
        "http://127.0.0.1:$EUREKA_PORT/eureka/apps" -o "$LOG_DIR/apps.json" 2>/dev/null; then
        if python - "$LOG_DIR/apps.json" "$INSIGHT_PORT" <<'PY' 2>/dev/null
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
apps = body.get('applications', {}).get('application', []) or []
if isinstance(apps, dict):
    apps = [apps]
hits = [a for a in apps if str(a.get('name', '')).upper() == 'NEXUS-INSIGHT']
assert hits, f"NEXUS-INSIGHT absent; registry lists {[a.get('name') for a in apps]}"
instances = hits[0].get('instance', []) or []
if isinstance(instances, dict):
    instances = [instances]
up = [i for i in instances if str(i.get('status', '')).upper() == 'UP']
assert up, f"NEXUS-INSIGHT present but no UP instance: {instances}"
ids = [str(i.get('instanceId', '')) for i in up]
assert any(sys.argv[2] in x for x in ids), f"instance-id does not carry the port: {ids}"
print(f"  registry lists NEXUS-INSIGHT UP, instanceId={ids[0]}")
PY
        then
            registered=1; break
        fi
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$registered" = 1 ] || fail "NEXUS-INSIGHT never appeared UP in the registry (see $LOG_DIR/eureka.log)"

echo "PASS: insight registry smoke — the fifth module registers by the plane's instance-id shape"
