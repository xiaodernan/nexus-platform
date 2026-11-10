#!/usr/bin/env bash
# NEXUS D892 — the fifth member appears in the ONE admin window, and the smoke reddens without it.
#
#   D886 proved nexus-insight REGISTERS with Eureka. Registration is not visibility: Spring Boot
#   Admin watches the registry but decides for itself which instances it can probe, and a service
#   whose actuator shape SBA cannot parse never reaches /instances. This smoke closes that gap:
#     1. boot a throwaway Eureka
#     2. boot Spring Boot Admin against it
#     3. ASSERT THE BASELINE: /instances does NOT yet name NEXUS-INSIGHT
#     4. boot nexus-insight with registration ON
#     5. poll /instances until the NEXUS-INSIGHT instance itself reports status UP
#
#   The status is read from THAT instance's statusInfo, parsed as JSON — not a grep over the whole
#   body, which would pass on any other healthy member. This is the same strictness D877's AI smoke
#   could not offer: it grepped `"status":"UP"` anywhere in the document.
#
#   ABSENCE ARM: NEXUS_INSIGHT_ADMIN_ABSENT=1 boots Eureka and Admin but deliberately NOT insight,
#   then runs the SAME assertion with a short budget. It MUST fail. scripts/falsify_insight_admin_smoke.sh
#   runs that arm and checks the exit code and the reason. A smoke that is green with its subject
#   missing is not a smoke.
#
#   NOT CLAIMED: the real platform/AI products are not booted; no Docker image, no HA replication,
#   no auth on the admin surface, and no second insight instance. This is one window, one member.
#
# Usage:  bash scripts/insight_admin_smoke.sh
# Env:    NEXUS_INSIGHT_ADMIN_EUREKA_PORT (18764), NEXUS_INSIGHT_ADMIN_PORT (19452),
#         NEXUS_INSIGHT_ADMIN_INSIGHT_PORT (19560), NEXUS_INSIGHT_ADMIN_SKIP_BUILD=1 (jars must exist),
#         NEXUS_INSIGHT_ADMIN_ABSENT=1 (the falsifier's absence arm)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
EUREKA_PORT="${NEXUS_INSIGHT_ADMIN_EUREKA_PORT:-18764}"
ADMIN_PORT="${NEXUS_INSIGHT_ADMIN_PORT:-19452}"
INSIGHT_PORT="${NEXUS_INSIGHT_ADMIN_INSIGHT_PORT:-19560}"
ABSENT="${NEXUS_INSIGHT_ADMIN_ABSENT:-0}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-admin"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

wait_up() {
    local name="$1" url="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS --max-time 2 "$url" 2>/dev/null | grep -q '"status":"UP"'; then
            echo "  $name up on $url"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never came up on $url (see $LOG_DIR/$name.log)"
}

echo "== jars =="
if [ "${NEXUS_INSIGHT_ADMIN_SKIP_BUILD:-0}" = 1 ]; then
    for jar in eureka-server admin-server insight-service; do
        [ -f "$CLOUD/$jar/target/app.jar" ] || fail "skip requested but $jar/target/app.jar is missing"
    done
    echo "  build skipped, all three jars present"
else
    "$MVN" -q -B -o -f "$CLOUD/pom.xml" -pl eureka-server,admin-server,insight-service \
        -DskipTests package || fail "maven build"
    echo "  reactor built"
fi

echo "== boot Eureka on :$EUREKA_PORT =="
java -jar "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT" \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
wait_up eureka "http://127.0.0.1:$EUREKA_PORT/actuator/health"

echo "== boot Spring Boot Admin on :$ADMIN_PORT against that registry =="
export NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/"
java -jar "$CLOUD/admin-server/target/app.jar" --server.port="$ADMIN_PORT" \
    >"$LOG_DIR/admin.log" 2>&1 &
PIDS+=("$!")
wait_up admin "http://127.0.0.1:$ADMIN_PORT/actuator/health"

# The instance probe is ONE python predicate, used for both the baseline and the success poll.
# Reading the file through an argv path (not an env value) avoids MSYS rewriting a leading slash.
probe() {
    python - "$1" "$2" <<'PY'
import json, sys
body = json.load(open(sys.argv[1], encoding='utf-8'))
items = body if isinstance(body, list) else (
    body.get('_embedded', {}).get('instances', body.get('instances', [])))
if isinstance(items, dict):
    items = [items]
rows = []
for item in items:
    reg = item.get('registration') or {}
    name = str(reg.get('name') or item.get('name') or '')
    info = item.get('statusInfo') or {}
    status = str(info.get('status') or item.get('status') or '')
    rows.append((name.upper(), status.upper(), str(item.get('id', ''))))
mode = sys.argv[2]
hits = [(n, s, i) for (n, s, i) in rows if n == 'NEXUS-INSIGHT']
try:
    if mode == 'REQUIRE_UP':
        assert any(s == 'UP' for (n, s, i) in hits), f"no UP instance; admin lists {rows}"
        print(f"  admin lists NEXUS-INSIGHT UP, id={hits[0][2]}")
    elif mode == 'REQUIRE_ABSENT':
        assert not hits, f"the baseline is not clean; admin already lists {rows}"
        print(f"  baseline: /instances has no NEXUS-INSIGHT (registry members: {len(rows)})")
    else:
        raise AssertionError(f"unknown probe mode {mode}")
except AssertionError as exc:
    # A probe that is still waiting is not a failure report: one short line, no traceback.
    print(f"  waiting: {exc}")
    raise SystemExit(1)
PY
}

fetch_instances() {
    curl -fsS --max-time 3 -H 'Accept: application/json' \
        "http://127.0.0.1:$ADMIN_PORT/instances" -o "$LOG_DIR/instances.json" 2>/dev/null
}

echo "== baseline: the window must NOT already name the fifth member =="
baseline=0; attempt=0
while [ "$attempt" -lt 30 ]; do
    if fetch_instances && probe "$LOG_DIR/instances.json" REQUIRE_ABSENT >"$LOG_DIR/probe.log" 2>&1; then
        baseline=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$baseline" = 1 ] || fail "could not read a clean /instances baseline (see $LOG_DIR/admin.log)"

if [ "$ABSENT" != 1 ]; then
    echo "== boot nexus-insight on :$INSIGHT_PORT with registration ON =="
    java -jar "$CLOUD/insight-service/target/app.jar" --server.port="$INSIGHT_PORT" \
        --eureka.client.service-url.defaultZone="http://127.0.0.1:$EUREKA_PORT/eureka/" \
        >"$LOG_DIR/insight.log" 2>&1 &
    PIDS+=("$!")
    wait_up insight "http://127.0.0.1:$INSIGHT_PORT/actuator/health"
else
    echo "== ABSENCE ARM: deliberately NOT booting nexus-insight =="
fi

echo "== poll /instances until the NEXUS-INSIGHT instance itself is UP =="
budget=90
[ "$ABSENT" = 1 ] && budget=12
found=0; attempt=0
while [ "$attempt" -lt "$budget" ]; do
    if fetch_instances && probe "$LOG_DIR/instances.json" REQUIRE_UP >"$LOG_DIR/probe.log" 2>&1; then
        found=1; cat "$LOG_DIR/probe.log"; break
    fi
    attempt=$((attempt + 1)); sleep 1
done
[ "$found" = 1 ] || fail "the admin never surfaced NEXUS-INSIGHT as UP (see $LOG_DIR/admin.log and $LOG_DIR/instances.json)"

echo "PASS: insight admin smoke — the fifth Eureka member is visible UP in the Spring Boot Admin window"
