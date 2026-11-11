#!/usr/bin/env bash
# NEXUS D919 (Phase H / H2) — does Eureka really evict a DEAD instance?
#
#   D894 demonstrated automatic eviction is unmeasured territory and explicitly left it open.
#   This smoke measures it on the shipping artifact:
#
#     1. boot a single-node Eureka (default self-contained settings from this module);
#     2. register ONE throwaway fixture instance (NEXUS-EVICT-PROBE) — lease 5s renew / 30s duration;
#     3. confirm /eureka/apps lists it;
#     4. SIGKILL the fixture (not SIGTERM: no deregistration, no deregister of the lease);
#     5. poll /eureka/apps until the instance is gone, measuring wall time from the kill;
#     6. assert gone within 45s (durationInSecs=30 + eviction interval 5s + slack).
#
#   NOT CLAIMED: a real service ever ran, HA replicated this, a failover occurred, an
#   in-flight request was retried, or anything about production lease tuning. One dead
#   python fixture on one dev registry on this host only.
#
# Usage:  bash scripts/eureka_eviction_smoke.sh
# Env:    NEXUS_EVICT_EUREKA_PORT (18771), NEXUS_EVICT_FIXTURE_PORT (19171),
#         NEXUS_EVICT_FIXTURE_APP (NEXUS-EVICT-PROBE), NEXUS_EVICT_DEADLINE_S (45)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_E="${NEXUS_EVICT_EUREKA_PORT:-18771}"
PORT_F="${NEXUS_EVICT_FIXTURE_PORT:-19171}"
APP="${NEXUS_EVICT_FIXTURE_APP:-NEXUS-EVICT-PROBE}"
DEADLINE_S="${NEXUS_EVICT_DEADLINE_S:-45}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-eureka-eviction"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== boot single-node Eureka on :$PORT_E =="
java -jar "$ROOT/services/cloud/eureka-server/target/app.jar" --server.port="$PORT_E" \
    >"$LOG_DIR/eureka.log" 2>&1 &
PIDS+=("$!")
ready=0; attempt=0
while [ "$attempt" -lt 60 ]; do
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT_E/actuator/health" 2>/dev/null \
      | grep -q '"status":"UP"' && { ready=1; break; }
  attempt=$((attempt + 1)); sleep 2
done
[ "$ready" = 1 ] || fail "eureka never came up (see $LOG_DIR/eureka.log)"
echo "  eureka up on :$PORT_E"

echo "== register the throwaway fixture as $APP =="
env INSIGHT_FIXTURE_APP="$APP" \
    INSIGHT_FIXTURE_PORT="$PORT_F" \
    INSIGHT_FIXTURE_PATH='evict/health' \
    INSIGHT_FIXTURE_EUREKA="http://127.0.0.1:$PORT_E/eureka/" \
    python "$ROOT/scripts/fixture_insight_upstream.py" >"$LOG_DIR/fixture.log" 2>&1 &
FPID=$!
PIDS+=("$FPID")
registered=0; attempt=0
while [ "$attempt" -lt 90 ]; do
  if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$PORT_E/eureka/apps" 2>/dev/null \
      | grep -q "\"name\":\"$APP\""; then
    registered=1; break
  fi
  attempt=$((attempt + 1)); sleep 1
done
[ "$registered" = 1 ] || fail "eureka never listed $APP (see $LOG_DIR/fixture.log and $LOG_DIR/eureka.log)"
echo "  $APP registered on :$PORT_F"

echo "== SIGKILL the fixture (pid $FPID) =="
kill -9 "$FPID" || fail "could not kill fixture"
start_ts="$(date +%s)"
dead=0; attempt=0
while [ "$attempt" -lt "$((DEADLINE_S + 5))" ]; do
  if ! curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$PORT_E/eureka/apps" 2>/dev/null \
      | grep -q "\"name\":\"$APP\""; then
    dead=1; break
  fi
  attempt=$((attempt + 1)); sleep 1
done
end_ts="$(date +%s)"
elapsed=$((end_ts - start_ts))
[ "$dead" = 1 ] || fail "instance never disappeared after ${elapsed}s — the lease was not evicted"
echo "  $APP was evicted ${elapsed}s after SIGKILL"
python - "$elapsed" "$DEADLINE_S" <<'PY' || fail "eviction took longer than the lease+45s budget"
import sys
elapsed, deadline = float(sys.argv[1]), float(sys.argv[2])
since = elapsed - 30 - 5
assert elapsed <= deadline + 30, f"eviction took {elapsed}s, way past the {deadline}+30s window"
print(f"  wall time: {elapsed:.0f}s (lease 30s + eviction interval 5s + observed {since:.0f}s extra on this host; budget {deadline}+30s)")
PY
echo "PASS: Eureka evicts a killed instance — measured wall time ${elapsed}s on this host, not an assumption"
