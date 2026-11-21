"""D1496 — parallel sessions must not share an inflight cell across different caps/subjects."""

from __future__ import annotations

import asyncio

import pytest

from nexus_ai.models.base import LLMRequest, LLMResponse, TASK_MODEL_DEFAULTS
from nexus_ai.models.inflight import chain_key
from nexus_ai.models.router import CostMeter, ModelRouter


class _Adapter:
    name = "fake"

    def __init__(self):
        self.calls = 0

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls += 1
        await asyncio.sleep(0.01)
        meta = TASK_MODEL_DEFAULTS[req.task_class]
        return LLMResponse(
            text="answer", provider=self.name, model="fake-1",
            task_class=req.task_class, purpose=meta["purpose"],
            prompt_tokens=42, completion_tokens=7, cost_usd=0.002,
            latency_ms=10, degraded=False, finish_reason="stop",
            cache_hit=False, cached_tokens=0,
        )


def _req(**kwargs) -> LLMRequest:
    return LLMRequest(task_class="summary", system="s",
                      payload={"query": "hello"}, temperature=0.0, **kwargs)


def _key(req: LLMRequest) -> str:
    return chain_key(req, ("fake",))


def test_max_tokens_is_part_of_the_cell_key():
    assert _key(_req(max_tokens=100)) != _key(_req(max_tokens=200))


def test_subject_id_is_part_of_the_cell_key():
    assert _key(_req(subject_id="alice")) != _key(_req(subject_id="bob"))


def test_same_bytes_still_share_a_key():
    assert _key(_req()) == _key(_req())


@pytest.mark.asyncio
async def test_parallel_calls_with_different_caps_never_coalesce():
    adapter = _Adapter()
    r = ModelRouter([adapter])
    short = _req(max_tokens=50)
    long = _req(max_tokens=500)
    await asyncio.gather(r.run(short, meter=CostMeter()), r.run(long, meter=CostMeter()))
    assert adapter.calls == 2  # no short-capped caller inherits a longer answer


@pytest.mark.asyncio
async def test_parallel_sessions_with_different_subjects_never_coalesce():
    adapter = _Adapter()
    r = ModelRouter([adapter])
    alice = _req(subject_id="alice")
    bob = _req(subject_id="bob")
    await asyncio.gather(r.run(alice, meter=CostMeter()), r.run(bob, meter=CostMeter()))
    assert adapter.calls == 2
