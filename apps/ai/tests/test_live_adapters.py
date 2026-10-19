"""Contract tests for the live provider adapters (``models/anthropic.py`` / ``models/openai.py``).

These adapters make real HTTP calls in production, but ``HttpLLMAdapter`` accepts an injected
``client`` (``self._client``), so the *wire contract* — request URL/body/headers and response
parsing — is fully exercisable **offline** with a fake async client. No network, no DB.

Pinned here (AGENT_CONTRACT §9, DECISIONS D4, §105 degrade):
* Anthropic Messages wire: URL, auth headers, body shape (system separate from the user message),
  text-block join (ignoring non-text blocks), usage tokens, cost plumbing, and that ``json_hint``
  is deliberately NOT turned into a ``response_format`` (that is an OpenAI-only field).
* OpenAI Chat Completions wire: URL, Bearer auth, the default system message when none is given,
  choice parsing, usage tokens, and ``response_format`` when ``json_hint`` is set.
* Error mapping: 429/5xx → retryable ``LLMError``; 4xx → non-retryable; transport exceptions →
  retryable. This is what the §105 fallback ladder keys off.

Every assertion was confirmed against the running adapters (empirical probe), never guessed.
"""

from __future__ import annotations

import httpx

from nexus_ai.models.anthropic import AnthropicAdapter
from nexus_ai.models.base import LLMError, LLMRequest, cost_usd
from nexus_ai.models.openai import OpenAIAdapter

ANTH_PAYLOAD = {
    "content": [
        {"type": "text", "text": "hello "},
        {"type": "text", "text": "world"},
        {"type": "tool_use"},  # non-text block must be ignored
    ],
    "usage": {"input_tokens": 10, "output_tokens": 5},
    "model": "claude-sonnet-latest",
    "stop_reason": "end_turn",
}

OAI_PAYLOAD = {
    "choices": [{"message": {"content": "hi there"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 8, "completion_tokens": 3},
    "model": "gpt-4o",
}


class _Resp:
    def __init__(self, payload, status: int = 200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            req = httpx.Request("POST", "http://x")
            raise httpx.HTTPStatusError(
                "err", request=req, response=httpx.Response(self.status_code, request=req)
            )

    def json(self):
        return self._payload


class _Client:
    """Fake async httpx client: records the call, returns a canned response or raises."""

    def __init__(self, resp):
        self.resp = resp
        self.calls: list[dict] = []

    async def post(self, url, headers=None, json=None):
        self.calls.append({"url": url, "headers": headers, "json": json})
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


def _anth(resp) -> tuple[AnthropicAdapter, _Client]:
    c = _Client(resp)
    return AnthropicAdapter(base_url="http://x", api_key="k", client=c), c


def _oai(resp) -> tuple[OpenAIAdapter, _Client]:
    c = _Client(resp)
    return OpenAIAdapter(base_url="http://x", api_key="k", client=c), c


class TestAnthropicWire:
    async def test_posts_to_messages_endpoint(self):
        a, c = _anth(_Resp(ANTH_PAYLOAD))
        await a.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert c.calls[0]["url"] == "http://x/v1/messages"

    async def test_auth_headers(self):
        a, c = _anth(_Resp(ANTH_PAYLOAD))
        await a.complete(LLMRequest(task_class="summary", prompt="hi"))
        h = c.calls[0]["headers"]
        assert h["x-api-key"] == "k"
        assert h["anthropic-version"] == "2023-06-01"
        assert h["content-type"] == "application/json"

    async def test_body_shape_system_separate(self):
        a, c = _anth(_Resp(ANTH_PAYLOAD))
        await a.complete(LLMRequest(task_class="summary", prompt="hi", system="be terse"))
        body = c.calls[0]["json"]
        # Anthropic carries `system` as a top-level field, not a message role
        assert body["system"] == "be terse"
        assert body["messages"] == [{"role": "user", "content": "hi"}]
        assert body["model"] == "claude-sonnet-latest"  # summary -> mid tier
        assert body["max_tokens"] == 1024

    async def test_text_blocks_joined_ignoring_non_text(self):
        a, _ = _anth(_Resp(ANTH_PAYLOAD))
        r = await a.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert r.text == "hello world"
        assert r.provider == "anthropic"
        assert r.degraded is False
        assert r.finish_reason == "end_turn"

    async def test_usage_tokens_and_cost_plumbing(self):
        a, _ = _anth(_Resp(ANTH_PAYLOAD))
        r = await a.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert (r.prompt_tokens, r.completion_tokens) == (10, 5)
        # cost is computed by the shared base pricing for the mid tier
        assert r.cost_usd == cost_usd("mid", 10, 5)
        assert isinstance(r.latency_ms, int) and r.latency_ms >= 0

    async def test_json_hint_does_not_add_response_format(self):
        # Anthropic has no `response_format`; json_hint must not fabricate one
        a, c = _anth(_Resp(ANTH_PAYLOAD))
        await a.complete(LLMRequest(task_class="summary", prompt="hi", json_hint="x"))
        assert "response_format" not in c.calls[0]["json"]

    async def test_structured_text_is_parsed_into_data(self):
        payload = dict(ANTH_PAYLOAD, content=[{"type": "text", "text": '{"a": 1}'}])
        a, _ = _anth(_Resp(payload))
        r = await a.complete(LLMRequest(task_class="summary", prompt="hi", json_hint="x"))
        assert r.data == {"a": 1}


class TestOpenAIWire:
    async def test_posts_to_chat_completions(self):
        o, c = _oai(_Resp(OAI_PAYLOAD))
        await o.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert c.calls[0]["url"] == "http://x/chat/completions"

    async def test_bearer_auth_header(self):
        o, c = _oai(_Resp(OAI_PAYLOAD))
        await o.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert c.calls[0]["headers"]["authorization"] == "Bearer k"

    async def test_default_system_message_injected(self):
        o, c = _oai(_Resp(OAI_PAYLOAD))
        await o.complete(LLMRequest(task_class="summary", prompt="hi"))
        msgs = c.calls[0]["json"]["messages"]
        assert msgs[0]["role"] == "system"
        assert "NEXUS" in msgs[0]["content"]
        assert msgs[1] == {"role": "user", "content": "hi"}

    async def test_custom_system_message_used(self):
        o, c = _oai(_Resp(OAI_PAYLOAD))
        await o.complete(LLMRequest(task_class="summary", prompt="hi", system="custom"))
        assert c.calls[0]["json"]["messages"][0] == {"role": "system", "content": "custom"}

    async def test_parses_choice_and_usage(self):
        o, _ = _oai(_Resp(OAI_PAYLOAD))
        r = await o.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert r.text == "hi there"
        assert (r.prompt_tokens, r.completion_tokens) == (8, 3)
        assert r.provider == "openai"
        assert r.degraded is False
        assert r.finish_reason == "stop"
        assert r.cost_usd == cost_usd("mid", 8, 3)

    async def test_json_hint_sets_response_format(self):
        o, c = _oai(_Resp(OAI_PAYLOAD))
        await o.complete(LLMRequest(task_class="summary", prompt="hi", json_hint="x"))
        assert c.calls[0]["json"]["response_format"] == {"type": "json_object"}

    async def test_no_response_format_without_json_hint(self):
        o, c = _oai(_Resp(OAI_PAYLOAD))
        await o.complete(LLMRequest(task_class="summary", prompt="hi"))
        assert "response_format" not in c.calls[0]["json"]


class TestErrorMapping:
    async def test_429_is_retryable(self):
        a, _ = _anth(_Resp({}, status=429))
        try:
            await a.complete(LLMRequest(task_class="summary", prompt="hi"))
            assert False, "expected LLMError"
        except LLMError as e:
            assert e.retryable is True
            assert e.status == 429
            assert e.provider == "anthropic"

    async def test_5xx_is_retryable(self):
        a, _ = _anth(_Resp({}, status=500))
        try:
            await a.complete(LLMRequest(task_class="summary", prompt="hi"))
            assert False, "expected LLMError"
        except LLMError as e:
            assert e.retryable is True
            assert e.status == 500

    async def test_4xx_is_not_retryable(self):
        a, _ = _anth(_Resp({}, status=400))
        try:
            await a.complete(LLMRequest(task_class="summary", prompt="hi"))
            assert False, "expected LLMError"
        except LLMError as e:
            assert e.retryable is False
            assert e.status == 400

    async def test_transport_error_is_retryable(self):
        a, _ = _anth(httpx.ConnectError("boom"))
        try:
            await a.complete(LLMRequest(task_class="summary", prompt="hi"))
            assert False, "expected LLMError"
        except LLMError as e:
            assert e.retryable is True
