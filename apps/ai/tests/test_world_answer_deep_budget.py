"""D1514 — the reader-owned depth knob owns the budget; the client never sends raw chars.

A model-facing budget is a trust boundary: let a client pass `chunk_chars=100000` and it
can turn one click into a whole-corpus bill. These pins assert the depth vocabulary is
closed, that `deep` really puts more real chapter body in front of the model, that the
retrieval is deterministic for a given budget (the byte-stable premise the prefix cache
needs), and that the HTTP route fails closed on an invented depth.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any, Awaitable, Callable

from fastapi.testclient import TestClient

import nexus_ai.api.app as app_mod
from nexus_ai.models.base import LLMResponse
from nexus_ai.orchestrator.world_answer_graph import (
    DEPTH_BUDGETS, DEPTH_DEFAULT, run_world_answer,
)
from nexus_ai.retrieval import chapter_rag


def _canned_llm(calls: list[str]) -> Callable[..., Awaitable[dict[str, Any] | None]]:
    async def llm(system: str, prompt: str, _max: int) -> dict[str, Any] | None:
        calls.append(prompt)
        return {"answer": "阿晴問起那匹馬，老虎仍舊寫在這裡。", "confidence": "high"}
    return llm


def test_depth_vocabulary_is_closed_and_bounded() -> None:
    assert set(DEPTH_BUDGETS) == {"quick", "deep"}
    assert DEPTH_DEFAULT == "quick"
    q, d = DEPTH_BUDGETS["quick"], DEPTH_BUDGETS["deep"]
    # deep must actually widen both knobs, and the widenest budget must stay finite.
    assert d["limit"] > q["limit"]
    assert d["chunk_chars"] > q["chunk_chars"]
    assert d["limit"] * d["chunk_chars"] <= 40 * 4000  # chapter_rag's own hard clamps


def test_retrieve_chunk_chars_is_bounded_no_matter_the_caller() -> None:
    # The public retrieve() clamps hostile values; 100000 cannot become a corpus dump.
    one = chapter_rag.retrieve("228 那匹馬", limit=8, chunk_chars=100000)
    assert one
    assert all(len(c["excerpt"]) <= 4000 for c in one)


def test_deep_sends_strictly_more_body_than_quick() -> None:
    query = "跑馬地 東門 228 那匹馬 還在嗎"
    quick = chapter_rag.retrieve(query, limit=DEPTH_BUDGETS["quick"]["limit"],
                                 chunk_chars=DEPTH_BUDGETS["quick"]["chunk_chars"])
    deep = chapter_rag.retrieve(query, limit=DEPTH_BUDGETS["deep"]["limit"],
                                chunk_chars=DEPTH_BUDGETS["deep"]["chunk_chars"])
    quick_chars = sum(len(c["excerpt"]) for c in quick)
    deep_chars = sum(len(c["excerpt"]) for c in deep)
    assert deep_chars > quick_chars > 0, (quick_chars, deep_chars)


def test_retrieval_is_byte_deterministic_per_budget() -> None:
    # Prefix caching only pays if the same question + budget yields the same bytes.
    query = "阿穆 抽屜 寫在這裡"
    kwargs = dict(limit=DEPTH_BUDGETS["deep"]["limit"],
                  chunk_chars=DEPTH_BUDGETS["deep"]["chunk_chars"])
    assert chapter_rag.retrieve(query, **kwargs) == chapter_rag.retrieve(query, **kwargs)


def test_unknown_depth_fails_closed_to_quick() -> None:
    calls: list[str] = []
    out = asyncio.run(run_world_answer("跑馬地 東門 阿晴 228", llm_call=_canned_llm(calls),
                                       depth="unlimited"))
    assert out["depth"] == DEPTH_DEFAULT
    assert out["budget"]["limit"] == DEPTH_BUDGETS["quick"]["limit"]


def test_deep_depth_reports_its_actual_body_budget() -> None:
    calls: list[str] = []
    out = asyncio.run(run_world_answer("跑馬地 東門 阿晴 228", llm_call=_canned_llm(calls),
                                       depth="deep"))
    assert out["depth"] == "deep"
    budget = out["budget"]
    assert budget["limit"] == DEPTH_BUDGETS["deep"]["limit"]
    assert budget["chunk_chars"] == DEPTH_BUDGETS["deep"]["chunk_chars"]
    assert budget["body_chars"] > 0
    assert len(calls) == 1


class _FakeRouter:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def run(self, req: Any) -> Any:
        self.prompts.append(str(req.prompt))
        return type("Call", (), {"response": LLMResponse(
            text='{"answer": "寫在這裡", "confidence": "high"}',
            provider="fake", model="fake-1", degraded=False,
            prompt_tokens=2000, completion_tokens=40, cached_tokens=1800,
            cache_reported=True, cost_usd=0.001, latency_ms=10,
        )})()


def _client() -> tuple[TestClient, _FakeRouter]:
    fake = _FakeRouter()
    app = app_mod.create_app()
    deps = app.state.deps
    deps.router = lambda: fake
    # Non-mock settings so the route reaches the model instead of degrading.
    from dataclasses import replace
    deps.settings = replace(deps.settings, llm_provider="openai")
    return TestClient(app), fake


def test_route_passes_depth_and_exposes_measured_cache() -> None:
    client, fake = _client()
    r = client.post("/ai/v1/world/answer", json={"query": "東門 那匹馬", "depth": "deep"})
    assert r.status_code == 200
    body = r.json()
    assert body["depth"] == "deep"
    assert body["budget"]["body_chars"] > 0
    assert body["measured"]["cached_tokens"] == 1800
    assert body["measured"]["cache_reported"] is True


def test_route_invented_depth_never_reaches_the_model_as_trust() -> None:
    client, fake = _client()
    r = client.post("/ai/v1/world/answer", json={"query": "東門 那匹馬", "depth": "all"})  # not "deep"
    assert r.status_code == 200
    assert r.json()["depth"] == DEPTH_DEFAULT
    assert re.search(r"EXCERPTS", fake.prompts[-1])
