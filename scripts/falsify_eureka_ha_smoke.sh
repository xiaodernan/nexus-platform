#!/usr/bin/env bash
# NEXUS D894 — prove the HA replication smoke is falsifiable, not merely green with peer wiring on.
#
#   It boots the SAME two Eureka JVMs WITHOUT the explicit zone/peer wiring, registers the same
#   fixture into node 1, and runs the smoke's unchanged replication assertion with a short budget.
#   The arm MUST EXIT NON-ZERO. Its output must also show both nodes up, a clean baseline and the
#   fixture's direct registration on node 1 — otherwise a red caused by a dead JVM would look like
#   a red caused by replication being switched off.
#
#   Separate coordinates from the presence smoke's, so a JVM that outlived its cleanup cannot
#   answer readiness probes and turn the absence arm into a false pass.
#
#   NOT CLAIMED: that this arm says anything about the presence arm on another host, or about
#   gateway failover. It proves one thing: with the peer wiring removed, the assertion reddens.
#
# Usage:  bash scripts/falsify_eureka_ha_smoke.sh
# Env:    NEXUS_HA_SKIP_BUILD=1 is set here; the eureka jar must already exist.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-eureka-ha-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== absence arm: two independent registries, no zone/peer wiring =="
output="$(NEXUS_HA_NO_PEER=1 NEXUS_HA_SKIP_BUILD=1 \
    NEXUS_HA_PORT_1="${NEXUS_HA_FALSIFY_PORT_1:-18963}" \
    NEXUS_HA_PORT_2="${NEXUS_HA_FALSIFY_PORT_2:-18964}" \
    NEXUS_HA_PROBE_PORT="${NEXUS_HA_FALSIFY_PROBE_PORT:-19121}" \
    bash "$ROOT/scripts/eureka_ha_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -14

[ "$rc" -ne 0 ] || fail "the no-peer arm PASSED — a replication smoke that is green without peers proves nothing"
for marker in \
    "eureka1 up" \
    "eureka2 up" \
    "baseline: no NEXUS-HA-PROBE" \
    "node1 directly registered NEXUS-HA-PROBE" \
    "peer replication did not converge"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the no-peer arm failed for the wrong reason (missing marker: $marker)"
done

echo "PASS: eureka HA falsifier — with peers removed the replication assertion reddens, with both nodes up"
