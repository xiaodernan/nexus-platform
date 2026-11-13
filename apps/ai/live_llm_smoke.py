"""LIVE LLM smoke — proves the configured provider adapter REALLY answers through the same
path the app uses (`build_adapters` -> `LLMAdapter.complete`), not through a hand-rolled curl.

Run with any OpenAI-compatible endpoint, never commit the key:

    NEXUS_LLM_PROVIDER=openai \
    NEXUS_LLM_BASE_URL=https://YOUR-OPENAI-COMPATIBLE-ENDPOINT/v1 \
    NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=<model> NEXUS_LLM_MODEL_MID=<model> NEXUS_LLM_MODEL_REASON=<model> \
    uv run python live_llm_smoke.py

Never run in CI: the point is a REAL round trip; conftest forces `mock` and CI stays the
offline verifier of record. This script refuses to claim a live answer it never made.
"""

from __future__ import annotations

import asyncio
import os
import sys


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def main() -> int:
    provider = _env("NEXUS_LLM_PROVIDER").lower()
    key = _env("NEXUS_LLM_API_KEY")
    base = _env("NEXUS_LLM_BASE_URL")
    if provider in ("", "mock") or not key or not base:
        print("SKIP: NEXUS_LLM_PROVIDER/NEXUS_LLM_BASE_URL/NEXUS_LLM_API_KEY are not supplied for a live run")
        return 2

    from nexus_ai.config import get_settings
    from nexus_ai.models.base import LLMRequest
    from nexus_ai.models.factory import build_adapters

    settings = get_settings()
    pool = build_adapters(settings)
    live = pool.get(provider)
    if live is None or live.name != provider:
        print(f"FAIL: the configured provider {provider!r} did not construct — pool={list(pool)}")
        return 1

    req = LLMRequest(
        task_class="reason",
        system="Answer with exactly the tokens requested and nothing more.",
        prompt="Say exactly: NEXUS-LLM-LIVE-OK",
        max_tokens=64,
        temperature=0.0,
    )

    async def _go():
        return await live.complete(req)

    resp = asyncio.run(_go())
    text = (resp.text or "").strip()
    print(f"provider={resp.provider} model={resp.model} latency_ms={resp.latency_ms} "
          f"prompt_tokens={resp.prompt_tokens} completion_tokens={resp.completion_tokens} "
          f"cost_usd={resp.cost_usd} finish_reason={resp.finish_reason}")
    print(f"answer={text[:120]}")
    if not text:
        print("FAIL: empty answer from the configured provider")
        return 1
    if "NEXUS-LLM-LIVE-OK" not in text:
        print(f"FAIL: the provider answered without the asked-for token: {text[:120]}")
        return 1
    print("PASS: the configured provider answered NEXUS-LLM-LIVE-OK through the app's own adapter path")
    return 0


if __name__ == "__main__":
    sys.exit(main())
