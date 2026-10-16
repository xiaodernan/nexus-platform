"""`models/router.py` — model routing, per-request cost meter, and the §2/§105 ladder.

`ModelRouter` maps task class → cheapest tier, enforces the LLM budget (≤3 calls,
≤1 `reason` per user-facing request, AGENT_CONTRACT §2/§9), and runs the §105 fallback
ladder *inside* the model layer: a live provider failure (or an adapter bug) falls through
to the next adapter and never kills the request. `CostMeter` accumulates the telemetry that
becomes an `llm_calls` row. It had **no tests**. Fake adapters stand in for real providers
so no network is touched. DB-free, async.
"""

from __future__ import annotations

import pytest

from nexus_ai.models.base import (
    TASK_MODEL_DEFAULTS,
    LLMError,
    LLMRequest,
    LLMResponse,
)
from nexus_ai.models.router import BudgetExceeded, CostMeter, ModelRouter, RoutedCall


class _Fake:
    """Deterministic stand-in adapter: returns `resp`, or raises `error`/`crash`."""

    def __init__(self, name, resp=None, error=None, crash=None):
        self.name = name
        self._resp = resp
        self._error = error
        self._crash = crash
        self.calls = 0

    async def complete(self, req):
        self.calls += 1
        if self._crash is not None:
            raise self._crash
        if self._error is not None:
            raise self._error
        return self._resp

    async def health(self):
        return {"provider": self.name, "ok": True}


def _resp(task_class="summary", provider="mock", prompt_tokens=10, completion_tokens=5,
          cost_usd=0.0, latency_ms=2, degraded=False):
    return LLMResponse(text="x", data={}, provider=provider, model="m", task_class=task_class,
                       purpose=TASK_MODEL_DEFAULTS[task_class]["purpose"],
                       prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
                       cost_usd=cost_usd, latency_ms=latency_ms, degraded=degraded)


# ------------------------------------------------------------- CostMeter
def test_cost_meter_accumulates_and_ors_degraded():
    m = CostMeter()
    m.add(_resp(task_class="summary", provider="mock", prompt_tokens=10, completion_tokens=5,
               cost_usd=0.01, latency_ms=2, degraded=True))
    m.add(_resp(task_class="reason", provider="anthropic", prompt_tokens=20, completion_tokens=7,
               cost_usd=0.02, latency_ms=3, degraded=False))
    assert m.llm_calls == 2
    assert m.reason_calls == 1
    assert m.prompt_tokens == 30
    assert m.completion_tokens == 12
    assert m.total_tokens == 42
    assert abs(m.cost_usd - 0.03) < 1e-9
    assert m.latency_ms == 5
    assert m.degraded is True            # OR across responses
    assert m.providers == ["mock", "anthropic"]


# ------------------------------------------------------------- pick / budget
def test_pick_returns_cheapest_tier_with_override():
    r = ModelRouter([_Fake("mock")])
    assert r.pick("intent_extract") == "cheap"
    assert r.pick("summary") == "mid"
    r2 = ModelRouter([_Fake("mock")], tier_override={"summary": "cheap"})
    assert r2.pick("summary") == "cheap"
    with pytest.raises(KeyError):
        r.pick("nonsense")


async def test_run_enforces_llm_call_budget():
    r = ModelRouter([_Fake("mock", resp=_resp("summary"))], max_llm_calls=3)
    meter = CostMeter()
    for _ in range(3):
        await r.run(LLMRequest(task_class="summary"), meter)
    assert meter.llm_calls == 3
    with pytest.raises(BudgetExceeded) as exc:
        await r.run(LLMRequest(task_class="summary"), meter)
    assert exc.value.kind == "llm" and exc.value.limit == 3


async def test_run_enforces_reason_call_budget():
    r = ModelRouter([_Fake("mock", resp=_resp("reason"))])
    meter = CostMeter()
    await r.run(LLMRequest(task_class="reason"), meter)
    assert meter.reason_calls == 1
    with pytest.raises(BudgetExceeded) as exc:
        await r.run(LLMRequest(task_class="reason"), meter)
    assert exc.value.kind == "reason" and exc.value.limit == 1


# ------------------------------------------------------------- §105 fallback chain
async def test_run_primary_success_has_no_fallback():
    resp = _resp("summary", provider="mock")
    r = ModelRouter([_Fake("mock", resp=resp)])
    call = await r.run(LLMRequest(task_class="summary"))
    assert call.response is resp
    assert call.task_class == "summary"
    assert call.fallback_from is None          # primary succeeded


async def test_run_falls_back_on_provider_error():
    good = _resp("summary", provider="mock")
    r = ModelRouter([_Fake("anthropic", error=LLMError("500", provider="anthropic")),
                     _Fake("mock", resp=good)])
    call = await r.run(LLMRequest(task_class="summary"))
    assert call.response is good
    assert call.fallback_from == "anthropic"   # fell through from the primary


async def test_run_adapter_crash_is_contained_and_falls_back():
    good = _resp("summary", provider="mock")
    r = ModelRouter([_Fake("anthropic", crash=RuntimeError("kaboom")),
                     _Fake("mock", resp=good)])
    call = await r.run(LLMRequest(task_class="summary"))
    assert call.response is good
    assert call.fallback_from == "anthropic"   # §105: adapter bug must not kill the request


async def test_run_all_adapters_fail_raises_last_error():
    r = ModelRouter([_Fake("anthropic", error=LLMError("boom1", provider="anthropic")),
                     _Fake("openai", error=LLMError("boom2", provider="openai"))])
    with pytest.raises(LLMError) as exc:
        await r.run(LLMRequest(task_class="summary"))
    assert "boom2" in str(exc.value)           # surfaces the last rung's error


# ------------------------------------------------------------- llm_calls row + wiring
def test_routed_call_as_llm_call_row_shape():
    resp = _resp("summary", provider="anthropic", prompt_tokens=100, completion_tokens=50,
                 cost_usd=0.012, latency_ms=8)
    row = RoutedCall(response=resp, task_class="summary").as_llm_call_row(agent_run_id="run-1")
    assert row["agent_run_id"] == "run-1"
    assert row["provider"] == "anthropic"
    assert row["purpose"] == TASK_MODEL_DEFAULTS["summary"]["purpose"]
    assert row["prompt_tokens"] == 100 and row["completion_tokens"] == 50
    assert row["cost_usd"] == 0.012
    assert row["latency_ms"] == 8
    assert row["status"] == "ok"
    assert row["cache_hit"] is False


def test_router_requires_at_least_one_adapter():
    with pytest.raises(ValueError):
        ModelRouter([])


def test_primary_and_provider_name():
    a, b = _Fake("anthropic"), _Fake("mock")
    r = ModelRouter([a, b])
    assert r.primary is a
    assert r.provider_name() == "anthropic"
