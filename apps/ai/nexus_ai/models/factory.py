"""Provider pool factory (DECISIONS D4 + §105)."""

from __future__ import annotations

from typing import Any

from nexus_ai.models.anthropic import AnthropicAdapter
from nexus_ai.models.base import LLMAdapter, LLMError
from nexus_ai.models.mock import MockAdapter
from nexus_ai.models.openai import OpenAIAdapter
from nexus_ai.models.router import ModelRouter

_POOL_CACHE: dict[str, dict[str, LLMAdapter]] = {}

#: D983 — `config.Settings.request_timeout_s` (env `NEXUS_REQUEST_TIMEOUT_S`) used to be
#: parsed and then NEVER read: both live adapters were constructed without `timeout_s`, so
#: `HttpLLMAdapter.__init__`'s hard-coded 20.0s won and the operator's knob was dead. Against a
#: slow OpenAI-compatible proxy that 20s ceiling made the D982 live intent path degrade to
#: `mock` on most turns. The knob must survive to BOTH adapters, and the cache key must carry
#: it too — otherwise changing the timeout would keep handing back the old client.
DEFAULT_REQUEST_TIMEOUT_S = 45.0


def _request_timeout(settings: Any) -> float:
    """D983: the operator's timeout, with a safe default for dummy/test settings."""
    return float(getattr(settings, "request_timeout_s", DEFAULT_REQUEST_TIMEOUT_S))


def build_adapters(settings: Any) -> dict[str, LLMAdapter]:
    """Ordered pool: configured provider first, `mock` last so the ladder always lands."""
    pool: dict[str, LLMAdapter] = {}
    provider = settings.llm_provider
    timeout_s = _request_timeout(settings)
    if provider == "anthropic":
        pool["anthropic"] = AnthropicAdapter(
            base_url=settings.llm_base_url or AnthropicAdapter.default_base_url,
            api_key=settings.llm_api_key,
            models={"cheap": settings.llm_model_cheap, "mid": settings.llm_model_mid,
                    "reason": settings.llm_model_reason},
            timeout_s=timeout_s,
        )
    elif provider == "openai":
        pool["openai"] = OpenAIAdapter(
            base_url=settings.llm_base_url or OpenAIAdapter.default_base_url,
            api_key=settings.llm_api_key,
            models={"cheap": settings.llm_model_cheap, "mid": settings.llm_model_mid,
                    "reason": settings.llm_model_reason},
            timeout_s=timeout_s,
        )
    pool["mock"] = MockAdapter()
    return pool


def pool_key(settings: Any) -> str:
    """D983 follow-through — the ONE definition of a pool cache identity.

    A caller that pre-seeds `_POOL_CACHE` (e.g. the framing-parity probe injecting a fake
    live adapter) must derive the key the same way `get_pool` looks it up, or the injection
    silently misses and the test measures the mock floor while believing it measured live.
    D983 added the timeout term here and that coupling bit CI until this function existed.
    """
    return f"{settings.llm_provider}|{settings.llm_base_url}|{_request_timeout(settings)}"


def get_pool(settings: Any | None = None) -> dict[str, LLMAdapter]:
    from nexus_ai.config import get_settings

    settings = settings or get_settings()
    # D983: the timeout is part of the pool identity. Two settings objects that differ only
    # in request_timeout_s must NOT share a cached httpx client (that would re-kill the knob).
    key = pool_key(settings)
    if key not in _POOL_CACHE:
        try:
            _POOL_CACHE[key] = build_adapters(settings)
        except LLMError:
            # A misconfigured live provider must never stop the product: degrade to mock.
            _POOL_CACHE[key] = {"mock": MockAdapter()}
    return _POOL_CACHE[key]


def get_adapter(settings: Any | None = None) -> LLMAdapter:
    return next(iter(get_pool(settings).values()))


def get_router(settings: Any | None = None) -> ModelRouter:
    from nexus_ai.config import get_settings

    settings = settings or get_settings()
    return ModelRouter(list(get_pool(settings).values()), max_llm_calls=settings.max_llm_calls)


def reset_provider_cache() -> None:
    _POOL_CACHE.clear()
