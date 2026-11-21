"""D1499 — deterministic in-process replay: the provider's 1-in-6 cache flicker cannot
reach a reader. Same key/body as the Redis arm; bounded, TTL'd, offline by default."""

from __future__ import annotations

import pytest

import nexus_ai.api.llm_response_cache as cache
from nexus_ai.models.base import TASK_MODEL_DEFAULTS, LLMRequest, LLMResponse


def _req(**kw):
    kw.setdefault("task_class", "summary")
    kw.setdefault("system", "s")
    kw.setdefault("payload", {"query": "hello"})
    kw.setdefault("temperature", 0.0)
    return LLMRequest(**kw)


def _resp(text="answer"):
    return LLMResponse(
        text=text, provider="fake", model="fake-1", task_class="summary",
        purpose=TASK_MODEL_DEFAULTS["summary"]["purpose"],
        prompt_tokens=42, completion_tokens=7, cost_usd=0.002,
        latency_ms=10, degraded=False, finish_reason="stop",
        cache_hit=False, cached_tokens=0,
    )


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("NEXUS_LLM_RESPONSE_CACHE", raising=False)
    cache.reset_client()
    yield
    cache.reset_client()


def test_local_replay_is_deterministic_without_redis(monkeypatch):
    monkeypatch.setattr(cache, "_client", lambda: None)
    req, chain = _req(), ("fake",)
    assert cache.llm_cache_get(req, chain) is None
    assert cache.llm_cache_set(req, chain, _resp()) is True
    for _ in range(6):
        hit = cache.llm_cache_get(req, chain)
        assert hit is not None
        assert hit.cache_hit is True
        assert hit.prompt_tokens == 0
        assert hit.text == "answer"


def test_a_different_byte_shape_is_a_miss(monkeypatch):
    monkeypatch.setattr(cache, "_client", lambda: None)
    a, b = _req(payload={"query": "a"}), _req(payload={"query": "b"})
    cache.llm_cache_set(a, ("fake",), _resp("A"))
    assert cache.llm_cache_get(b, ("fake",)) is None


def test_local_store_is_bounded(monkeypatch):
    monkeypatch.setattr(cache, "_client", lambda: None)
    monkeypatch.setattr(cache, "_LOCAL_MAX", 4)
    for i in range(10):
        cache.llm_cache_set(_req(payload={"i": i}), ("fake",), _resp(str(i)))
    assert cache.local_stats()["entries"] <= 4


def test_noncacheable_requests_never_reach_the_local_store(monkeypatch):
    monkeypatch.setattr(cache, "_client", lambda: None)
    hot = _req(temperature=0.7)
    assert cache.llm_cache_set(hot, ("fake",), _resp()) is False
    assert cache.llm_cache_get(hot, ("fake",)) is None
    assert cache.llm_cache_set(_req(task_class="reason"), ("fake",), _resp()) is False


def test_reset_clears_the_local_store(monkeypatch):
    monkeypatch.setattr(cache, "_client", lambda: None)
    cache.llm_cache_set(_req(), ("fake",), _resp())
    assert cache.local_stats()["entries"] >= 1
    cache.reset_client()
    assert cache.local_stats()["entries"] == 0


def test_expired_entries_are_not_replayed(monkeypatch):
    monkeypatch.setattr(cache, "_client", lambda: None)
    monkeypatch.setattr(cache, "_ttl_s", lambda: -1)
    cache.llm_cache_set(_req(), ("fake",), _resp())
    assert cache.llm_cache_get(_req(), ("fake",)) is None
