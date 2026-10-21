"""D440 - a run says when it finished.

API_CONTRACT §7's conversation-timeline row names the fields each run carries, and
`started_at` and `finished_at` are two of them:

    Each run is its `agent_runs` row (`agent_run_id, agent, model, provider, status, plan,
    ..., started_at, finished_at, parent_run_id`)

Measured on the seeded live plane before this unit: `finished_at` was NULL in 446 of 446
rows. The column has no default and no caller ever passed one - the recorder had no end to
write, because the run's clock was a monotonic millisecond counter and the wall clock was
never stamped.

So the recorder stamps the finish (the write IS the finish) and back-solves the start from
the measured latency, and this asks the live plane for both - and checks that the pair
agrees with the latency the run measured.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


async def _rows(sql: str, *args) -> list[dict]:
    import asyncpg

    conn = await asyncpg.connect(DB_URL)
    try:
        return [dict(row) for row in await conn.fetch(sql, *args)]
    finally:
        await conn.close()


def _fetch(sql: str, *args) -> list[dict]:
    return asyncio.run(_rows(sql, *args))


@pytest.fixture
def client():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        yield c


def test_a_run_carries_both_ends(client):
    r = client.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
    assert r.status_code == 200, r.text
    run_id = str(client.app.state.deps.ledger.get_all()[-1]["agent_run_id"])

    rows = _fetch(
        "SELECT started_at, finished_at, latency_ms FROM agent_runs WHERE id::text = $1",
        run_id)
    assert rows, "the run was not written"
    row = rows[0]
    assert row["finished_at"] is not None, (
        "the run says when it started and never when it finished")
    assert row["started_at"] is not None


def test_the_two_ends_agree_with_the_latency_the_run_measured(client):
    r = client.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
    assert r.status_code == 200, r.text
    run_id = str(client.app.state.deps.ledger.get_all()[-1]["agent_run_id"])

    row = _fetch(
        "SELECT started_at, finished_at, latency_ms FROM agent_runs WHERE id::text = $1",
        run_id)[0]
    started = row["started_at"]
    finished = row["finished_at"]
    assert started.tzinfo is not None and finished.tzinfo is not None
    measured = (finished - started).total_seconds() * 1000
    assert abs(measured - int(row["latency_ms"] or 0)) <= 50, (
        f"the run's two ends say {measured:.0f}ms while it measured "
        f"{row['latency_ms']}ms")


def test_the_in_process_ledger_carries_the_end_too(client):
    r = client.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
    assert r.status_code == 200, r.text
    run = client.app.state.deps.ledger.get_all()[-1]
    assert run.get("finished_at"), (
        "the in-process run carries no end - the offline timeline would show a run that "
        "never finished")
    assert run.get("started_at")
    finished = datetime.fromisoformat(str(run["finished_at"]).replace("Z", "+00:00"))
    assert finished.tzinfo is not None
    assert finished <= datetime.now(timezone.utc)
