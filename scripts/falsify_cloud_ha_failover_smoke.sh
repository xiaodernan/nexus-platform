#!/usr/bin/env bash
# NEXUS D897 — the HA-failover smoke is falsifiable, not merely green with a running gateway.
#
#   It boots the SAME pair, kills the SAME primary and registers the SAME upstream with the
#   SECONDARY, but gives the gateway ONLY the dead primary's Eureka URL. The unchanged
#   "the gateway must resolve lb://NEXUS-PLATFORM after the primary died" assertion MUST exit
#   non-zero. Its output must prove the red is ATTRIBUTABLE: both registries came up, the
#   gateway was healthy, the primary really died, the SECONDARY really holds the upstream UP,
#   and the failure is the missing lb:// answer — not a dead JVM or a fixture that never registered.
#
# Usage:  bash scripts/falsify_cloud_ha_failover_smoke.sh
# Env:    NEXUS_HA_FAILOVER_SKIP_BUILD=1 is set here; both jars must already be built.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-ha-failover-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== single-registry arm: both nodes up, primary killed, upstream on the secondary only =="
output="$(NEXUS_HA_FAILOVER_SINGLE=1 NEXUS_HA_FAILOVER_SKIP_BUILD=1 \
    NEXUS_HA_FAILOVER_PORT_1="${NEXUS_HA_FAILOVER_FALSIFY_PORT_1:-18965}" \
    NEXUS_HA_FAILOVER_PORT_2="${NEXUS_HA_FAILOVER_FALSIFY_PORT_2:-18966}" \
    NEXUS_HA_FAILOVER_GATEWAY_PORT="${NEXUS_HA_FAILOVER_FALSIFY_GATEWAY_PORT:-18100}" \
    NEXUS_HA_FAILOVER_FIXTURE_PORT="${NEXUS_HA_FAILOVER_FALSIFY_FIXTURE_PORT:-19122}" \
    bash "$ROOT/scripts/cloud_ha_failover_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -20

[ "$rc" -ne 0 ] || fail "the single-registry arm PASSED — a failover smoke green with one registry proves nothing"
for marker in \
    "SINGLE-REGISTRY ARM" \
    "both eureka nodes up" \
    "gateway healthy on" \
    "primary node is down" \
    "secondary node is still UP" \
    "secondary node lists NEXUS-PLATFORM UP" \
    "no lb://NEXUS-PLATFORM answer after the primary died"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the single-registry arm failed for the wrong reason (missing marker: $marker)"
done

echo "PASS: cloud HA failover falsifier — with the second registry URL removed the resolution reddens"
