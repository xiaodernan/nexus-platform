"""The grounded handbook ask lane — contract tests, model offline.

Every assertion was confirmed against the running app with `NEXUS_LLM_PROVIDER=mock`
(conftest), so the provider never answers; the router is then replaced on the fly with
canned adapters that behave like (a) a well-grounded model, (b) a model that leaks a URL,
(c) a model that invents citations outside the corpus, (d) a model that answers without
citing anything while claiming high confidence, (e) an empty/garbage reply. The point of
each exception pin: failure is UNANSWERABLE, always — the web lane keeps its deterministic
floor (§105).
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

SECTIONS = [
    {"id": "search", "kicker": "SEARCH", "title": "SearchBox",
     "body": "type one sentence; the SearchBox parses districts"},
    {"id": "concierge", "kicker": "TOOL", "title": "Concierge ask",
     "body": "?ask=<question> renders the manual's own excerpt"},
    {"id": "daily", "kicker": "DAILY", "title": "Daily ritual",
     "body": "each day the almanac reads a seeded pattern"},
]


def _client() -> TestClient:
    return TestClient(A.create_app())


class _CannedRouter:
    """Stand-in for the model router: respond deterministically from canned adapter logic."""

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


def _ask(client: TestClient, router, question: str = "how do I search?", sections=None) -> dict:
    from dataclasses import replace

    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/handbook/ask", json={
            "question": question,
            "sections": sections if sections is not None else SECTIONS,
            "locale": "en",
        })
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        deps.router = original_router  # type: ignore[assignment]
        deps.settings = original_settings  # type: ignore[assignment]


class TestGroundedLane:
    def test_mock_provider_degrades(self):
        client = _client()
        resp = client.post("/ai/v1/handbook/ask", json={
            "question": "how do I search?", "sections": SECTIONS, "locale": "en",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["answer"] == ""
        assert body["citations"] == []

    def test_a_well_grounded_model_phrase_comes_through(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Type one sentence into the SearchBox; the parser reads districts and intent. [search]",
            "citations": [{"id": "search", "title": "SearchBox"}],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert body["answer"].startswith("Type one sentence")
        assert body["citations"] == [{"id": "search", "title": "SearchBox"}]
        assert body["confidence"] == "high"
        assert body["measured"]["prompt_tokens"] == 120
        assert body["measured"]["cached_tokens"] == 0

    def test_url_leak_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "See https://example.com for the manual",
            "citations": [{"id": "search", "title": "SearchBox"}],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "url_leak"
        assert body["answer"] == ""

    def test_a_citation_outside_the_corpus_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Do the thing described in [elsewhere]",
            "citations": [{"id": "elsewhere", "title": "nope"}],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "unknown_citation"

    def test_a_confident_answer_without_citations_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Do the thing described in the manual",
            "citations": [],
            "confidence": "high",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "uncited_confident_answer"

    def test_a_low_confidence_quiet_answer_with_zero_citations_is_allowed(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "The manual does not say anything about getting merchants to refund.",
            "citations": [],
            "confidence": "low",
        })))
        body = _ask(client, canned)
        assert body["degraded"] is False
        assert body["citations"] == []
        assert body["confidence"] == "low"

    def test_unparseable_model_reply_degrades(self):
        client = _client()
        canned = _CannedRouter(_resp("not json"))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "non_json_reply"

    def test_empty_model_reply_degrades(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({"answer": "", "citations": [], "confidence": "low"})))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "empty_answer"

    def test_a_provider_crash_degrades(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _ask(client, canned)
        assert body["degraded"] is True
        assert body["reason"] == "model_unavailable"

    def test_sections_are_required_and_capped(self):
        client = _client()
        too_many = [{"id": f"s{i}", "kicker": "", "title": f"T{i}", "body": "b"} for i in range(9)]
        resp = client.post("/ai/v1/handbook/ask", json={
            "question": "how do I search?", "sections": too_many, "locale": "en",
        })
        assert resp.status_code == 422
        resp2 = client.post("/ai/v1/handbook/ask", json={
            "question": "how do I search?", "sections": [], "locale": "en",
        })
        assert resp2.status_code == 422
