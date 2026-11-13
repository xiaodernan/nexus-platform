"""D1047 — the opt-in Redis replay cache: byte-identical temperature-0 requests replay free.

The provider prefix cache (D1036+) saves recompute; this cache saves the round trip itself —
a stored completion for the exact byte-shape is returned with zero tokens and cache_hit=True.
Gates: opt-in env, temperature 0 only, no `reason` task, chain-signature in the key, any
Redis failure degrades to a plain miss.
"""

from __future__ import annotations

import pytest

import nexus_ai.api.llm_response_cache as cache
from nexus_ai.models.base import TASK_MODEL_DEFAULTS, LLMRequest, LLMResponse
from nexus_ai.models.router import CostMeter, ModelRouter


class _FakeAdapter:
    name = "fake"

    def __init__(self, text: str = "hello"):
        self.calls = 0
        self._text = text

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls += 1
        meta = TASK_MODEL_DEFAULTS[req.task_class]
        return LLMResponse(
            text=self._text, provider=self.name, model="fake-1",
            task_class=req.task_class, purpose=meta["purpose"],
            prompt_tokens=10, completion_tokens=5, cost_usd=0.001,
            latency_ms=3, degraded=False, cache_hit=False,
            finish_reason="stop", usage_flagged=False, cached_tokens=0,
        )


class _FakeRedis:
    """Minimal dict-backed stand-in with the two methods the cache uses."""

    def __init__(self, *, fail: bool = False):
        self.store: dict[str, str] = {}
        self.fail = fail

    def ping(self):
        if self.fail:
            raise ConnectionError("redis down")
        return True

    def get(self, key):
        if self.fail:
            raise ConnectionError("redis down")
        return self.store.get(key)

    def set(self, key, value, ex=None):
        if self.fail:
            raise ConnectionError("redis down")
        self.store[key] = value
        return True


@pytest.fixture(autouse=True)
def _clean_cache_state(monkeypatch):
    monkeypatch.delenv("NEXUS_LLM_RESPONSE_CACHE", raising=False)
    monkeypatch.delenv("NEXUS_LLM_RESPONSE_CACHE_TTL_S", raising=False)
    cache.reset_for_tests()
    yield
    cache.reset_for_tests()


def _req(**kwargs) -> LLMRequest:
    payload = {"records": []}
    temperature = kwargs.pop("temperature", 0.0)
    return LLMRequest(task_class=kwargs.pop("task_class", "summary"), system="s",
                      payload=payload, temperature=temperature, **kwargs)


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("NEXUS_LLM_RESPONSE_CACHE", raising=False)
    assert cache._client() is None
    assert cache.llm_cache_get(_req(), ("fake",)) is None
    assert cache.llm_cache_set(_req(), ("fake",), _resp()) is False


def _resp() -> LLMResponse:
    return LLMResponse(text="cached answer", provider="fake", model="fake-1",
                       task_class="summary", purpose="summary",
                       prompt_tokens=10, completion_tokens=5, cost_usd=0.001,
                       latency_ms=3, degraded=False, cache_hit=False,
                       finish_reason="stop")


def test_temperature_nonzero_never_caches(monkeypatch):
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", _FakeRedis())
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    assert cache.llm_cache_set(_req(temperature=0.5), ("fake",), _resp()) is False


def test_reason_task_never_caches(monkeypatch):
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", _FakeRedis())
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    assert cache.llm_cache_set(_req(task_class="reason"), ("fake",), _resp()) is False


def test_roundtrip_zero_tokens_cache_hit(monkeypatch):
    client = _FakeRedis()
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", client)
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    req = _req(subject_id="s-1")
    assert cache.llm_cache_set(req, ("fake",), _resp()) is True
    replayed = cache.llm_cache_get(req, ("fake",))
    assert replayed is not None
    assert replayed.text == "cached answer"
    assert replayed.prompt_tokens == 0 and replayed.completion_tokens == 0
    assert replayed.cost_usd == 0.0 and replayed.cache_hit is True
    assert replayed.provider == "fake" and replayed.finish_reason == "stop"


def test_key_covers_chain_and_subject(monkeypatch):
    client = _FakeRedis()
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", client)
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    req = _req()
    cache.llm_cache_set(req, ("openai", "mock"), _resp())
    assert cache.llm_cache_get(req, ("mock", "openai")) is None
    assert cache.llm_cache_get(_req(subject_id="other"), ("openai", "mock")) is None
    assert cache.llm_cache_get(req, ("openai", "mock")) is not None


def test_redis_failure_degrades_to_miss(monkeypatch):
    client = _FakeRedis(fail=True)
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", client)
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    assert cache.llm_cache_get(_req(), ("fake",)) is None
    assert cache.llm_cache_set(_req(), ("fake",), _resp()) is False


@pytest.mark.asyncio
async def test_router_replays_identical_request(monkeypatch):
    client = _FakeRedis()
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", client)
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    adapter = _FakeAdapter("the answer")
    router = ModelRouter([adapter])
    meter = CostMeter()
    req = _req()
    first = await router.run(req, meter=meter)
    second = await router.run(req, meter=meter)
    assert adapter.calls == 1
    assert first.response.text == "the answer"
    assert second.response.text == "the answer"
    assert second.response.cache_hit is True
    assert meter.llm_calls == 2 and meter.cost_usd == pytest.approx(0.001)
    assert [r.response.cache_hit for r in meter.records] == [False, True]


@pytest.mark.asyncio
async def test_router_lives_with_cache_down(monkeypatch):
    client = _FakeRedis()
    monkeypatch.setenv("NEXUS_LLM_RESPONSE_CACHE", "redis")
    monkeypatch.setattr(cache, "_CLIENT", client)
    monkeypatch.setattr(cache, "_CLIENT_TRIED", True)
    adapter = _FakeAdapter("down cache, live model")
    router = ModelRouter([adapter])
    meter = CostMeter()
    req = _req()
    first = await router.run(req, meter=meter)
    # the cache that only worked a second ago is gone; the model path must not care
    monkeypatch.setattr(cache, "_CLIENT", _FakeRedis(fail=True))
    second = await router.run(req, meter=meter)
    assert first.response.text == second.response.text
    assert adapter.calls == 2
    assert second.response.cache_hit is False
