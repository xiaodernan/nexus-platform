"""D444 - a FAILED merchant-agent chat wrote no run.

§8 says every task writes an `agent_runs` row. D431 gave the merchant agent's chat one -
on the success path. The error path was never given one: the chat's `except` yielded the
error frame and stopped, so a merchant turn that broke left no trace in the run ledger at
all, while the SEARCH stream has written its failed run all along.

The two surfaces answer the same question the same way, and one of them was silent. This
file makes the failure path write its run - and makes the ledger say what broke.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

MERCHANT = str(uuid.UUID("66666666-6666-6666-6666-666666666666"))
CONVERSATION = str(uuid.UUID("77777777-7777-7777-7777-777777777777"))


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _chat(client, message: str = "what are your opening hours?"):
    with client.stream("POST", "/ai/v1/merchant-agent/chat", json={
            "merchant_id": MERCHANT, "message": message,
            "conversation_id": CONVERSATION}) as resp:
        assert resp.status_code == 200, resp.status_code
        frames = []
        for line in resp.iter_lines():
            if line.startswith("data:"):
                frames.append(json.loads(line[len("data:"):].strip()))
    return frames


def _break_the_retrieval(monkeypatch):
    """Make the chat's retrieval raise, so the error path is taken."""
    import nexus_ai.api.routes_rag as rag

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("the retrieval fell over")

    monkeypatch.setattr(rag, "retrieve_chunks", _boom)


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_failed_chat_writes_a_failed_run(monkeypatch):
    # The chat only RETRIEVES when it has a pool, so the failure path is a live-plane
    # path - and §427's lesson is that the gate belongs on the plane where the answer is
    # served.
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    _break_the_retrieval(monkeypatch)
    with TestClient(create_app(_settings())) as c:
        frames = _chat(c)
        assert any("code" in f for f in frames), (
            f"the chat did not fail: {frames}")
        runs = c.app.state.deps.ledger.get_all()
        assert runs, "a failed chat wrote no run - §8 says every task writes one"
        run = runs[-1]
        assert run["agent"] == "merchant_agent"
        assert run["status"] == "failed", (
            f"the failed chat's run says {run.get('status')!r}")
        assert run.get("error"), (
            "the failed run carries no error message - and the writer can now write one")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_failed_run_reaches_the_table(monkeypatch):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    _break_the_retrieval(monkeypatch)
    with TestClient(create_app(_settings())) as c:
        frames = _chat(c)
        assert any("code" in f for f in frames)
        run_id = str(c.app.state.deps.ledger.get_all()[-1]["agent_run_id"])

        import asyncpg

        async def _read():
            conn = await asyncpg.connect(DB_URL)
            try:
                return await conn.fetchrow(
                    "SELECT status, error FROM agent_runs WHERE id::text = $1", run_id)
            finally:
                await conn.close()

        row = asyncio.run(_read())
        assert row is not None, "the failed run was not persisted"
        assert row["status"] == "failed"
        assert row["error"], "the persisted failed run carries no error message"
