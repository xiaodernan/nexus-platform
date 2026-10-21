"""D431 - the merchant agent's chat writes its `agent_runs` row.

AGENT_CONTRACT §8: every task writes an `agent_runs` row, and the runs of one conversation
link together. The chat's request REQUIRES a conversation_id, so the caller has already paid
for the linkage - and the turn was invisible: the conversation timeline could not show the
agent's own turns at all.

These cases are DB-free (the in-process ledger is the same mirror the timeline reads), and
they pin the four things the run has to carry: the conversation, the merchant, the message and
the answer - plus the grounded/degraded distinction, because a handoff is a different outcome
from an answer and the run says which one it was.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

MERCHANT = str(uuid.UUID("44444444-4444-4444-4444-444444444444"))


def _client():
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def test_the_chat_writes_a_run_for_its_conversation():
    conversation = str(uuid.uuid4())
    with _client() as c:
        r = c.post("/ai/v1/merchant-agent/chat", json={
            "merchant_id": MERCHANT, "message": "\u6709\u4ec0\u9ebc\u83dc\u5f0f\uff1f",
            "conversation_id": conversation})
        assert r.status_code == 200, r.text
        entries = c.app.state.deps.ledger.by_conversation(conversation)

    assert entries, "the chat wrote no run for the conversation it was given"
    run = entries[-1]
    assert run["agent"] == "merchant_agent"
    assert run["conversation_id"] == conversation
    assert run["merchant_id"] == MERCHANT
    assert run["input_summary"], "the run does not say what was asked"
    assert run["output_summary"], "the run does not say what was answered"
    assert run["agent_run_id"]


def test_a_handoff_is_recorded_as_degraded():
    conversation = str(uuid.uuid4())
    with _client() as c:
        r = c.post("/ai/v1/merchant-agent/chat", json={
            "merchant_id": MERCHANT, "message": "\u6709\u4ec0\u9ebc\u83dc\u5f0f\uff1f",
            "conversation_id": conversation})
        assert r.status_code == 200, r.text
        entries = c.app.state.deps.ledger.by_conversation(conversation)

    assert entries
    run = entries[-1]
    # Offline the merchant has no chunks, so the agent cannot ground an answer: the run
    # must say that (a handoff is a different outcome from an answer).
    assert run["degraded"] is True
    assert run["status"] == "degraded"
    assert run["fallback_used"] == "no_grounded_chunks"
