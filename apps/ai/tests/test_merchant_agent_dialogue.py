"""D846 - the consumer's question and the agent's answer reach the thread.

The merchant console's inbox reads `/api/v1/conversations/**`; the chat stream previously wrote
only its `agent_runs` row, so a consumer turn and its answer never entered that timeline. The AI
service now relays both through the platform's single audited internal door.

These cases are DB-free: the recording stub is the client the service would use against the
platform, and it records exactly what would cross the wire.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from nexus_ai.adapters.platform import (
    StubPlatformClient,
    reset_platform_client,
    set_platform_client,
)
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

MERCHANT = str(uuid.UUID("44444444-4444-4444-4444-444444444444"))
QUESTION = "\u6709\u4ec0\u9ebc\u83dc\u5f0f\uff1f"


def _client(*, internal_token: str = "test-internal-token") -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token=internal_token)
    return TestClient(create_app(settings))


def _turns(stub: StubPlatformClient) -> list[dict]:
    return [call for call in stub.calls if call["op"] == "append_conversation_message"]


def test_the_chat_relays_the_question_and_the_answer_in_order():
    stub = StubPlatformClient()
    set_platform_client(stub)
    conversation = str(uuid.uuid4())
    try:
        with _client() as c:
            r = c.post("/ai/v1/merchant-agent/chat", json={
                "merchant_id": MERCHANT, "message": QUESTION,
                "conversation_id": conversation})
            assert r.status_code == 200, r.text
    finally:
        reset_platform_client()

    turns = _turns(stub)
    assert [t["sender_type"] for t in turns] == ["user", "ai_agent"], turns
    assert turns[0]["content"] == QUESTION
    assert turns[0]["handoff"] is False
    assert turns[0]["conversation_id"] == conversation
    # Offline there are no chunks, so the answer is the honest handoff - and it is still persisted.
    assert turns[1]["handoff"] is True
    assert turns[1]["content"]
    assert turns[0]["has_internal_token"] is True


def test_without_the_token_the_stream_is_unchanged_and_writes_nothing():
    stub = StubPlatformClient()
    set_platform_client(stub)
    conversation = str(uuid.uuid4())
    try:
        with _client(internal_token="") as c:
            r = c.post("/ai/v1/merchant-agent/chat", json={
                "merchant_id": MERCHANT, "message": QUESTION,
                "conversation_id": conversation})
            assert r.status_code == 200, r.text
    finally:
        reset_platform_client()

    assert _turns(stub) == [], "an unconfigured door must not be called at all"


def test_a_failed_write_never_replaces_the_answer():
    class Broken(StubPlatformClient):
        async def append_conversation_message(self, *args, **kwargs):
            raise RuntimeError("platform is down")

    set_platform_client(Broken())
    conversation = str(uuid.uuid4())
    try:
        with _client() as c:
            r = c.post("/ai/v1/merchant-agent/chat", json={
                "merchant_id": MERCHANT, "message": QUESTION,
                "conversation_id": conversation})
            assert r.status_code == 200, r.text
            assert "summary" in r.text
            entries = c.app.state.deps.ledger.by_conversation(conversation)
    finally:
        reset_platform_client()

    assert entries, "the run row must survive a failed dialogue write"
