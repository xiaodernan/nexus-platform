"""The chapter-companion lane — contract tests, model offline.

Mirrors the handbook-ask pins: every failure is fail-closed (degraded + empty answer), citations
must name excerpts from the one chapter in play, URL leaks are refused, and the CI plane never
pays for a live call.
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

SECTIONS = [
    {"id": "p1", "kicker": "RECURRENT", "title": "Chapter 5 · dawn over the cha chaan teng", "body": "Half six in the morning: the wok fires wake before the shutter does."},
    {"id": "p2", "kicker": "RECURRENT", "title": "Chapter 5 · the regulars", "body": "Cheung wai keeps the last window table; the sampan grandmother reads the paper by the counter."},
    {"id": "p3", "kicker": "RECURRENT", "title": "Chapter 5 · the order", "body": "Lai chai poet order: one black coffee, one boiled egg, toast. He pays in coins kept in a tea-tin."},
]


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


def _resp(text: str, *, cached: int = 0, prompt: int = 140, completion: int = 48) -> LLMResponse:
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


def _ask(client: TestClient, router, question: str = "what time is it?", sections=None) -> dict:
    from dataclasses import replace

    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/chapter/ask", json={
            "question": question,
            "chapter_id": "hk-cha-chaan-teng-dawn",
            "chapter_title": "茶餐廳・早朝",
            "sections": sections if sections is not None else SECTIONS,
            "locale": "zh-HK",
        })
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        deps.router = original_router  # type: ignore[assignment]
        deps.settings = original_settings  # type: ignore[assignment]


class TestGroundedLane:
    def test_mock_provider_degrades(self):
        client = _client()
        resp = client.post("/ai/v1/chapter/ask", json={
            "question": "what time is it?",
            "chapter_id": "hk-cha-chaan-teng-dawn",
            "chapter_title": "茶餐廳・早朝",
            "sections": SECTIONS,
            "locale": "zh-HK",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["answer"] == ""

    def test_the_happy_path_passes_through_with_measurements(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Half six — the woks wake before the shutter [p1].",
            "citations": [{"id": "p1", "title": "Chapter 5 · dawn over the cha chaan teng"}],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert "p1" == body["citations"][0]["id"]
        assert body["confidence"] == "high"
        assert body["measured"]["completion_tokens"] == 48
        assert canned.calls, "the model router must have been invoked"
        prompt = canned.calls[0].prompt  # type: ignore[attr-defined]
        assert prompt.startswith("Chapter: ")
        assert "what time is it?" in prompt
        for cid in ("[p1]", "[p2]", "[p3]"):
            assert cid in prompt
        assert "woks wake before the shutter [p1]" not in prompt  # the model's own reply is never echoed back
        assert "JSON only." in prompt

    def test_a_url_in_the_answer_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Read https://example.com for the menu.",
            "citations": [{"id": "p1", "title": "t"}],
            "confidence": "medium",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "url_leak"
        assert body["answer"] == ""

    def test_a_citation_outside_the_chapter_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "The answer lives elsewhere [p99].",
            "citations": [{"id": "p99", "title": "nope"}],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "unknown_citation"

    def test_a_confident_answer_without_citations_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "The regulars are already there.",
            "citations": [],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "uncited_confident_answer"

    def test_a_low_confidence_quiet_answer_with_zero_citations_is_allowed(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "The chapter does not say anything about the fare.",
            "citations": [],
            "confidence": "low",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert body["citations"] == []
        assert body["confidence"] == "low"

    def test_unparseable_model_reply_degrades(self):
        client = _client()
        canned = _CannedRouter(_resp("the woks are up"))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "non_json_reply"

    def test_a_provider_crash_degrades(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "model_unavailable"

    def test_excerpts_are_required_and_capped(self):
        client = _client()
        too_many = [{"id": f"p{i}", "kicker": "", "title": f"T{i}", "body": "b"} for i in range(61)]
        resp = client.post("/ai/v1/chapter/ask", json={
            "question": "what time?",
            "chapter_id": "hk-cha-chaan-teng-dawn",
            "chapter_title": "茶餐廳・早朝",
            "sections": too_many,
            "locale": "zh-HK",
        })
        assert resp.status_code == 422
        resp2 = client.post("/ai/v1/chapter/ask", json={
            "question": "what time?",
            "chapter_id": "hk-cha-chaan-teng-dawn",
            "chapter_title": "茶餐廳・早朝",
            "sections": [],
            "locale": "zh-HK",
        })
        assert resp2.status_code == 422
