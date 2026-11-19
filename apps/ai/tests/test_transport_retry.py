"""D1313 — the transport retry: the relay/Clash node flaps mid-burst (measured).

Connect-level failures never reach the application, so a retry cannot double-bill a
completion — but an exhausted retry must raise, never silently return an empty success.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from nexus_ai.models.base import LLMError, LLMRequest
from nexus_ai.models.openai import OpenAIAdapter


def _req() -> LLMRequest:
    return LLMRequest(
        task_class="summary",
        payload={},
        system="s",
        prompt="p",
        max_tokens=8,
        temperature=0.0,
        json_hint=None,
    )


class _FakeClient:
    """A client whose POST plays a scripted list: exceptions or (status, json) pairs."""

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.calls = 0

    async def post(self, url, headers=None, json=None):
        self.calls += 1
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        status, payload = item
        request = httpx.Request("POST", url)
        return httpx.Response(status, request=request, json=payload)

    async def aclose(self):
        return None


def _adapter(monkeypatch, script):
    fake = _FakeClient(script)
    adapter = OpenAIAdapter(
        base_url="https://api.aizzz.xyz/v1",
        api_key="sk-fake",
        models={"cheap": "gpt-6.2-sol", "mid": "gpt-6.2-sol", "reason": "gpt-6.2-sol"},
        timeout_s=1.0,
    )
    monkeypatch.setattr(adapter, "_http", lambda: fake)
    return adapter, fake


class TestTransportRetry:
    def test_retry_rescues_two_flaps_then_succeeds(self, monkeypatch):
        ok = {
            "choices": [{"message": {"content": "ok", "finish_reason": "stop"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            "model": "gpt-6.2-sol",
        }
        adapter, fake = _adapter(
            monkeypatch,
            [httpx.ConnectError("tls eof"), httpx.ConnectError("tls eof"), (200, ok)],
        )
        resp = asyncio.run(adapter.complete(_req()))
        assert resp.text == "ok"
        assert fake.calls == 3

    def test_three_flaps_raise_never_silent_success(self, monkeypatch):
        adapter, fake = _adapter(
            monkeypatch,
            [httpx.ConnectError("tls eof"), httpx.ConnectTimeout("timeout"), httpx.ReadError("reset")],
        )
        with pytest.raises(LLMError) as caught:
            asyncio.run(adapter.complete(_req()))
        assert fake.calls == 3
        assert "transport error" in str(caught.value).lower()

    def test_http_status_errors_are_not_retried(self, monkeypatch):
        adapter, fake = _adapter(
            monkeypatch,
            [(429, {"error": {"message": "slow down"}})],
        )
        with pytest.raises(LLMError) as caught:
            asyncio.run(adapter.complete(_req()))
        assert fake.calls == 1
        assert caught.value.status == 429
