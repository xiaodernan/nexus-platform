"""D1519 — a payload the wire cannot write used to kill the live lane before it was called.

`pipeline.understand` hands the model a context, and the context a caller actually writes carries
`now` as a `datetime`. Two places serialise that payload into the request text —
`HttpLLMAdapter._user_text` (the body the provider reads) and
`llm_response_cache._user_text` (the replay key) — and both called `json.dumps` with no `default`,
so a datetime raised `TypeError`. The pipeline catches every exception from the router and answers
from its deterministic floor, so the symptom was silent and permanent:

    understand("带我去吃緊拉麵", context={"now": ...})
        before -> provider=rules, degraded=True, note=model_unavailable  (the model was never called)
        after  -> provider=openai, degraded=False                          (measured live, see the ledger)

and the live answer is not merely available but BETTER than the floor on the same sentence:
`discover_merchant / ramen / [quiet]` against the rules' `discover_offering / retail / []`.

The fix is one shared writer, `_wire_default`, called from both serialisers. Nothing JSON can
already write takes that path, so the canonical byte-shape — and with it the prefix cache and the
replay key — is unchanged for every payload that worked before; that is pinned below.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from nexus_ai.api import pipeline
from nexus_ai.api.deps import Deps
from nexus_ai.api.llm_response_cache import _user_text as cache_user_text
from nexus_ai.config import Settings
from nexus_ai.models.base import (TASK_MODEL_DEFAULTS, HttpLLMAdapter, LLMRequest,
                                LLMResponse, _wire_default)
from nexus_ai.models.router import RoutedCall


class _Stub:
    def __init__(self, response_data):
        self.last_request = None
        self.response_data = response_data

    def provider_name(self) -> str:
        return "stub-live"

    async def run(self, req, *, meter):
        self.last_request = req
        return RoutedCall(response=LLMResponse(
            text=json.dumps(self.response_data, ensure_ascii=False),
            data=self.response_data, provider="stub-live", model="stub-1",
            task_class=req.task_class, purpose=TASK_MODEL_DEFAULTS[req.task_class]["purpose"],
            prompt_tokens=10, completion_tokens=5, cost_usd=0.0, latency_ms=1,
            degraded=False, finish_reason="stop"), task_class=req.task_class)


def _deps() -> Deps:
    st = Settings(llm_provider="mock", embedding_provider="hashing",
                  database_url="", internal_token="")
    return Deps(st)


def _answer():
    return {"raw_query": "带我去吃緊拉麵", "intent": "discover_merchant",
            "category": "ramen", "language": "zh-HK",
            "confidence": {"intent": 0.9}, "unknowns": [],
            "mentioned_entities": [], "excluded_ids": []}


# ------------------------------------------------------------------ the writer
def test_a_datetime_becomes_its_own_text():
    assert _wire_default(datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)) == "2026-11-05T03:00:00+00:00"


def test_anything_else_becomes_text_rather_than_an_exception():
    # the writer is a WIRE formatter: it never refuses, because refusing is what killed the lane.
    assert _wire_default(object()) is not None


# ------------------------------------------------------------------ both serialisers
def _req(payload):
    return LLMRequest(task_class="intent_extract", payload=payload,
                      system="s", json_hint="json_object")


def test_the_request_body_serialises_a_payload_that_carries_a_clock():
    req = _req({"query": "q", "context": {"now": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}})
    text = HttpLLMAdapter._user_text(req)
    assert "2026-11-05T03:00:00" in text, text


def test_the_replay_key_serialises_the_same_payload():
    req = _req({"query": "q", "context": {"now": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}})
    text = cache_user_text(req)
    assert "2026-11-05T03:00:00" in text, text


def test_a_payload_json_can_already_write_is_byte_identical():
    # the cache and the prefix both key on these bytes; the fix must not move them.
    payload = {"query": "q", "context": {"district": "Central", "n": 2}}
    req = _req(payload)
    assert HttpLLMAdapter._user_text(req) == json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert cache_user_text(req) == HttpLLMAdapter._user_text(req)


# ------------------------------------------------------------------ the lane
def test_a_turn_that_names_a_moment_reaches_the_model():
    deps = _deps()
    stub = _Stub(_answer())
    deps._router = stub
    out = asyncio.run(pipeline.understand(
        "帶我去吃緊拉麵", deps=deps,
        context={"now": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}))
    assert stub.last_request is not None, (
        "the router was never reached - the turn died before the provider was called")
    # the payload the pipeline built carries the caller's clock, so the writers must be able to
    # put it on the wire: this is the leg that ties the lane to the two serialisers.
    assert "2026-11-05T03:00:00" in HttpLLMAdapter._user_text(stub.last_request)
    assert "2026-11-05T03:00:00" in cache_user_text(stub.last_request)
    assert out.provider == "stub-live", (out.provider, out.note)
    assert out.degraded is False
    assert out.intent.category == "ramen", out.intent


def test_the_floor_still_answers_when_the_model_refuses():
    deps = _deps()
    stub = _Stub({"raw_query": "x", "intent": "not_a_kind_at_all"})
    deps._router = stub
    out = asyncio.run(pipeline.understand(
        "带我去吃緊拉麵", deps=deps,
        context={"now": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}))
    assert out.provider == "rules", out.provider
    assert out.degraded is True
