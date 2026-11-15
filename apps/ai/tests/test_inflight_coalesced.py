"""D1169 — the singleflight coalescer: N concurrent identical calls ride ONE provider call.

The replay cache (D1047) collapses *sequential* duplicates; the inflight coalescer collapses
*concurrent* ones. These 4 tests pin the contract: one provider call serves all waiters, the
waiter bills zero rows, temperature-0 is the hard gate, and the opt-out restores the serial path.
"""

from __future__ import annotations

import asyncio

import pytest

import nexus_ai.models.router as router_module
from nexus_ai.models.base import LLMRequest, LLMResponse, TASK_MODEL_DEFAULTS
from nexus_ai.models.router import CostMeter, ModelRouter


class _FakeAdapter:
    name = "fake"

    def __init__(self, text: str = "answer"):
        self.calls = 0
        self.text = text

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls += 1
        await asyncio.sleep(0.01)  # force the interleave
        meta = TASK_MODEL_DEFAULTS[req.task_class]
        return LLMResponse(
            text=self.text, provider=self.name, model="fake-1",
            task_class=req.task_class, purpose=meta["purpose"],
            prompt_tokens=42, completion_tokens=7, cost_usd=0.002,
            latency_ms=10, degraded=False, finish_reason="stop",
            cache_hit=False, cached_tokens=0,
        )


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("NEXUS_LLM_INFLIGHT_COALESCE", raising=False)
    monkeypatch.delenv("NEXUS_LLM_RESPONSE_CACHE", raising=False)
    yield
    monkeypatch.delenv("NEXUS_LLM_INFLIGHT_COALESCE", raising=False)
    monkeypatch.delenv("NEXUS_LLM_RESPONSE_CACHE", raising=False)


def _req(**kwargs) -> LLMRequest:
    temperature = kwargs.pop("temperature", 0.0)
    return LLMRequest(task_class=kwargs.pop("task_class", "summary"), system="s",
                      payload={"query": "hello"}, temperature=temperature, **kwargs)


@pytest.mark.asyncio
async def test_concurrent_identical_calls_share_one_provider_call(monkeypatch):
    adapter = _FakeAdapter()
    r = ModelRouter([adapter])
    req = _req()
    results = await asyncio.gather(*(r.run(req, meter=CostMeter()) for _ in range(6)))
    assert adapter.calls == 1
    texts = {x.response.text for x in results}
    assert texts == {"answer"}
    # the winner bills handwritten real tokens; the five waiters bill zero
    billed = sum(1 for x in results if x.response.prompt_tokens == 42)
    coalesced = sum(1 for x in results if x.coalesced)
    assert (billed, coalesced) == (1, 5)


@pytest.mark.asyncio
async def test_temp_nonzero_is_never_coalesced(monkeypatch):
    adapter = _FakeAdapter()
    r = ModelRouter([adapter])
    req = _req(temperature=0.7)
    results = await asyncio.gather(*(r.run(req, meter=CostMeter()) for _ in range(3)))
    assert adapter.calls == 3
    assert all(not x.coalesced for x in results)


@pytest.mark.asyncio
async def test_different_requests_never_share_a_cell(monkeypatch):
    adapter = _FakeAdapter()
    r = ModelRouter([adapter])
    reqs = [_req() for _ in range(2)] + [
        LLMRequest(task_class="summary", system="s", payload={"query": "bye"}, temperature=0.0)
    ]
    results = await asyncio.gather(*(r.run(x, meter=CostMeter()) for x in reqs))
    assert adapter.calls == 2  # two distinct byte strings


@pytest.mark.asyncio
async def test_optout_restores_serial_behaviour(monkeypatch):
    monkeypatch.setenv("NEXUS_LLM_INFLIGHT_COALESCE", "0")
    adapter = _FakeAdapter()
    r = ModelRouter([adapter])
    req = _req()
    results = await asyncio.gather(*(r.run(req, meter=CostMeter()) for _ in range(3)))
    assert adapter.calls == 3
    assert all(not x.coalesced for x in results)
    assert all(x.response.prompt_tokens == 42 for x in results)
