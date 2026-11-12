"""D982 — the live intent path actually runs: the model sees a task instruction, JSON mode is asked for, and §7.1's guard holds the rejection line.

Before the pipeline grew `INTENT_EXTRACT_SYSTEM` + `json_hint`, the live provider was asked the
question with no instructions at all, answered as a helpful chatbot, and the §7.1 validator refused
the answer every time — the whole live path produced `degraded: true` forever while looking wired.
This gate pins the two arms that fix made testable without a network or a seeded DB:

* `system` always carries the instruction (the answer never reaches the model cold);
* `json_hint` always asks the provider for JSON (the §7.1 validator is the counterpart);
* a model answer outside the §7.1 schema is refused by the same validator — the floor answers,
  degraded — and the answer's provider never claims to be the live one.
"""

from __future__ import annotations

import asyncio
from typing import Any

from nexus_ai.api import pipeline
from nexus_ai.api.deps import Deps
from nexus_ai.config import Settings
from nexus_ai.models.base import TASK_MODEL_DEFAULTS, LLMResponse
from nexus_ai.models.router import RoutedCall


class _Stub:
    def __init__(self, response_data: Any):
        self.last_request = None
        self.response_data = response_data

    def provider_name(self) -> str:
        return "stub-live"

    async def run(self, req, *, meter):
        self.last_request = req
        return RoutedCall(response=LLMResponse(
            text=__import__("json").dumps(self.response_data, ensure_ascii=False),
            data=self.response_data, provider="stub-live", model="stub-1",
            task_class=req.task_class, purpose=TASK_MODEL_DEFAULTS[req.task_class]["purpose"],
            prompt_tokens=10, completion_tokens=5, cost_usd=0.0, latency_ms=1,
            degraded=False, finish_reason="stop"), task_class=req.task_class)


def _deps() -> Deps:
    st = Settings(llm_provider="mock", embedding_provider="hashing",
                  database_url="", internal_token="")
    return Deps(st)


def _understand(question: str, router_response) -> tuple[Any, _Stub]:
    deps = _deps()
    stub = _Stub(router_response)
    deps._router = stub
    out = asyncio.run(pipeline.understand(question, deps=deps, context={}))
    return out, stub


def test_the_model_sees_instruction_and_json_mode_are_carried():
    out, stub = _understand(
        "something unparseable by rules qqzz",
        {"raw_query": "something unparseable by rules qqzz", "intent": "discover_merchant",
         "category": "ramen", "language": "en",
         "confidence": {"intent": 0.9}, "unknowns": [],
         "mentioned_entities": [], "excluded_ids": []})
    req = stub.last_request
    assert req is not None, "the router was never reached — extraction went straight to the floor"
    assert req.system == pipeline.INTENT_EXTRACT_SYSTEM, (
        "the live model was asked the question with no instructions")
    assert req.json_hint == "json_object", (
        "the live model was not asked for structured output")


def test_a_valid_live_answer_names_the_live_provider():
    out, _stub = _understand(
        "something unparseable by rules qqzz",
        {"raw_query": "something unparseable by rules qqzz", "intent": "discover_merchant",
         "category": "ramen", "language": "en",
         "confidence": {"intent": 0.9}, "unknowns": [],
         "mentioned_entities": [], "excluded_ids": []})
    assert out.provider == "stub-live", out.provider
    assert out.degraded is False


def test_an_invalid_live_answer_is_refused_and_the_floor_answers_degraded():
    out, _stub = _understand(
        "something unparseable by rules qqzz",
        {"raw_query": "something unparseable by rules qqzz", "intent": "not_a_kind_at_all"})
    assert out.provider == "rules", (out.provider, "the floor must answer, never the live label")
    assert out.degraded is True
