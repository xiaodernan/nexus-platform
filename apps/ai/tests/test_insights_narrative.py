"""The insights narrative lane — contract tests, model offline.

Mirrors the handbook-ask pins: every failure is fail-closed (degraded + empty paragraph),
every number in the output must appear in the input payload, URL leaks are refused, a flat
day writes flat — the model never invents urgency from synthetic ghosts.
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

STATS = {
    "date": "2026-11-17",
    "total": 22,
    "hourRamp": [1, 0, 0, 0, 0, 0, 0, 2, 4, 5, 6, 4, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "headline": "Today's spectral readers — 22 ghosts",
    "recommendation": "Dwell beats volume",
    "profiles": [
        {"profile": "impatient glance", "count": 5},
        {"profile": "slow reader", "count": 4},
        {"profile": "window shopper", "count": 4},
        {"profile": "random tapper", "count": 3},
        {"profile": "silent bounce", "count": 3},
        {"profile": "bookmarker", "count": 3},
    ],
    "week": {"weeklyTotal": 154, "slope": 0.2, "adviceKind": "flat", "points": []},
    "slope": 0.2,
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


def _resp(text: str, *, cached: int = 0, prompt: int = 120, completion: int = 40) -> LLMResponse:
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


def _looks_like_json(text: str) -> bool:
    try:
        json.loads(text)
        return True
    except Exception:
        return False


def _ask(client: TestClient, router, stats=None) -> dict:
    from dataclasses import replace

    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/insights/narrative", json={
            "stats": stats if stats is not None else STATS,
            "locale": "en",
        })
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        deps.router = original_router  # type: ignore[assignment]
        deps.settings = original_settings  # type: ignore[assignment]


class TestInsightsNarrativeLane:
    def test_mock_provider_degrades(self):
        client = _client()
        resp = client.post("/ai/v1/insights/narrative", json={
            "stats": STATS, "locale": "en",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["paragraph"] == ""
        assert body["focus"] == ""

    def test_a_well_grounded_model_phrase_comes_through(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "paragraph": "Today's 22 ghosts lean on 5 impatient glances; the day drifted flat. Do nothing bold — the biggest risk is chasing this.",
            "focus": "Look at where the 4 slow readers stopped on the page.",
            "confidence": "medium",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert "22 ghosts" in body["paragraph"]
        assert body["confidence"] == "medium"
        assert body["focus"].startswith("Look at")
        assert body["measured"]["prompt_tokens"] == 120

    def test_url_leak_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "paragraph": "The 22 ghosts drift flat; see https://example.com for details.",
            "focus": "Nothing to fix",
            "confidence": "medium",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "url_leak"

    def test_an_invented_number_above_the_floor_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "paragraph": "4387 ghosts wandered in today, flat.",
            "focus": "Nothing to fix",
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "invented_numbers"

    def test_an_invented_small_number_below_the_floor_is_allowed(self):
        # Counts <= 100 are commonplace in a 22-visitor replay; the floor is above them.
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "paragraph": "Today's 22 ghosts: 5 impatient glances dominated; the day is flat — do nothing bold.",
            "focus": "Look at where the 4 slow readers stopped.",
            "confidence": "medium",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert "22 ghosts" in body["paragraph"]

    def test_non_json_reply_degrades(self):
        client = _client()
        canned = _CannedRouter(_resp("here are your ghosts: they walked out."))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "non_json_reply"

    def test_empty_paragraph_degrades(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({"paragraph": "", "focus": "", "confidence": "low"})))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "empty_answer"

    def test_provider_crash_degrades(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "model_unavailable"

    def test_a_flat_day_may_answer_low_confidence(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "paragraph": "The day is flat — do nothing bold.",
            "focus": "Watch the 4 slow readers next week.",
            "confidence": "low",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert body["confidence"] == "low"

    def test_missing_confidence_defaults_to_low(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "paragraph": "The day is flat — do nothing bold.",
            "focus": "Watch it.",
        })))
        body = _ask(client, canned)
        assert body["confidence"] == "low"
