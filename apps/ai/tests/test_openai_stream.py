"""D1044 — SSE envelope is the default `complete()` transport; the §1 contract is untouched.

The adapter still returns one complete `LLMResponse` to callers. These tests pin (a) the
default request body carries `stream` + `stream_options.include_usage`, (b) an explicit
`NEXUS_LLM_STREAM=false` restores the direct JSON shape, (c) `_reassemble_sse` assembles
content, usage, finish_reason and model from an unordered-line stream.
"""

from __future__ import annotations

import json

import pytest

from nexus_ai.models.base import LLMRequest, LLMResponse
from nexus_ai.models.openai import OpenAIAdapter


class _FakeResponse:
    def __init__(self, *, text: str | None = None, json_body: dict | None = None):
        self.text = text or ""
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


def _sse_body(pieces: list[str], finish: str = "stop",
              usage: dict | None = None) -> str:
    lines = []
    for piece in pieces:
        lines.append("data: " + json.dumps(
            {"id": "chatcmpl-x", "model": "gpt-6-sol",
             "choices": [{"index": 0, "delta": {"content": piece},
                          "finish_reason": None}]}))
    lines.append("data: " + json.dumps(
        {"id": "chatcmpl-x", "model": "gpt-6-sol",
         "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}))
    if usage is not None:
        lines.append("data: " + json.dumps(
            {"id": "chatcmpl-x", "model": "gpt-6-sol", "choices": [],
             "usage": usage}))
    lines.append("data: [DONE]")
    return "\n\n".join(lines) + "\n\n"


_USAGE = {"prompt_tokens": 100, "completion_tokens": 30,
          "prompt_tokens_details": {"cached_tokens": 80}}


@pytest.mark.asyncio
async def test_stream_envelope_is_the_default(monkeypatch):
    monkeypatch.delenv("NEXUS_LLM_STREAM", raising=False)
    client = _FakeClient(_FakeResponse(text=_sse_body(["hello"], usage=_USAGE)))
    adapter = _adapter(client)
    await adapter.complete(LLMRequest(task_class="summary", system="s",
                                      payload={"records": []}))
    assert client.last_body["stream"] is True
    assert client.last_body["stream_options"] == {"include_usage": True}


@pytest.mark.asyncio
async def test_explicit_false_restores_direct_json(monkeypatch):
    monkeypatch.setenv("NEXUS_LLM_STREAM", "false")
    client = _FakeClient(_FakeResponse(json_body={
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
        "model": "gpt-6-sol",
        "usage": {"prompt_tokens": 10, "completion_tokens": 5,
                  "prompt_tokens_details": {"cached_tokens": 7}}}))
    adapter = _adapter(client)
    resp = await adapter.complete(LLMRequest(task_class="summary", system="s",
                                             payload={"records": []}))
    assert "stream" not in client.last_body
    assert client.last_body.get("stream_options") is None
    assert resp.text == "hi"
    assert resp.cached_tokens == 7 and resp.prompt_tokens == 10


@pytest.mark.asyncio
async def test_sse_envelope_end_to_end_content_and_usage(monkeypatch):
    monkeypatch.delenv("NEXUS_LLM_STREAM", raising=False)
    body = _sse_body(["找到 ", "2 個", "選擇"], usage=_USAGE)
    client = _FakeClient(_FakeResponse(text=body))
    adapter = _adapter(client)
    resp = await adapter.complete(LLMRequest(task_class="summary", system="s",
                                             payload={"records": []}))
    assert isinstance(resp, LLMResponse)
    assert resp.text == "找到 2 個選擇"
    assert resp.provider == "openai" and resp.degraded is False
    assert resp.prompt_tokens == 100 and resp.completion_tokens == 30
    assert resp.cached_tokens == 80 and resp.cache_hit is True
    assert resp.model == "gpt-6-sol"


def test_reassemble_sse_skips_noise_and_keeps_order():
    body = (
        ": ping\n\n"
        "data: {\"model\":\"m-x\",\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n"
        "event: something-else\n\n"
        "data: not-json-at-all\n\n"
        "data: {\"model\":\"m-x\",\"choices\":[{\"delta\":{\"content\":\"b\"},\"finish_reason\":\"length\"}]}\n\n"
        "data: {\"model\":\"m-y\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n"
        "data: [DONE]\n\n"
    )
    text, finish, usage, model = OpenAIAdapter._reassemble_sse(body, "fallback-model")
    assert text == "ab"
    assert finish == "length"
    assert usage["prompt_tokens"] == 3
    assert model == "m-y"


def test_reassemble_sse_empty_body():
    text, finish, usage, model = OpenAIAdapter._reassemble_sse("", "fb")
    assert text == "" and finish == "stop" and usage == {} and model == "fb"
