"""Live intent-extraction contract coverage — opt-in, never CI.

Mirrors `apps/ai/eval_live_intent.py` for whoever runs the suite with a live provider exported.
The prompt the app's streaming path feeds the model must keep producing contract JSON; this
module is the in-suite proof that *today's* model still honours it.

Skips everywhere except a run that supplies the provider env. CI stays on the offline mock.
"""

from __future__ import annotations

import asyncio
import json
import os
import re

import pytest

from nexus_ai.config import Settings
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.factory import build_adapters

pytestmark = pytest.mark.live_llm

_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


def _live_env() -> dict[str, str] | None:
    provider = (os.environ.get("NEXUS_LLM_PROVIDER") or "").strip().lower()
    base = (os.environ.get("NEXUS_LLM_BASE_URL") or "").strip()
    key = (os.environ.get("NEXUS_LLM_API_KEY") or "").strip()
    if provider in ("", "mock") or not base or not key:
        return None
    return {"provider": provider, "base_url": base, "api_key": key,
            "cheap": (os.environ.get("NEXUS_LLM_MODEL_CHEAP") or "gpt-6-sol").strip(),
            "mid": (os.environ.get("NEXUS_LLM_MODEL_MID") or "gpt-6-sol").strip(),
            "reason": (os.environ.get("NEXUS_LLM_MODEL_REASON") or "gpt-6-sol").strip()}


def _settings(env: dict[str, str]) -> Settings:
    # The live proxy can be slow; 20s defaults turned this test flaky during its own first run.
    # 120s is the outer envelope for exactly this module; CI never sees it (offline gate).
    return Settings(
        llm_provider=env["provider"], llm_base_url=env["base_url"],
        llm_api_key=env["api_key"], llm_model_cheap=env["cheap"],
        llm_model_mid=env["mid"], llm_model_reason=env["reason"],
        database_url="", internal_token="", embedding_provider="hashing",
        platform_base_url="", request_timeout_s=180.0,
    )


live = _live_env()


@pytest.mark.skipif(live is None,
                    reason="live provider env not supplied — same opt-in as the D1017 gate")
def test_the_model_keeps_the_json_contract_for_a_budget_query():
    from nexus_ai.api import pipeline

    settings = _settings(live or {})
    adapter = build_adapters(settings)[live["provider"]]  # type: ignore[index]
    req = LLMRequest(
        task_class="intent_extract",
        payload={"query": "預算500港幣的拉麵", "context": {}},
        system=pipeline.INTENT_EXTRACT_SYSTEM,
        json_hint="json_object",
        max_tokens=1024,
        temperature=0.0,
    )
    resp = asyncio.run(adapter.complete(req))
    match = _JSON_OBJECT.search((resp.text or "").strip())
    assert match is not None, f"no JSON object in the reply: {resp.text!r}"
    obj = json.loads(match.group(0))
    assert obj.get("intent") == "discover_merchant"
    budget = obj.get("budget") or {}
    assert budget.get("max") == 500


@pytest.mark.skipif(live is None,
                    reason="live provider env not supplied — same opt-in as the D1017 gate")
def test_the_model_answers_unknown_when_the_query_says_nothing():
    from nexus_ai.api import pipeline

    settings = _settings(live or {})
    adapter = build_adapters(settings)[live["provider"]]  # type: ignore[index]
    req = LLMRequest(
        task_class="intent_extract",
        payload={"query": "嗯嗯嗯", "context": {}},
        system=pipeline.INTENT_EXTRACT_SYSTEM,
        json_hint="json_object",
        max_tokens=512,
        temperature=0.0,
    )
    resp = asyncio.run(adapter.complete(req))
    match = _JSON_OBJECT.search((resp.text or "").strip())
    assert match is not None
    obj = json.loads(match.group(0))
    assert obj.get("intent") in {"unknown", "discover_merchant", "plan_experience"}


@pytest.mark.skipif(live is None,
                    reason="live provider env not supplied — same opt-in as the D1017 gate")
def test_the_offline_floor_still_wins_without_the_env(monkeypatch):
    settings = Settings(llm_provider="mock", database_url="", internal_token="",
                        embedding_provider="hashing", platform_base_url="")
    pool = build_adapters(settings)
    assert pool["mock"].name == "mock"
