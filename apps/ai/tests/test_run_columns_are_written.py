"""D443 - the writer names every column the schema has.

The `agent_runs` table is written by ONE writer - `api/runs.py`'s INSERT - and it named 22 of
the schema's 25 columns. The three it dropped were `task_id`, `parent_run_id` and `error`, and
two of those are named by the contract (API_CONTRACT §7's conversation-timeline row lists
`error` and `parent_run_id`; DATABASE.md §3.12 says "`parent_run_id` for nested agents";
AGENT_CONTRACT §8 says "sub-agents link via `parent_run_id`").

So a FAILED run could not say why it failed: the callers fill `error` and the writer dropped
it, so every one of the 13 failed runs on the seeded plane carried `error = NULL`. And no run
could ever link to a parent, because the writer had no way to say so.

This file is the gate for the class: the writer's INSERT must name EVERY column of the
schema's table. A column that exists and cannot be written is a promise nobody keeps - and
the schema is the contract for the writer.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import re
import textwrap
from pathlib import Path

import pytest

from nexus_ai.api import runs

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "infra" / "db" / "migrations" / "V1__init.sql").exists():
            return parent
    raise AssertionError("the repository root was not found from this file")


def _schema_columns() -> list[str]:
    text = (_repo_root() / "infra" / "db" / "migrations" / "V1__init.sql").read_text(
        encoding="utf-8")
    table = text.split("CREATE TABLE agent_runs (", 1)[1].split(");", 1)[0]
    columns = []
    for line in table.splitlines():
        match = re.match(r"\s{2}(\w+)\s+\w", line)
        if match:
            columns.append(match.group(1))
    return columns


def _written_columns() -> list[str]:
    source = inspect.getsource(runs.persist_run)
    columns = source.split("INSERT INTO agent_runs (", 1)[1].split(")", 1)[0]
    return sorted({c.strip() for c in columns.replace("\n", " ").split(",")})


def test_the_writer_names_every_column_the_schema_has():
    schema = set(_schema_columns())
    written = set(_written_columns())
    missing = sorted(schema - written)
    assert not missing, (
        "the agent_runs writer does not name these columns, so a caller that fills one has "
        "no way to write it: " + ", ".join(missing))


def test_the_writer_binds_one_argument_per_column():
    # a placeholder that is not bound, or a bound argument with no placeholder, is a
    # silent loss - the same shape as the dropped columns, one layer down.
    import ast

    source = inspect.getsource(runs.persist_run)
    values = source.split("VALUES (", 1)[1].split(")\n", 1)[0]
    placeholders = {int(n) for n in re.findall(r"\$(\d+)", values)}
    assert placeholders == set(range(1, len(placeholders) + 1)), (
        f"the placeholders are not contiguous: {sorted(placeholders)}")

    # the argument tuple, counted by the parser rather than by lines
    tree = ast.parse(textwrap.dedent(source))
    bound = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "args"
                for target in node.targets):
            bound = len(node.value.elts)  # type: ignore[attr-defined]
    assert bound == len(placeholders), (
        f"the statement binds {len(placeholders)} placeholders but the argument tuple has "
        f"{bound} entries")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_failed_run_says_why_it_failed():
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    async def _go():
        settings = Settings(llm_provider="mock", embedding_provider="hashing",
                            database_url=DB_URL, internal_token="")
        db = await db_pool.connect(settings, force_new=True)
        try:
            run = {
                "agent_run_id": runs.new_id(), "agent": "search", "status": "failed",
                "provider": "mock", "model": None, "conversation_id": None, "user_id": None,
                "tenant_id": "00000000-0000-0000-0000-000000000001",
                "input_summary": "x", "output_summary": None, "plan": {},
                "tool_calls": [], "retrieval": [], "fact_ids": [],
                "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0,
                "latency_ms": 3, "fallback_used": "stream_error",
                "started_at": None, "finished_at": None,
                "error": "the search backend fell over",
            }
            assert await runs.persist_run(db, run) is True

            import asyncpg

            conn = await asyncpg.connect(DB_URL)
            try:
                row = await conn.fetchrow(
                    "SELECT status, error, fallback_used FROM agent_runs "
                    "WHERE id::text = $1", run["agent_run_id"])
            finally:
                await conn.close()
            assert row is not None, "the run was not written"
            assert row["error"] == "the search backend fell over", (
                "the run's error was dropped: a failed run that cannot say why it failed "
                "is a run nobody can debug")
            assert row["status"] == "failed"
        finally:
            await db_pool.dispose()

    asyncio.run(_go())
