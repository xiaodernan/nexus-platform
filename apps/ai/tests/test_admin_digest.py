"""The admin digest lane — contract tests, model offline.

Mirrors the handbook-ask pins: every failure is fail-closed (degraded + empty content), no URLs,
and — one notch stricter — the model may never write a number that is not present in the
payload. That is the fence between "the operator can trust this paragraph" and "the model
plausibly invented a trend".
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

EVENTS = {
    "xlen": 913,
    "pending": 2,
    "consumers": 1,
    "disabled": False,
    "degraded": False,
    "recent_count": 5,
    "top_templates": ["guide_read", "search"],
}


def _client() -> TestClient:
    return TestClient(A.create_app())


class _CannedRouter:
    def __init__(self, reply: LLMResponse | Exception) -> None:
        self._reply = reply
        self.calls: list[object] = []

    async def run(self, req, meter=None):
        self.calls.append(req)
        if isinstance(self._reply, Exception):
            raise self._reply
        return _RoutedCall(self._reply)


class _RoutedCall:
    def __init__(self, response):
        self.response = response


def _looks_like_json(text: str) -> bool:
    try:
        json.loads(text)
        return True
    except Exception:
        return False


def _resp(text: str, *, cached: int = 0, prompt: int = 220, completion: int = 60) -> LLMResponse:
    return LLMResponse(
        text=text,
        data=json.loads(text) if _looks_like_json(text) else None,
        provider="fake",
        model="fake-1",
        prompt_tokens=prompt,
        completion_tokens=completion,
        cached_tokens=cached,
        cache_reported=True,
        cost_usd=0.001,
        latency_ms=42,
        degraded=False,
    )


def _digest(client: TestClient, router, events=None) -> dict:
    from dataclasses import replace

    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/admin/digest", json={
            "events": events if events is not None else EVENTS,
            "locale": "en",
        })
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        deps.router = original_router  # type: ignore[assignment]
        deps.settings = original_settings  # type: ignore[assignment]


class TestGroundedDigest:
    def test_mock_provider_degrades(self):
        client = _client()
        resp = client.post("/ai/v1/admin/digest", json={"events": EVENTS, "locale": "en"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["reading"] == ""

    def test_the_happy_path_passes_through_with_measurements(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "reading": "The stream holds 913 rows with 2 pending; one consumer is behind.",
            "actions": [
                {"action": "Drain the consumer group", "why": "pending=2 with one consumer"},
            ],
            "confidence": "high",
        })))
        body = _digest(client, canned)
        assert body["degraded"] is False
        assert body["confidence"] == "high"
        assert body["measured"]["prompt_tokens"] == 220
        assert canned.calls
        prompt = canned.calls[0].prompt  # type: ignore[attr-defined]
        assert "913" in prompt and "pending" in prompt

    def test_a_number_not_in_the_payload_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "reading": "The stream holds 950 rows, trending toward saturation.",
            "actions": [],
            "confidence": "medium",
        })))
        body = _digest(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "numeric_leak"
        assert body["reading"] == ""

    def test_a_url_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "reading": "Check https://status.example.com for the stream health.",
            "actions": [],
            "confidence": "low",
        })))
        body = _digest(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "url_leak"

    def test_actions_are_capped_at_three_and_trimmed(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "reading": "Quiet stream; 913 rows buffered.",
            "actions": [{"action": f"a{i}" * 40, "why": "b" * 400} for i in range(5)],
            "confidence": "low",
        })))
        body = _digest(client, canned)
        assert body["degraded"] is False
        assert len(body["actions"]) == 3
        for action in body["actions"]:
            assert len(action["action"]) <= 120
            assert len(action["why"]) <= 120

    def test_unparseable_model_reply_degrades(self):
        client = _client()
        canned = _CannedRouter(_resp("everything is fine"))
        body = _digest(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "non_json_reply"

    def test_a_provider_crash_degrades(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _digest(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "model_unavailable"

    def test_a_quiet_system_may_answer_low_confidence(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "reading": "The system is quiet: 0 pending, no recent events.",
            "actions": [],
            "confidence": "low",
        })))
        quiet = {**EVENTS, "xlen": 0, "pending": 0, "disabled": False, "recent_count": 0, "top_templates": []}
        body = _digest(client, canned, events=quiet)
        assert body["degraded"] is False
        assert body["confidence"] == "low"

    def test_missing_confidence_defaults_to_low(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "reading": "Quiet: 913 rows.",
            "actions": [],
        })))
        body = _digest(client, canned)
        assert body["confidence"] == "low"
