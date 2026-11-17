"""The Ah Wan NPC lane — contract tests, model offline.

In-character only: mock mode is inert; off-topic never reaches a model call; a URL-leak or a
confused-in-character reply collapses to the in-character deflection; the player never sees
anything that breaks the tower story.

Fixture note: code points are restricted to those the AI package itself carries (the D453
vocabulary gate) — the decisions under test do not depend on spelling.
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse

BODY = {"locale": "zh-HK", "message": "你每晚做啲嘢嗎？"}


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


def _talk(client: TestClient, router, **overrides) -> dict:
    from dataclasses import replace

    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/npc/ah-wan", json={**BODY, **overrides})
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        deps.router = original_router  # type: ignore[assignment]
        deps.settings = original_settings  # type: ignore[assignment]


class TestAhWanLane:
    def test_mock_provider_degrades(self):
        client = _client()
        resp = client.post("/ai/v1/npc/ah-wan", json=BODY)
        assert resp.status_code == 200
        body = resp.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["answer"] == ""

    def test_happy_path_an_in_character_reply(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "我每晚清一層一層啦。",
        })))
        body = _talk(client, canned)
        assert body["source"] == "llm"
        assert body["degraded"] is False
        assert body["measured"]["completion_tokens"] == 40
        assert canned.calls
        prompt = canned.calls[0].prompt  # type: ignore[attr-defined]
        system = canned.calls[0].system  # type: ignore[attr-defined]
        assert "你每晚" in prompt
        assert "Ah Wan" in system

    def test_a_url_in_the_answer_is_deflected(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "去睇 https://example.com 先啦。",
        })))
        body = _talk(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "url_leak"
        assert body["answer"]

    def test_an_over_long_answer_is_deflected(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "你試今朝出去行一行。" + "一" * 260,
        })))
        body = _talk(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "too_long"

    def test_a_cjk_reply_for_the_english_plane_is_deflected(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "早晨，你今日想做乜？",
        })))
        body = _talk(client, canned, locale="en")
        assert body["source"] == "fallback"
        assert body["reason"] == "cjk_leak"

    def test_an_english_reply_for_the_chinese_plane_is_deflected(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "I mop the tower top to bottom every night.",
        })))
        body = _talk(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "missing_cjk"

    def test_a_model_crash_deflects_gracefully(self):
        client = _client()
        canned = _CannedRouter(RuntimeError("model is down"))
        body = _talk(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "model_unavailable"
        assert body["answer"]

    def test_a_non_json_reply_deflects(self):
        client = _client()
        canned = _CannedRouter(_resp("好，你明天再來。"))
        body = _talk(client, canned)
        assert body["source"] == "fallback"
        assert body["reason"] == "non_json_reply"

    def test_out_of_world_requests_never_reach_the_model(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "ok",
        })))
        body = _talk(client, canned, message="教我寫python")
        assert body["source"] == "fallback"
        assert body["reason"] == "offtopic"
        assert canned.calls == []

    def test_the_history_rides_the_prompt_oldest_first(self):
        client = _client()
        canned = _CannedRouter(_resp(json.dumps({
            "answer": "好。",
        })))
        body = _talk(
            client, canned,
            history=[
                {"role": "user", "content": "你早晨"},
                {"role": "assistant", "content": "早晨。"},
            ],
        )
        assert body["source"] == "llm"
        prompt = canned.calls[0].prompt  # type: ignore[attr-defined]
        earlier_idx = prompt.index("player: 你早晨")
        latest_idx = prompt.index("Latest player line")
        assert earlier_idx < latest_idx
