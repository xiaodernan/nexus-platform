"""D437 - the cost ledger, measured on the live plane.

The AI service may write five tables; `llm_calls` is the cost ledger (§160,
OBSERVABILITY.md §3: "one row per model call"), and the router builds the exact row for
it - `RoutedCall.as_llm_call_row` - which NOTHING ever called. The table was AI-owned and
empty: 0 rows while the model layer ran, measured every call, and threw the measurement
away. The `agent_runs` rows said `prompt_tokens=0, completion_tokens=0, cost_usd=0` for
every one of the 446 runs on the seeded plane, 138 of which had used the mock provider.

So this asks the live plane two questions: does a model call leave a row in the ledger,
and does the run that made it carry the tokens and the cost?
"""

from __future__ import annotations

import asyncio
import os

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
        rows = await conn.fetch(sql, *args)
        return [dict(row) for row in rows]
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


def test_a_model_call_leaves_a_row_in_the_cost_ledger(client):
    r = client.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
    assert r.status_code == 200, r.text
    run_id = client.app.state.deps.ledger.get_all()[-1]["agent_run_id"]

    rows = _fetch(
        "SELECT agent_run_id::text, provider, model, purpose, prompt_tokens, "
        "completion_tokens, cost_usd, latency_ms, status "
        "FROM llm_calls WHERE agent_run_id::text = $1", str(run_id))
    assert rows, (
        "the model call left no row in the cost ledger - `llm_calls` is one row per "
        "model call (§160) and the table was empty")
    row = rows[0]
    assert row["provider"], "the ledger row names no provider"
    assert row["model"], "the ledger row names no model"
    assert row["purpose"], "the ledger row names no purpose"
    assert row["prompt_tokens"] > 0, (
        "the ledger row reports no prompt tokens for a call that had some")
    assert row["latency_ms"] is not None


def test_the_run_carries_the_tokens_the_model_layer_measured(client):
    r = client.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
    assert r.status_code == 200, r.text
    run_id = str(client.app.state.deps.ledger.get_all()[-1]["agent_run_id"])

    rows = _fetch(
        "SELECT prompt_tokens, completion_tokens, cost_usd, provider FROM agent_runs "
        "WHERE id::text = $1", run_id)
    assert rows, "the run was not written"
    row = rows[0]
    assert row["prompt_tokens"] > 0, (
        "the run reports no prompt tokens although the model layer measured some - "
        "AGENT_CONTRACT §8 says a run carries tokens and cost_usd")


def test_the_ledger_and_the_run_agree_on_the_tokens(client):
    r = client.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
    assert r.status_code == 200, r.text
    run_id = str(client.app.state.deps.ledger.get_all()[-1]["agent_run_id"])

    call = _fetch("SELECT prompt_tokens, completion_tokens FROM llm_calls "
                  "WHERE agent_run_id::text = $1", run_id)
    run = _fetch("SELECT prompt_tokens, completion_tokens FROM agent_runs "
                 "WHERE id::text = $1", run_id)
    assert call and run, "the ledger or the run is missing"
    assert int(call[0]["prompt_tokens"]) == int(run[0]["prompt_tokens"]), (
        "the ledger and the run disagree about the tokens of the same call")


def test_the_stream_path_leaves_its_ledger_rows_too(client):
    # D448: the ledger row refers to the run, so the two are written in that order. The
    # stream writes its run in the background, and the ledger row used to be written on
    # its own schedule - so a ledger row could be written BEFORE the run it names, and
    # the foreign key rejected it.
    import time

    with client.stream("POST", "/ai/v1/search/stream",
                       json={"query": "拉麵", "limit": 3}) as resp:
        assert resp.status_code == 200, resp.status_code
        for _line in resp.iter_lines():
            pass

    rows = []
    for _attempt in range(40):
        rows = _fetch("SELECT agent_run_id::text, purpose FROM llm_calls "
                      "WHERE agent_run_id IS NOT NULL")
        if rows:
            break
        time.sleep(0.05)
    assert rows, (
        "the stream's model call left no row in the cost ledger - the ledger row and "
        "the run it names have to be written in that order, and the stream writes its "
        "run in the background")
    assert all(row["agent_run_id"] for row in rows), (
        "a ledger row names no run")
