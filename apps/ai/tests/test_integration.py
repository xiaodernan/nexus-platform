"""Optional DB integration test — runs ONLY when a real `nexus_ai` database is reachable.

Skips cleanly otherwise, so the default `pytest -m "not integration"` suite stays green
with no infrastructure. It exercises the live Postgres read path and a parameterised
INSERT into the AI-owned `agent_runs`, proving the read-only tx + write discipline works
against the real grants (00_roles.sql). Point it at the container via
`NEXUS_TEST_DATABASE_URL=postgresql://nexus_ai:...@127.0.0.1:5433/nexus`.
"""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set — live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def test_health_reports_live_database(live_settings):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        body = c.get("/ai/v1/health").json()
        assert body["database"]["configured"] is True
        assert body["database"]["available"] is True


def test_search_runs_against_live_data(live_settings):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        r = c.post("/ai/v1/search", json={"query": "restaurant", "limit": 3})
        assert r.status_code == 200, r.text
        assert isinstance(r.json()["items"], list)


def _published_merchants(live_settings) -> int:
    """How much real data this database carries — CI provisions the schema without the demo
    seed, and an assertion that passes on an empty `merchants` table proves nothing (D23)."""
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            rows = await db.readonly(
                "select count(*) as n from merchants where status = 'published'")
            return int(rows[0]["n"])
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_category_filter_is_applied_by_the_database(live_settings):
    """A categorised query must return rows, and a bucket the taxonomy does not contain must
    return none — proving the filter reaches Postgres instead of being dropped or string-matched
    against `category_primary`, which silently returned zero for every bucket."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database — needs the demo seed")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        hits = c.post("/ai/v1/search", json={"query": "sha tin restaurant", "limit": 5}).json()
        assert hits["items"], hits
        none = c.post("/ai/v1/search", json={"query": "sha tin cinema", "limit": 5}).json()
        assert none["items"] == [], none


def test_persist_run_insert_is_allowed(live_settings):
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            from nexus_ai.api import runs

            run = {"agent_run_id": runs.new_id(), "agent": "search", "status": "succeeded",
                   "provider": "mock", "model": "mock-heuristic-1", "conversation_id": None,
                   "user_id": None, "tenant_id": "00000000-0000-0000-0000-000000000001",
                   "input_summary": "x", "output_summary": "y", "plan": {},
                   "tool_calls": [], "retrieval": [], "fact_ids": [], "prompt_tokens": 0,
                   "completion_tokens": 0, "cost_usd": 0.0, "latency_ms": 1,
                   "fallback_used": None, "started_at": None, "finished_at": None}
            assert await runs.persist_run(db, run) is True
        finally:
            await db_pool.dispose()

    asyncio.run(_go())
