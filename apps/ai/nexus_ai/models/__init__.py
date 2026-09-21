"""Provider abstraction (AGENT_CONTRACT §9, DECISIONS D4).

One interface, three adapters: `AnthropicAdapter`, `OpenAIAdapter`, `MockAdapter`
(default). Every response carries `provider` so the app can set `X-Nexus-Degraded`.
"""

from __future__ import annotations

from nexus_ai.models.anthropic import AnthropicAdapter
from nexus_ai.models.base import (
    MAX_REASON_CALLS_PER_REQUEST,
    PRICE_PER_1K,
    TASK_MODEL_DEFAULTS,
    HttpLLMAdapter,
    LLMAdapter,
    LLMError,
    LLMRequest,
    LLMResponse,
    TaskClass,
    budget_for,
    cost_usd,
    estimate_tokens,
)
from nexus_ai.models.embeddings import (
    DIM,
    EmbeddingAdapter,
    HashingEmbedding,
    HttpEmbedding,
    get_embedding_adapter,
)
from nexus_ai.models.factory import (
    build_adapters,
    get_adapter,
    get_pool,
    get_router,
    reset_provider_cache,
)
from nexus_ai.models.mock import MockAdapter, SUMMARY_TEMPLATES
from nexus_ai.models.openai import OpenAIAdapter
from nexus_ai.models.router import BudgetExceeded, CostMeter, ModelRouter, RoutedCall

__all__ = [
    "LLMAdapter", "LLMError", "LLMRequest", "LLMResponse", "TaskClass", "HttpLLMAdapter",
    "MockAdapter", "AnthropicAdapter", "OpenAIAdapter", "SUMMARY_TEMPLATES",
    "TASK_MODEL_DEFAULTS", "MAX_REASON_CALLS_PER_REQUEST", "PRICE_PER_1K",
    "budget_for", "cost_usd", "estimate_tokens",
    "EmbeddingAdapter", "HashingEmbedding", "HttpEmbedding", "get_embedding_adapter", "DIM",
    "ModelRouter", "RoutedCall", "CostMeter", "BudgetExceeded",
    "build_adapters", "get_adapter", "get_pool", "get_router", "reset_provider_cache",
]
