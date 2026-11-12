"""D983 — `NEXUS_REQUEST_TIMEOUT_S` is a real knob, not a parsed-then-dropped lie.

Before D983, `config.load_settings()` read `request_timeout_s` (env `NEXUS_REQUEST_TIMEOUT_S`)
and `factory.build_adapters()` constructed both live adapters WITHOUT passing `timeout_s`, so
`HttpLLMAdapter.__init__`'s hard-coded 20.0s always won: the operator could not lengthen the
per-request LLM deadline, and against a slow proxy the D982 live intent path degraded to
`mock` on most turns (measured: the soba query reached live 0/4 at the wired-in 20s). The pool
cache key omitted the timeout too, so even a corrected value would have handed back the stale
httpx client.

This probe is offline (no network: adapters are constructed, their lazy httpx client inspected).
It pins the FULL path the config promises — settings -> factory -> adapter.timeout_s -> the
real `httpx.AsyncClient(timeout=...)` — for BOTH live adapters symmetrically, the cache-key
identity, the dummy-settings fallback that keeps the §105 ladder tests working, and the
zero-regression of the mock floor / ladder order. A one-variable falsifier restores the old
"factory drops the timeout" shape and asserts the detector reddens.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import nexus_ai.config as C
import nexus_ai.models.factory as F
from nexus_ai.models.anthropic import AnthropicAdapter
from nexus_ai.models.mock import MockAdapter
from nexus_ai.models.openai import OpenAIAdapter


def _live_settings(provider: str, timeout: float = 45.0):
    return SimpleNamespace(
        llm_provider=provider, llm_base_url="https://proxy.test/v1", llm_api_key="sk-x",
        llm_model_cheap="c", llm_model_mid="m", llm_model_reason="r",
        max_llm_calls=3, request_timeout_s=timeout,
    )


def _read_timeout(adapter) -> float:
    """The deadline the REAL lazy httpx client will use (not just the stored attribute)."""
    client = adapter._http()
    t = client.timeout
    return float(t.read if hasattr(t, "read") else t)


def test_both_live_adapters_receive_the_operator_timeout():
    for provider, cls in (("openai", OpenAIAdapter), ("anthropic", AnthropicAdapter)):
        a = F.build_adapters(_live_settings(provider, timeout=37.0))[provider]
        assert isinstance(a, cls)
        assert a.timeout_s == 37.0, (provider, a.timeout_s)
        assert _read_timeout(a) == 37.0, (provider, "the httpx client ignored the knob")
        asyncio.run(a._http().aclose())


def test_env_value_flows_from_load_settings_through_the_pool_to_the_client(monkeypatch):
    monkeypatch.setenv("NEXUS_LLM_PROVIDER", "openai")
    monkeypatch.setenv("NEXUS_LLM_BASE_URL", "https://proxy.test/v1")
    monkeypatch.setenv("NEXUS_LLM_API_KEY", "sk-x")
    monkeypatch.setenv("NEXUS_REQUEST_TIMEOUT_S", "63")
    C.reset_settings_cache()
    F.reset_provider_cache()
    try:
        a = F.get_pool(C.load_settings())["openai"]
        assert C.load_settings().request_timeout_s == 63.0
        assert a.timeout_s == 63.0
        assert _read_timeout(a) == 63.0, "the env knob died between config and httpx"
        asyncio.run(a._http().aclose())
    finally:
        F.reset_provider_cache()
        C.reset_settings_cache()


def test_a_changed_timeout_is_a_different_pool_entry_not_the_stale_client():
    F.reset_provider_cache()
    try:
        a = F.get_pool(_live_settings("openai", timeout=10.0))["openai"]
        b = F.get_pool(_live_settings("openai", timeout=90.0))["openai"]
        assert a is not b, "the cache key ignored the timeout — changing it handed back the old client"
        assert a.timeout_s == 10.0 and b.timeout_s == 90.0
        asyncio.run(a._http().aclose())
        asyncio.run(b._http().aclose())
    finally:
        F.reset_provider_cache()


def test_the_same_timeout_still_hits_the_cache():
    F.reset_provider_cache()
    try:
        a = F.get_pool(_live_settings("openai", timeout=45.0))
        b = F.get_pool(_live_settings("openai", timeout=45.0))
        assert a is b, "D983 must not break the pool's determinism/caching contract"
    finally:
        F.reset_provider_cache()


def test_dummy_settings_without_the_attr_fall_back_safely_and_mock_floor_holds():
    # The §105 ladder tests build bare settings with no request_timeout_s; D983 must not
    # turn a knob repair into an AttributeError regression on those planes.
    for provider in ("mock", "anthropic", "openai"):
        s = SimpleNamespace(llm_provider=provider, llm_base_url="https://x.test",
                            llm_api_key="k", llm_model_cheap="c", llm_model_mid="m",
                            llm_model_reason="r", max_llm_calls=3)
        pool = F.build_adapters(s)
        assert "mock" in pool and isinstance(pool["mock"], MockAdapter)
        for name, a in pool.items():
            if name != "mock":
                assert a.timeout_s == F.DEFAULT_REQUEST_TIMEOUT_S


def test_zero_regression_the_gradient_ladder_and_degrade_contract_are_untouched():
    # D983 changes ONLY the deadline; the provider order (live first, mock floor last) and
    # the misconfigured-live -> mock degrade are the §105 safety net and must not move.
    F.reset_provider_cache()
    try:
        pool = F.get_pool(_live_settings("openai", timeout=55.0))
        assert list(pool) == ["openai", "mock"]
        r = F.get_router(_live_settings("openai", timeout=55.0))
        assert [a.name for a in r.adapters] == ["openai", "mock"]
        broken = SimpleNamespace(llm_provider="anthropic", llm_base_url="", llm_api_key="",
                                 llm_model_cheap="", llm_model_mid="", llm_model_reason="",
                                 max_llm_calls=3)
        assert list(F.get_pool(broken)) == ["mock"]
    finally:
        F.reset_provider_cache()


def test_falsifier_dropping_the_timeout_would_strand_the_knob():
    """One variable: rebuild the adapters the OLD way (no timeout_s) and show it fails the
    very claim this probe guards — a detector that cannot redden protects nothing."""
    s = _live_settings("openai", timeout=37.0)
    old_shape = OpenAIAdapter(base_url=s.llm_base_url, api_key=s.llm_api_key,
                              models={"cheap": "c", "mid": "m", "reason": "r"})
    try:
        assert old_shape.timeout_s != 37.0, (
            "the falsifier did not reproduce the old hard-coded 20s — it proves nothing")
        assert _read_timeout(old_shape) != 37.0
    finally:
        asyncio.run(old_shape._http().aclose())
