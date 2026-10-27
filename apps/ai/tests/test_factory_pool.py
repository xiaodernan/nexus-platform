"""Contract tests for the provider pool factory (``models/factory``, DECISIONS D4 + §105).

The factory decides which providers serve and in what order, caches the pool per
(provider, base_url), and **degrades a misconfigured live provider to mock** rather than stopping
the product. `get_router` is the seam the request path calls. Pure (no network: adapters are
constructed, not called).

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import nexus_ai.models.factory as F
from nexus_ai.models.mock import MockAdapter
from nexus_ai.models.router import ModelRouter


def _settings(provider: str = "mock", key: str = "k", base: str | None = None):
    return SimpleNamespace(llm_provider=provider, llm_base_url=base, llm_api_key=key,
                           llm_model_cheap="c", llm_model_mid="m", llm_model_reason="r",
                           max_llm_calls=7)


@pytest.fixture(autouse=True)
def _clean_cache():
    F.reset_provider_cache()
    yield
    F.reset_provider_cache()


class TestBuildAdapters:
    def test_mock_only(self):
        assert list(F.get_pool(_settings("mock"))) == ["mock"]

    def test_the_configured_provider_comes_first_and_mock_last(self):
        assert list(F.get_pool(_settings("anthropic"))) == ["anthropic", "mock"]
        F.reset_provider_cache()
        assert list(F.get_pool(_settings("openai"))) == ["openai", "mock"]


class TestCache:
    def test_the_same_key_returns_the_same_object(self):
        s = _settings("mock")
        assert F.get_pool(s) is F.get_pool(s)

    def test_reset_clears_the_cache(self):
        s = _settings("mock")
        first = F.get_pool(s)
        F.reset_provider_cache()
        assert F.get_pool(s) is not first

    def test_a_different_provider_is_a_different_object(self):
        assert F.get_pool(_settings("mock")) is not F.get_pool(_settings("anthropic"))


class TestDegrade:
    def test_a_misconfigured_live_provider_degrades_to_mock(self):
        # an empty key makes the adapter refuse; the product must still serve
        assert list(F.get_pool(_settings("anthropic", key=""))) == ["mock"]


class TestRouter:
    def test_router_carries_the_pool_and_the_call_cap(self):
        r = F.get_router(_settings("mock"))
        assert isinstance(r, ModelRouter)
        assert len(r.adapters) == 1
        assert isinstance(r.adapters[0], MockAdapter)
        assert r.max_llm_calls == 7

    def test_get_adapter_is_the_first_of_the_pool(self):
        assert isinstance(F.get_adapter(_settings("mock")), MockAdapter)
