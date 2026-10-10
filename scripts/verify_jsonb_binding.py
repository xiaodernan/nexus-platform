#!/usr/bin/env python
"""NEXUS — does `json.dumps(...)` into a `$n::jsonb` placeholder double-encode? Measured, not argued.

WHY THIS EXISTS. A ledger unit read `apps/ai/nexus_ai/api/runs.py` (which passes `json.dumps(value)` into
eight `$n::jsonb` placeholders), measured 188 string-valued jsonb rows on the live demo database, and
concluded that asyncpg "quotes a str again" — i.e. that the AI service double-encodes every jsonb payload it
writes. That is a serious claim about live data and it was reached by reading code plus data, never by
running the binding.

This script runs the binding. It is the falsifier for that claim, and it reports the residue separately so
the two questions — "is the code wrong?" and "are there old rows?" — cannot be confused again.

PLANE DEFECT, FOUND 2026-09-28. The first version of this script measured the DEFAULT asyncpg plane
(`asyncpg.connect` with no codec registered) and printed `CORRECT — one encoding`. The service does not run
on that plane: `nexus_ai/db/pool.py::_init_connection` registers `encoder=json.dumps` on every connection the
pool hands out, so the same `json.dumps(value)` text was encoded a second time and stored as a jsonb
*string*. One measurement, two planes, opposite verdicts. The probe below now writes on BOTH and reads the
verdict off the plane that serves traffic; if the two ever disagree, it says so.

USAGE
    apps/ai/.venv/Scripts/python.exe scripts/verify_jsonb_binding.py

It writes only to TEMP tables (session-scoped, dropped on disconnect) and reads counts from `nexus`.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import asyncpg

#: The service package lives under `apps/ai`; this script is run from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "ai"))

def _dsn(env: str, default: str) -> str:
    """A connection URL from the environment, or the local dev default.

    The script used to hard-code `nexus_app`/`nexus_dev_app_only`, which is why nothing could run it on a
    schedule: CI's AI job provisions `nexus_ai` with a different password (`.github/workflows/ci.yml`), so
    a wired-in step would have failed to connect and — worse — the residue would have looked like a
    driver problem. `NEXUS_TEST_DATABASE_URL` is the name the AI suite already reads, so this reuses the
    variable CI already sets instead of inventing a second one.
    """
    return os.environ.get(env) or default


PROBE_DSN = _dsn("NEXUS_TEST_DATABASE_URL", "postgresql://nexus_app:nexus_dev_app_only@127.0.0.1:5433/nexus_test")
# The residue census reads the demo database, which CI does not seed; `NEXUS_DEMO_DATABASE_URL` is the way to
# point it at one. When it is absent the census reports that it could not run rather than reporting zero rows,
# because "no rows are string-valued" and "I could not look" are different claims.
DEMO_DSN = _dsn("NEXUS_DEMO_DATABASE_URL", "postgresql://nexus_app:nexus_dev_app_only@127.0.0.1:5433/nexus")

PAYLOAD = {"query": "sha tin restaurant", "result_count": 5, "degraded": False}


async def probe() -> int:
    """Write the same payload on BOTH planes and read it back.

    `default` is bare `asyncpg.connect` — the only plane the first version of this script
    measured. `service` is the same connection plus `_init_connection`, which is what the AI
    service hands every request. They do not agree, and the verdict reads the service plane.
    """
    seen: dict[str, dict[str, object]] = {}
    for label, register in (("default", False), ("service", True)):
        conn = await asyncpg.connect(PROBE_DSN)
        try:
            if register:
                from nexus_ai.db.pool import _init_connection

                await _init_connection(conn)
            await conn.execute("create temp table binding_probe (with_cast jsonb, no_cast jsonb)")
            dumped = json.dumps(PAYLOAD, ensure_ascii=False)

            # The shape runs.py actually uses: a Python str holding JSON text, bound to `$n::jsonb`.
            await conn.execute("insert into binding_probe (with_cast) values ($1::jsonb)", dumped)
            # The shape the ledger's claim implies would be needed: the Python object itself.
            try:
                await conn.execute("insert into binding_probe (no_cast) values ($1)", PAYLOAD)
                object_binding = "accepted"
            except asyncpg.exceptions.DataError as exc:
                object_binding = f"rejected by asyncpg ({str(exc).split('(')[-1].rstrip(')')})"

            row = await conn.fetchrow(
                "select jsonb_typeof(with_cast) as kind, with_cast->>'query' as key_read "
                "from binding_probe"
            )
            seen[label] = {"kind": row["kind"], "key_read": row["key_read"],
                           "object_binding": object_binding}
        finally:
            await conn.close()

    print("BINDING PROBE — `$1::jsonb` with json.dumps(...), the shape runs.py uses")
    print(f'  {"plane":<8} {"stored jsonb_typeof":<21} {"->>query":<24} dict instead')
    for label, r in seen.items():
        print(f'  {label:<8} {r["kind"]:<21} {r["key_read"]!r:<24} {r["object_binding"]}')
    service = seen["service"]
    verdict = ("CORRECT — one encoding, keys readable" if service["kind"] == "object"
               else "DOUBLE-ENCODED on the service plane — the plane that serves traffic")
    print(f"  verdict on the service plane    {verdict}")
    if seen["default"]["kind"] != service["kind"]:
        print("  the planes disagree: a probe that measures only the default one certifies a "
              "service you are not running")
    return 0 if verdict.startswith("CORRECT") else 1


async def residue() -> None:
    conn = await asyncpg.connect(DEMO_DSN)
    try:
        rows = await conn.fetch(
            """
            select 'events.properties' as col, count(*) as n, max(occurred_at) as latest
            from events where jsonb_typeof(properties) = 'string'
            union all
            select 'agent_runs.tool_calls', count(*), max(started_at)
            from agent_runs where jsonb_typeof(tool_calls) = 'string'
            union all
            select 'agent_runs.retrieval', count(*), max(started_at)
            from agent_runs where jsonb_typeof(retrieval) = 'string'
            union all
            select 'agent_runs.plan', count(*), max(started_at)
            from agent_runs where jsonb_typeof(plan) = 'string'
            union all
            select 'events.context', count(*), max(occurred_at)
            from events where jsonb_typeof(context) = 'string'
            union all
            select 'agent_runs.tool_calls (not string)', count(*), max(started_at)
            from agent_runs where jsonb_typeof(tool_calls) <> 'string'
            """
        )
        print()
        print("LIVE RESIDUE on the demo database — string-valued jsonb rows, with the newest timestamp")
        for r in rows:
            print(f"  {r['col']:<32} {r['n']:>5}  newest {r['latest']}")
        print()
        print("A row count says 'some rows are like this'. The timestamp says whether the writer still does")
        print("it: residue from a fixed writer stops growing, a live defect does not.")
    finally:
        await conn.close()


async def main() -> int:
    code = await probe()
    try:
        await residue()
    except Exception as exc:  # the demo database is not always loaded
        print(f"\nLIVE RESIDUE unavailable: {exc}")
    return code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
