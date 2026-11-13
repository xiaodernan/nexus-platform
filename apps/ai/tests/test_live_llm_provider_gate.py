"""Live provider coverage for the §10 adapter path — runs only when the operator exports
the key (NEXUS_LLM_PROVIDER+BASE_URL+API_KEY, never committed). Otherwise skipped loud.

CI stays on `mock` by conftest (offline_env); this module is the project's opt-in seam to
ask *today's* model whether it still works — the probe that catches silent provider/model
rot (wkapi at v1, gpt-6-sol answering now).

Re-runs of `apps/ai/live_llm_smoke.py` produce the same proof without pytest; this file is
the in-suite mirror for whoever runs a CI with secrets wired by hand.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.config import Settings
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.factory import build_adapters


def _live_env() -> dict[str, str] | None:
    provider = (os.environ.get("NEXUS_LLM_PROVIDER") or "").strip().lower()
    base = (os.environ.get("NEXUS_LLM_BASE_URL") or "").strip()
    key = (os.environ.get("NEXUS_LLM_API_KEY") or "").strip()
    if provider in ("", "mock") or not base or not key:
        return None
    return {"provider": provider, "base_url": base,
            "api_key": key,
            "cheap": (os.environ.get("NEXUS_LLM_MODEL_CHEAP") or "gpt-6-sol").strip(),
            "mid": (os.environ.get("NEXUS_LLM_MODEL_MID") or "gpt-6-sol").strip(),
            "reason": (os.environ.get("NEXUS_LLM_MODEL_REASON") or "gpt-6-sol").strip()}


live = _live_env()
pytestmark = pytest.mark.live_llm

#: conftest forces mock offline; a caller that wants the live gate opts in by exporting the env
#: BEFORE importing this module and accepts that CI never sees it.


@pytest.mark.skipif(live is None,
                    reason="live provider env not supplied — set NEXUS_LLM_PROVIDER=openai + "
                           "NEXUS_LLM_BASE_URL + NEXUS_LLM_API_KEY (+ MODEL_*) to opt in")
def test_the_configured_provider_answers_a_real_request():
    env = live or {}
    settings = Settings(
        llm_provider=env["provider"],
        llm_base_url=env["base_url"],
        llm_api_key=env["api_key"],
        llm_model_cheap=env["cheap"],
        llm_model_mid=env["mid"],
        llm_model_reason=env["reason"],
        database_url="",
        internal_token="",
        embedding_provider="hashing",
        platform_base_url="",
    )
    adapter = build_adapters(settings)[env["provider"]]
    req = LLMRequest(
        task_class="reason",
        system="Answer with exactly the tokens requested and nothing more.",
        prompt="Say exactly: NEXUS-LLM-LIVE-OK",
        max_tokens=64,
        temperature=0.0,
    )

    import asyncio
    resp = asyncio.run(adapter.complete(req))

    assert resp.provider == "openai"
    assert resp.prompt_tokens > 0
    assert resp.finish_reason in {"stop", "length"}
    assert "NEXUS-LLM-LIVE-OK" in (resp.text or "")


@pytest.mark.skipif(live is None,
                    reason="live provider env not supplied — same opt-in as the first test")
def test_the_pool_still_lands_on_mock_when_nothing_is_configured():
    settings = Settings(llm_provider="mock", database_url="", internal_token="",
                        embedding_provider="hashing", platform_base_url="")
    pool = build_adapters(settings)
    assert pool["mock"].name == "mock"


@pytest.mark.skipif(live is None,
                    reason="live provider env not supplied — same opt-in as the first test")
def test_the_live_gateway_reports_its_latency():
    env = live or {}
    settings = Settings(
        llm_provider=env["provider"], llm_base_url=env["base_url"],
        llm_api_key=env["api_key"], llm_model_cheap=env["cheap"],
        llm_model_mid=env["mid"], llm_model_reason=env["reason"],
        database_url="", internal_token="", embedding_provider="hashing",
        platform_base_url="",
    )
    adapter = build_adapters(settings)[env["provider"]]
    req = LLMRequest(task_class="reason", prompt="Say exactly: NEXUS-LLM-LIVE-OK",
                     max_tokens=64, temperature=0.0)

    import asyncio
    resp = asyncio.run(adapter.complete(req))
    assert resp.latency_ms > 0
