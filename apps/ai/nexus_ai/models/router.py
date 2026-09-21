"""Model router + per-request cost meter (AGENT_CONTRACT §9, spec §101-102, §160).

Maps task class -> cheapest model that can do the job, enforces the LLM budget
(<=3 calls, <=1 `reason`), and runs the §105 ladder *inside* the model layer: a live
provider failure falls back to the next adapter in the chain and finally to `mock`,
marking the call degraded so `X-Nexus-Degraded` gets set.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from nexus_ai.models.base import (
    MAX_REASON_CALLS_PER_REQUEST,
    TASK_MODEL_DEFAULTS,
    LLMAdapter,
    LLMError,
    LLMRequest,
    LLMResponse,
)


@dataclass
class RoutedCall:
    """One routed LLM call, ready to be recorded into `llm_calls`."""

    response: LLMResponse
    task_class: str
    fallback_from: str | None = None

    def as_llm_call_row(self, agent_run_id: Any = None) -> dict[str, Any]:
        r = self.response
        return {
            "agent_run_id": agent_run_id,
            "provider": r.provider,
            "model": r.model,
            "purpose": r.purpose,
            "prompt_tokens": r.prompt_tokens,
            "completion_tokens": r.completion_tokens,
            "cost_usd": r.cost_usd,
            "latency_ms": r.latency_ms,
            "status": "ok",
            "cache_hit": r.cache_hit,
        }


@dataclass
class CostMeter:
    """Accumulates tokens/cost/latency for one user-facing request (§9)."""

    llm_calls: int = 0
    reason_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    degraded: bool = False
    providers: list[str] = field(default_factory=list)

    def add(self, resp: LLMResponse) -> None:
        self.llm_calls += 1
        if resp.task_class == "reason":
            self.reason_calls += 1
        self.prompt_tokens += resp.prompt_tokens
        self.completion_tokens += resp.completion_tokens
        self.cost_usd = round(self.cost_usd + resp.cost_usd, 6)
        self.latency_ms += resp.latency_ms
        self.degraded = self.degraded or resp.degraded
        self.providers.append(resp.provider)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class BudgetExceeded(RuntimeError):
    def __init__(self, kind: str, limit: int):
        super().__init__(f"{kind} budget exceeded (limit {limit}) — degrade deterministically")
        self.kind = kind
        self.limit = limit


class ModelRouter:
    """Cheapest-capable-model routing with a fallback chain (§9, §105)."""

    def __init__(self, adapters: list[LLMAdapter], *, max_llm_calls: int = 3,
                 tier_override: dict[str, str] | None = None):
        if not adapters:
            raise ValueError("ModelRouter needs at least one adapter")
        self.adapters = adapters
        self.max_llm_calls = max_llm_calls
        self.tier_override = tier_override or {}

    @property
    def primary(self) -> LLMAdapter:
        return self.adapters[0]

    def provider_name(self) -> str:
        return self.primary.name

    def pick(self, task_class: str) -> str:
        if task_class not in TASK_MODEL_DEFAULTS:
            raise KeyError(f"unknown task_class {task_class!r}")
        return self.tier_override.get(task_class) or TASK_MODEL_DEFAULTS[task_class]["tier"]

    async def run(self, req: LLMRequest, meter: CostMeter | None = None) -> RoutedCall:
        meter = meter if meter is not None else CostMeter()
        if meter.llm_calls >= self.max_llm_calls:
            raise BudgetExceeded("llm", self.max_llm_calls)
        if req.task_class == "reason" and meter.reason_calls >= MAX_REASON_CALLS_PER_REQUEST:
            raise BudgetExceeded("reason", MAX_REASON_CALLS_PER_REQUEST)

        last_err: LLMError | None = None
        for idx, adapter in enumerate(self.adapters):
            try:
                resp = await adapter.complete(req)
            except LLMError as exc:
                last_err = exc
                continue
            except Exception as exc:  # adapter bug must not kill the request (§105)
                last_err = LLMError(f"{adapter.name} crashed: {exc}", provider=adapter.name,
                                    retryable=True)
                continue
            if meter is not None:
                meter.add(resp)
            return RoutedCall(response=resp, task_class=req.task_class,
                              fallback_from=self.adapters[0].name if idx else None)
        # exhausted the chain: the caller's next rung is deterministic search (§105)
        raise last_err or LLMError("no adapter available", provider="none")
