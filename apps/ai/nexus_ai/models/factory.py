"""Provider pool factory (DECISIONS D4 + §105)."""

from __future__ import annotations

from typing import Any

from nexus_ai.models.anthropic import AnthropicAdapter
from nexus_ai.models.base import LLMAdapter, LLMError
from nexus_ai.models.mock import MockAdapter
from nexus_ai.models.openai import OpenAIAdapter
from nexus_ai.models.router import ModelRouter

_POOL_CACHE: dict[str, dict[str, LLMAdapter]] = {}


def build_adapters(settings: Any) -> dict[str, LLMAdapter]:
    """Ordered pool: configured provider first, `mock` last so the ladder always lands."""
    pool: dict[str, LLMAdapter] = {}
    provider = settings.llm_provider
    if provider == "anthropic":
        pool["anthropic"] = AnthropicAdapter(
            base_url=settings.llm_base_url or AnthropicAdapter.default_base_url,
            api_key=settings.llm_api_key,
            models={"cheap": settings.llm_model_cheap, "mid": settings.llm_model_mid,
                    "reason": settings.llm_model_reason},
        )
    elif provider == "openai":
        pool["openai"] = OpenAIAdapter(
            base_url=settings.llm_base_url or OpenAIAdapter.default_base_url,
            api_key=settings.llm_api_key,
            models={"cheap": settings.llm_model_cheap, "mid": settings.llm_model_mid,
                    "reason": settings.llm_model_reason},
        )
    pool["mock"] = MockAdapter()
    return pool


def get_pool(settings: Any | None = None) -> dict[str, LLMAdapter]:
    from nexus_ai.config import get_settings

    settings = settings or get_settings()
    key = f"{settings.llm_provider}|{settings.llm_base_url}"
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
