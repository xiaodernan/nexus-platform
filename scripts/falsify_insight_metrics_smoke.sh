#!/usr/bin/env bash
# NEXUS D918 — the metrics smoke's absence arm: without the driving calls the counter cannot move.
# The process and the meter list MUST still come up, and the COUNT must stay 0 — that is the falsifier.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEXUS_METRICS_SKIP_DRIVE=1 bash "$ROOT/scripts/insight_metrics_smoke.sh"
