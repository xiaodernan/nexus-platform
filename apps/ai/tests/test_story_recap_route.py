"""D1468 — `POST /ai/v1/story/recap` seam: mock inert, live fenced and measured."""
from __future__ import annotations

import json
from dataclasses import replace

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

BODY = {"locale": "en", "start": 153, "end": 164}


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
        return client.post("/ai/v1/story/recap", json=body)
    finally:
        deps.router, deps.settings = old_router, old_settings


def test_mock_provider_is_inert():
    resp = _client().post("/ai/v1/story/recap", json=BODY)
    assert resp.status_code == 200
    body = resp.json()
    assert body["degraded"] is True
    assert body["reason"] == "mock_provider"
    assert body["recap"] == ""


def test_live_canned_reply_passes_the_fence_and_measured_block():
    reply = {
        "recap": "Chapters 153 to 164 stay at the east gate: Ah Lok keeps the old books, Ah Muk hangs the tags, Ah Wan works the floor, and a parcel arrives from Chan Bok past.",
        "watch": "The brush-ink sender is still unnamed.",
        "confidence": "medium",
    }
    canned = _Canned(json.dumps(reply))
    resp = _live(_client(), canned)
    assert resp.status_code == 200
    assert len(canned.calls) == 1
    body = resp.json()
    assert body["degraded"] is False
    assert body["recap"] == reply["recap"]
    assert body["watch"] == reply["watch"]
    assert body["measured"]["cached_tokens"] == 400


def test_live_url_leak_degrades():
    reply = {
        "recap": "https://example.com has the gate's whole history [p1].",
        "watch": "See the source.",
        "confidence": "high",
    }
    resp = _live(_client(), _Canned(json.dumps(reply)))
    body = resp.json()
    assert body["recap"] == ""  # the URL-bearing recap is dropped, never shown
    assert "https://" not in str(body)
