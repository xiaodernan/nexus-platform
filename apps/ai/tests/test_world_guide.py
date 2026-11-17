"""The world-guide lane — contract tests, model offline.

Every failure collapses to the deterministic fallback template (the traveler is never blocked);
mock mode is inert; the model may pick between the two curated doors and explain why, nothing
else; the suggestion list always comes from the deterministic selection.

Fixture note: the vocabulary gate (test_vocabulary_is_the_reference) only honours characters the
AI package itself carries, plus its declared list — so Chinese fixture words here are built from
those code points (先去夜碼頭, all known to the package). The decisions under test are locale,
not spelling.
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

CANDIDATES = [
    {"slug": "hk-food-chronicle", "title": "Dawn at the cha caan teng", "blurb": "half six in the morning, one boiled egg and toast"},
    {"slug": "hk-siu-mei-chronicle", "title": "Siu mei — two in the morning", "blurb": "the siu mei masters guard the fire past midnight"},
    {"slug": "hk-dim-sum-chronicle", "title": "Yum cha — the bamboo baskets", "blurb": "tea on the ferry, then three bamboo steamers"},
]

BODY = {
    "locale": "zh-HK",
    "surface": "chapter",
    "current_title": "Dawn at the cha caan teng",
    "minutes": 45,
    "candidates": CANDIDATES,
}

#: A few code points the AI package carries — used only where a CJK-only fixture is required.
CJK_SPARSE = "先去夜碼頭"


def _client() -> TestClient:
    return TestClient(A.create_app())


class _CannedRouter:
    def __init__(self, reply) -> None:
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


def _guide(client: TestClient, router, **overrides) -> dict:
    from dataclasses import replace

    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/world/guide", json={**BODY, **overrides})
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        deps.router = original_router  # type: ignore[assignment]
        deps.settings = original_settings  # type: ignore[assignment]


class TestWorldGuideLane:
    def test_mock_provider_degrades(self):
        client = _client()
        resp = client.post("/ai/v1/world/guide", json=BODY)
        assert resp.status_code == 200
        body = resp.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["answer"] == ""
        assert body["suggestions"] == []

    def test_happy_path_model_phrases_and_picks(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": f"{CJK_SPARSE}。",
            "pick": 2,
        })))
        body = _guide(client, canned)
        assert body["source"] == "llm"
        assert body["degraded"] is False
        assert body["pick"] == 2
        assert [s["slug"] for s in body["suggestions"]] == ["hk-siu-mei-chronicle", "hk-food-chronicle"]
        assert body["measured"]["completion_tokens"] == 40
        assert canned.calls
        prompt = canned.calls[0].prompt  # type: ignore[attr-defined]
        assert "hk-food-chronicle" not in prompt  # slugs are never handed to the model — titles are
        assert "Dawn at the cha caan teng" in prompt
        assert "two in the morning" in prompt

    def test_a_url_in_the_answer_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": f"{CJK_SPARSE} https://example.com",
            "pick": 1,
        })))
        body = _guide(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "url_leak"

    def test_a_cjk_answer_for_the_english_plane_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": f"{CJK_SPARSE}。",
            "pick": 1,
        })))
        body = _guide(client, canned, locale="en")
        assert body["source"] == "fallback"
        assert body["reason"] == "cjk_leak"

    def test_an_english_only_answer_for_the_chinese_plane_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Head to the siu mei stall first.",
            "pick": 1,
        })))
        body = _guide(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "missing_cjk"

    def test_an_overlong_answer_is_refused(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": f"{CJK_SPARSE}。" + "一" * 500,
            "pick": 1,
        })))
        body = _guide(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "too_long"

    def test_a_model_crash_degrades_to_the_template(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _guide(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "model_unavailable"
        assert body["answer"]  # the traveler still gets a compass

    def test_a_non_json_reply_degrades_to_the_template(self):
        client = _client()
        canned = _CannedRouter(_resp("先去夜碼頭"))
        body = _guide(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "non_json_reply"

    def test_a_broken_fence_never_loses_the_doors(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _guide(client, canned)
        assert [s["slug"] for s in body["suggestions"]]
        assert len(body["suggestions"]) == 2

    def test_intent_classifies_the_situation(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": f"{CJK_SPARSE}。",
            "pick": 1,
        })))
        assert _guide(client, canned, surface="home", current_title="", minutes=60)["intent"] == "settle"
        assert _guide(client, canned, surface="chapter", current_title="", minutes=60)["intent"] == "explore"
        assert _guide(client, canned, surface="chapter", current_title="Dawn at the cha caan teng", minutes=60)["intent"] == "deepen"
        assert _guide(client, canned, surface="guides", current_title="", minutes=10)["intent"] == "snack"

    def test_a_pick_outside_the_doors_is_ignored_not_invented(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": f"{CJK_SPARSE}。",
            "pick": 7,
        })))
        body = _guide(client, canned)
        assert body["source"] == "llm"
        assert "pick" not in body
        assert [s["slug"] for s in body["suggestions"]] == ["hk-food-chronicle", "hk-siu-mei-chronicle"]

    def test_the_candidate_fence_holds(self):
        client = _client()
        too_many = [{"slug": f"s{i}", "title": f"t{i}", "blurb": ""} for i in range(7)]
        resp = client.post("/ai/v1/world/guide", json={**BODY, "candidates": too_many})
        assert resp.status_code == 422
        resp2 = client.post("/ai/v1/world/guide", json={**BODY, "candidates": []})
        assert resp2.status_code == 422

    def test_en_locale_happy_path(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "Start with the siu mei chapter — it keeps flying after the last page of the noodle fire.",
            "pick": 2,
        })))
        body = _guide(client, canned, locale="en")
        assert body["source"] == "llm"
        assert [s["slug"] for s in body["suggestions"]] == ["hk-siu-mei-chronicle", "hk-food-chronicle"]
        assert body["locale"] == "en"
