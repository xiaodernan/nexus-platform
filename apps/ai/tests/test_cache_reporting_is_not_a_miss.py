"""D1052 — "the provider did not report cache accounting" is not "nothing was cached".

Measured on the operator's proxy (wkapi.pro / gpt-6-sol, 2026-11-13), eight byte-identical
requests: `prompt_tokens=4529` every time, `cached_tokens=4352` on five of them, and no
`prompt_tokens_details` at all on the other three. The ledger persisted those three as
`cached_tokens=0`, so the console divided 5x4352 by 8x4529 and reported 60% — the operator's
"the cache hit rate is far too low". The cache was fine; the accounting was not.

These arms pin the distinction at the adapter (both transports) and at the ledger row, so a
future refactor cannot silently collapse the two states again.
"""

from __future__ import annotations

import json

import pytest

from nexus_ai.models.base import LLMRequest
from nexus_ai.models.openai import OpenAIAdapter
from nexus_ai.models.router import RoutedCall


class _FakeResponse:
    def __init__(self, *, text: str = "", json_body: dict | None = None):
        self.text = text
        self._json_body = json_body or {}
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self._json_body


class _FakeClient:
    def __init__(self, response: _FakeResponse):
        self._response = response
        self.last_body: dict | None = None

    async def post(self, url, headers=None, json=None):
        self.last_body = json
        return self._response


def _adapter(client: _FakeClient) -> OpenAIAdapter:
    return OpenAIAdapter(base_url="https://proxy.example/v1", api_key="sk-test",
                         models={"cheap": "m", "mid": "gpt-6-sol", "reason": "m"},
                         client=client)


def _sse(usage: dict | None, text: str = "ok") -> str:
    lines = [
        "data: " + json.dumps({"model": "gpt-6-sol",
                               "choices": [{"index": 0, "delta": {"content": text},
                                            "finish_reason": None}]}),
        "data: " + json.dumps({"model": "gpt-6-sol",
                               "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
    ]
    if usage is not None:
        lines.append("data: " + json.dumps({"model": "gpt-6-sol", "choices": [], "usage": usage}))
    lines.append("data: [DONE]")
    return "\n\n".join(lines) + "\n\n"


async def _complete(monkeypatch, usage_in_body: dict | None, *, stream: bool):
    monkeypatch.setenv("NEXUS_LLM_STREAM", "true" if stream else "false")
    usage = {} if usage_in_body is None else usage_in_body
    if stream:
        client = _FakeClient(_FakeResponse(text=_sse(usage_in_body if usage_in_body else None)))
    else:
        client = _FakeClient(_FakeResponse(json_body={
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "model": "gpt-6-sol",
            "usage": usage,
        }))
    adapter = _adapter(client)
    return await adapter.complete(LLMRequest(task_class="summary", system="s",
                                             payload={"records": []}))


@pytest.mark.asyncio
async def test_a_provider_that_reports_cached_tokens_is_marked_reported(monkeypatch):
    resp = await _complete(monkeypatch,
                           {"prompt_tokens": 100, "completion_tokens": 10,
                            "prompt_tokens_details": {"cached_tokens": 80}}, stream=True)
    assert resp.cached_tokens == 80
    assert resp.cache_reported is True
    assert resp.cache_hit is True


@pytest.mark.asyncio
async def test_a_provider_that_reports_zero_is_reported_and_is_a_real_miss(monkeypatch):
    resp = await _complete(monkeypatch,
                           {"prompt_tokens": 100, "completion_tokens": 10,
                            "prompt_tokens_details": {"cached_tokens": 0}}, stream=True)
    assert resp.cached_tokens == 0
    # It answered the question. Zero is a measurement, not a silence.
    assert resp.cache_reported is True
    assert resp.cache_hit is False


@pytest.mark.asyncio
async def test_a_provider_that_omits_the_detail_is_not_a_miss(monkeypatch):
    resp = await _complete(monkeypatch, {"prompt_tokens": 100, "completion_tokens": 10},
                           stream=True)
    assert resp.cached_tokens == 0
    assert resp.cache_reported is False  # the whole point: silence, not zero


@pytest.mark.asyncio
async def test_a_usage_less_stream_is_not_a_miss(monkeypatch):
    resp = await _complete(monkeypatch, None, stream=True)
    assert resp.cache_reported is False


@pytest.mark.asyncio
async def test_the_direct_json_transport_agrees_with_the_sse_transport(monkeypatch):
    reported = await _complete(monkeypatch,
                              {"prompt_tokens": 10, "completion_tokens": 5,
                               "prompt_tokens_details": {"cached_tokens": 7}}, stream=False)
    silent = await _complete(monkeypatch, {"prompt_tokens": 10, "completion_tokens": 5},
                             stream=False)
    assert (reported.cached_tokens, reported.cache_reported) == (7, True)
    assert (silent.cached_tokens, silent.cache_reported) == (0, False)


@pytest.mark.asyncio
async def test_the_ledger_row_carries_the_reporting_fact(monkeypatch):
    silent = await _complete(monkeypatch, {"prompt_tokens": 100, "completion_tokens": 10},
                             stream=False)
    row = RoutedCall(response=silent, task_class="summary").as_llm_call_row("run-1")
    assert row["cached_tokens"] == 0
    assert row["cache_reported"] is False

    reported = await _complete(monkeypatch,
                               {"prompt_tokens": 100, "completion_tokens": 10,
                                "prompt_tokens_details": {"cached_tokens": 90}}, stream=False)
    row = RoutedCall(response=reported, task_class="summary").as_llm_call_row("run-1")
    assert row["cached_tokens"] == 90
    assert row["cache_reported"] is True


def test_the_migration_declares_the_column_nullable_free_and_defaulted():
    from pathlib import Path

    sql = Path(__file__).resolve().parents[3] / "infra" / "db" / "migrations" / \
        "V14__llm_calls_cache_reported.sql"
    text = sql.read_text(encoding="utf-8")
    assert "ADD COLUMN IF NOT EXISTS cache_reported boolean NOT NULL DEFAULT false" in text
    # additive only: no UPDATE, no DROP, no rewrite of an existing column
    lowered = text.lower()
    for forbidden in ("update llm_calls", "drop column", "alter column", "truncate"):
        assert forbidden not in lowered, forbidden
