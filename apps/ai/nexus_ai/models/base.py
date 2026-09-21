"""Provider abstraction (AGENT_CONTRACT §9, DECISIONS D4).

This module holds the `LLMAdapter` protocol, the wire-agnostic request/response data,
pricing and the shared httpx plumbing. The concrete adapters live in `mock.py`,
`anthropic.py`, `openai.py`; `factory.py` builds the provider pool.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal, Protocol, runtime_checkable

TaskClass = Literal[
    "intent_extract", "classify", "route", "embed", "rerank", "summary", "reason",
    "generate_ui_copy",
]

#: AGENT_CONTRACT §9 table — cheapest model that can do the job.
TASK_MODEL_DEFAULTS: dict[str, dict[str, str]] = {
    "intent_extract": {"tier": "cheap", "purpose": "intent"},
    "classify": {"tier": "cheap", "purpose": "classify"},
    "route": {"tier": "cheap", "purpose": "classify"},
    "embed": {"tier": "embedding", "purpose": "embed"},
    "rerank": {"tier": "reranker", "purpose": "rerank"},
    "summary": {"tier": "mid", "purpose": "summary"},
    "reason": {"tier": "reason", "purpose": "generate"},
    "generate_ui_copy": {"tier": "mid", "purpose": "generate"},
}

#: USD per 1k tokens. Dev-only estimates that populate `llm_calls.cost_usd` (§9);
#: real spend is whatever the provider bills — these are never a claim of invoice truth.
PRICE_PER_1K: dict[str, tuple[float, float]] = {
    "cheap": (0.00025, 0.00125),
    "mid": (0.003, 0.015),
    "reason": (0.015, 0.075),
    "reranker": (0.0005, 0.0),
    "embedding": (0.0001, 0.0),
}

#: §2 budget: max 3 LLM calls per user-facing request, `reason` at most 1 (§9).
MAX_REASON_CALLS_PER_REQUEST = 1

__all__ = [
    "LLMAdapter", "LLMRequest", "LLMResponse", "LLMError", "TaskClass",
    "TASK_MODEL_DEFAULTS", "MAX_REASON_CALLS_PER_REQUEST", "PRICE_PER_1K",
    "budget_for", "estimate_tokens", "cost_usd", "norm_locale", "maybe_json",
    "record_title", "record_price", "record_meters", "record_rating", "record_top_reason",
    "HttpLLMAdapter", "now_ms",
]


def budget_for(task_class: str) -> dict[str, Any]:
    meta = TASK_MODEL_DEFAULTS.get(task_class)
    if meta is None:
        raise KeyError(f"unknown task_class {task_class!r}")
    return dict(meta)


def now_ms() -> int:
    return time.monotonic_ns() // 1_000_000


@dataclass
class LLMRequest:
    task_class: TaskClass
    #: structured input for the mock heuristics (e.g. {"query": "...", "context": {...}})
    payload: dict[str, Any] = field(default_factory=dict)
    system: str = ""
    prompt: str = ""
    max_tokens: int = 1024
    temperature: float = 0.0
    #: when set, the caller expects JSON back; real adapters request structured output
    json_hint: str | None = None
    subject_id: str | None = None


@dataclass
class LLMResponse:
    text: str
    data: Any = None
    #: D4: every response carries `provider`, and the app sets X-Nexus-Degraded from it
    provider: str = "mock"
    model: str = "mock-heuristic-1"
    task_class: str = "generate"
    purpose: str = "generate"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    #: True when this came from mock/fallback rather than a configured live model (§105)
    degraded: bool = True
    cache_hit: bool = False
    finish_reason: str = "stop"

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class LLMError(RuntimeError):
    """Provider failure. The orchestrator turns this into the §105 fallback ladder."""

    def __init__(self, message: str, *, provider: str = "unknown", retryable: bool = False,
                 status: int | None = None):
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable
        self.status = status


def estimate_tokens(text: str) -> int:
    """Rough token count: CJK chars ~1 token, latin ~4 chars/token."""
    if not text:
        return 0
    cjk = len(re.findall(r"[㐀-䶿一-鿿豈-﫿]", text))
    rest = len(text) - cjk
    return max(1, cjk + rest // 4)


def cost_usd(tier: str, prompt_tokens: int, completion_tokens: int) -> float:
    pin, pout = PRICE_PER_1K.get(tier, PRICE_PER_1K["mid"])
    return float(Decimal(str(prompt_tokens / 1000 * pin + completion_tokens / 1000 * pout))
                 .quantize(Decimal("0.000001")))


@runtime_checkable
class LLMAdapter(Protocol):
    """One interface for every provider (AGENT_CONTRACT §9)."""

    name: str

    async def complete(self, req: LLMRequest) -> LLMResponse: ...

    async def health(self) -> dict[str, Any]: ...


def norm_locale(locale: str) -> str:
    low = (locale or "").lower()
    if low.startswith("en"):
        return "en"
    if "cn" in low or low.startswith("zh-hans"):
        return "zh-CN"
    return "zh-HK"


def maybe_json(text: str) -> Any:
    stripped = text.strip()
    if not stripped or stripped[0] not in "{[":
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


# --------------------------------------------------------------------------- record helpers
# Shared by the mock heuristics and the explanation builder so both read EntityCard
# dicts and raw DB rows the same way.


def record_title(rec: dict[str, Any]) -> str:
    return str(rec.get("title") or rec.get("name") or rec.get("display_name") or "?")


def record_price(rec: dict[str, Any]) -> float | None:
    price = rec.get("price")
    if isinstance(price, dict):
        price = price.get("amount")
    if price is None:
        return None
    try:
        return float(price)
    except (TypeError, ValueError):
        return None


def record_meters(rec: dict[str, Any]) -> float | None:
    dist = rec.get("distance")
    if isinstance(dist, dict):
        dist = dist.get("meters")
    try:
        return None if dist is None else float(dist)
    except (TypeError, ValueError):
        return None


def record_rating(rec: dict[str, Any]) -> float | None:
    rating = rec.get("rating")
    if isinstance(rating, dict):
        rating = rating.get("value")
    try:
        return None if rating is None else float(rating)
    except (TypeError, ValueError):
        return None


def record_top_reason(rec: dict[str, Any]) -> str:
    match = rec.get("ai_match") or {}
    reasons = match.get("reasons") if isinstance(match, dict) else None
    if reasons:
        first = reasons[0]
        return str(first.get("text") if isinstance(first, dict) else first)
    return ""


class HttpLLMAdapter:
    """Shared httpx plumbing for live providers.

    Base URL + key come from env only (DECISIONS D4 / §131: never hardcoded, never
    committed). Constructing without them raises `LLMError` so the factory can degrade
    to `mock` instead of the whole service failing to boot.
    """

    name = "http"
    default_base_url = ""
    default_models = {"cheap": "", "mid": "", "reason": ""}

    def __init__(self, *, base_url: str = "", api_key: str = "",
                 models: dict[str, str] | None = None, timeout_s: float = 20.0,
                 client: Any = None):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.models = {**self.default_models, **(models or {})}
        self.timeout_s = timeout_s
        self._client = client
        if not self.base_url or not self.api_key:
            raise LLMError(
                f"{type(self).__name__}: NEXUS_LLM_BASE_URL / NEXUS_LLM_API_KEY are not set — "
                "keeping NEXUS_LLM_PROVIDER=mock (DECISIONS D4)",
                provider=self.name,
            )

    def _http(self):
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=self.timeout_s)
        return self._client

    async def health(self) -> dict[str, Any]:
        return {"provider": self.name, "ok": bool(self.base_url and self.api_key),
                "model": self.models, "base_url": self.base_url}

    def _model_for(self, tier: str) -> str:
        return self.models.get(tier) or self.models.get("mid") or ""

    @staticmethod
    def _user_text(req: LLMRequest) -> str:
        return req.prompt or json.dumps(req.payload, ensure_ascii=False)

    async def complete(self, req: LLMRequest) -> LLMResponse:  # pragma: no cover
        raise NotImplementedError("subclasses implement the wire call")
