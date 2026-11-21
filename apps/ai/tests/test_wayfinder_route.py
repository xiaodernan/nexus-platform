"""D1479 — `POST /ai/v1/world/wayfinder` seam: mock inert, live fenced and measured."""
from __future__ import annotations

import json
from dataclasses import replace

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

BODY = {"locale": "en", "position": 1, "mood": "continue"}


def _client() -> TestClient:
    return TestClient(A.create_app())


class _Canned:
    def __init__(self, text: str) -> None:
        self.text = text
        self.calls: list[object] = []

    async def run(self, req, meter=None):
        self.calls.append(req)
        return type("Call", (), {"response": LLMResponse(
            text=self.text, provider="fake", model="fake-1", degraded=False,
            prompt_tokens=1200, completion_tokens=90, cached_tokens=400,
            cache_reported=True, cost_usd=0.001, latency_ms=42,
        )})()


def _live(client: TestClient, router, body=BODY):
    app = client.app
    deps = app.state.deps
    old_router, old_settings = deps.router, deps.settings
    deps.router = lambda: router
    deps.settings = replace(old_settings, llm_provider="openai")
    try:
        return client.post("/ai/v1/world/wayfinder", json=body)
    finally:
        deps.router, deps.settings = old_router, old_settings


def test_mock_provider_is_inert():
    resp = _client().post("/ai/v1/world/wayfinder", json=BODY)
    assert resp.status_code == 200
    body = resp.json()
    assert body["degraded"] is True
    assert body["reason"] == "mock_provider"
    assert body["chapter"] == 0


def test_bad_mood_is_rejected_by_contract_length_only():
    # a long mood cannot smuggle a prompt: Pydantic max_length forbids it at the seam
    resp = _client().post("/ai/v1/world/wayfinder", json={**BODY, "mood": "x" * 33})
    assert resp.status_code == 422


def test_live_canned_reply_passes_the_fence_and_measured_block():
    reply = {
        "chapter": 2, "reason": "The second room keeps the same hour as the first.",
        "notice": "Watch how the register is counted.", "confidence": "medium",
    }
    canned = _Canned(json.dumps(reply))
    resp = _live(_client(), canned)
    assert resp.status_code == 200
    assert len(canned.calls) == 1
    body = resp.json()
    assert body["degraded"] is False
    assert body["chapter"] == 2
    assert body["title"]  # real atlas title, never model-invented
    assert body["why"] == reply["reason"]
    assert body["measured"]["cached_tokens"] == 400


def test_live_invented_chapter_degrades():
    reply = {"chapter": 999, "reason": "A room that never existed.", "notice": "", "confidence": "high"}
    resp = _live(_client(), _Canned(json.dumps(reply)))
    body = resp.json()
    assert body["degraded"] is True
    assert body["reason"] == "chapter_outside_shortlist"
    assert body["chapter"] == 0
