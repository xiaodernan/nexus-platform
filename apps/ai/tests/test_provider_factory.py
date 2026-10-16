"""Provider pool factory — the §105 degrade-to-mock ladder (DECISIONS D4).

`models/factory.py` builds the LLM provider pool and is the safety floor of the whole
service: a misconfigured live provider must never stop the product, so the pool always ends
with `mock` last and any `LLMError` during live-adapter construction degrades the pool to
`{"mock": MockAdapter()}`. This pins that contract. DB-free (no live calls).
"""

from __future__ import annotations

import pytest

from nexus_ai.models.base import LLMError
from nexus_ai.models.factory import (
    _POOL_CACHE,
    build_adapters,
    get_adapter,
    get_pool,
    reset_provider_cache,
)
from nexus_ai.models.mock import MockAdapter


class _Settings:
    def __init__(self, provider="mock", base_url="", api_key="", cheap="", mid="",
                 reason="", max_llm_calls=3):
        self.llm_provider = provider
        self.llm_base_url = base_url
        self.llm_api_key = api_key
        self.llm_model_cheap = cheap
        self.llm_model_mid = mid
        self.llm_model_reason = reason
        self.max_llm_calls = max_llm_calls


# ------------------------------------------------------------- construction
def test_build_adapters_mock_only_for_mock_provider():
    pool = build_adapters(_Settings(provider="mock"))
    assert list(pool.keys()) == ["mock"]
    assert isinstance(pool["mock"], MockAdapter)


def test_build_adapters_always_includes_mock_floor():
    for provider in ("mock", "anthropic", "openai"):
        pool = build_adapters(_Settings(provider=provider,
                                       base_url="https://x.test", api_key="k"))
        assert "mock" in pool


def test_build_adapters_adds_anthropic_with_creds():
    pool = build_adapters(_Settings(provider="anthropic",
                                   base_url="https://api.anthropic.com", api_key="sk-x"))
    assert pool["anthropic"].name == "anthropic"
    assert "mock" in pool


def test_build_adapters_adds_openai_with_creds():
    pool = build_adapters(_Settings(provider="openai",
                                   base_url="https://api.openai.com/v1", api_key="sk-x"))
    assert pool["openai"].name == "openai"
    assert "mock" in pool


def test_build_adapters_missing_creds_raises():
    # the ladder relies on this: a live adapter without creds must raise LLMError
    with pytest.raises(LLMError):
        build_adapters(_Settings(provider="anthropic", api_key=""))


# ------------------------------------------------------------- §105 degrade ladder
def test_get_pool_degrades_to_mock_on_misconfigured_live():
    reset_provider_cache()
    # provider=anthropic but no key -> build_adapters raises -> caught -> mock only
    pool = get_pool(_Settings(provider="anthropic", api_key=""))
    assert set(pool.keys()) == {"mock"}
    assert isinstance(pool["mock"], MockAdapter)


def test_get_pool_is_cached_and_always_has_mock():
    reset_provider_cache()
    s = _Settings(provider="mock")
    p1 = get_pool(s)
    p2 = get_pool(s)
    assert p1 is p2            # cached, deterministic
    assert "mock" in p1


def test_get_adapter_returns_first_in_pool():
    reset_provider_cache()
    assert get_adapter(_Settings(provider="mock")).name == "mock"
    reset_provider_cache()
    adapter = get_adapter(_Settings(provider="anthropic",
                                   base_url="https://api.anthropic.com", api_key="sk-x"))
    assert adapter.name == "anthropic"   # live adapter is first when present


def test_reset_provider_cache_clears():
    reset_provider_cache()
    get_pool(_Settings(provider="mock"))
    assert len(_POOL_CACHE) == 1
    reset_provider_cache()
    assert len(_POOL_CACHE) == 0
