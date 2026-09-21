#!/usr/bin/env python3
"""NEXUS seed entry point.

The Makefile's `seed` / `db-migrate` targets call this file, so it is the stable CLI for the dataset
generator. The actual implementation lives in build_load.py next to it; this shim keeps the documented
entry point working no matter which module ends up owning generation.

Usage:
    python data/seed/generate.py [--out data/seed/out] [--counts merchants=500,offerings=5000,reviews=10000]

All produced rows are synthetic demo data (spec §86, §109): invented merchants, example.* domains and
data_origin='demo'. Nothing here pretends to be a real Hong Kong business.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

for module in ("build_load.py", "generate_data.py", "seed.py"):
    target = HERE / module
    if target.exists():
        sys.argv[0] = str(target)
        runpy.run_path(str(target), run_name="__main__")
        break
else:
    raise SystemExit(
        "NEXUS seed: no generator module found next to generate.py (looked for build_load.py, "
        "generate_data.py, seed.py). The dataset builder has not landed yet — see data/seed/README.md."
    )
