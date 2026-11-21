"""D1527 — the world-answer lane, checked in for the operator to run deliberately.

`/world`'s 世界問答 · 全語料 panel is the deepest model integration in the product: it retrieves the real
chapter bodies (D1514's reader-owned budget — 8x520 for `quick`, 20x1350 for `deep`), hands them to the
model ONCE with a task instruction and JSON mode, and then FENCES the answer — every cited chapter
number must exist in the retrieved set, and a URL in the reply is refused. The model writes; the code
decides what may be shown.

This probe runs that lane through the app's own adapter pool and prints the measurement:

    NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_CHEAP=gpt-6.2-sol \
    uv run python live_world_answer_probe.py --query "香港人夜宵食咩？"

Measured 2026-11-22 on the operator's endpoint (`gpt-6.2-sol`): the deep read put 9,955 characters of
real chapter body in front of the model, the answer cited 【第121章】【第107章】 — both inside the
retrieved set, so the fence passed — at 14,325 prompt tokens and 4.7 s, `degraded=False`.

Never part of a request path, never automated, never on a schedule. No key is committed anywhere;
exits 3 with setup instructions when the environment is not supplied.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", default="\u9999\u6e2f\u4eba\u591c\u5bb5\u98df\u54a9\uff1f")
    parser.add_argument("--locale", default="zh-HK")
    parser.add_argument("--depth", default="deep", choices=["quick", "deep"])
    args = parser.parse_args()

    if _env("NEXUS_LLM_PROVIDER").lower() in ("", "mock") or not _env("NEXUS_LLM_API_KEY"):
        print("SKIP: set NEXUS_LLM_PROVIDER / NEXUS_LLM_BASE_URL / NEXUS_LLM_API_KEY for a live run")
        return 3

    from nexus_ai.models.base import LLMRequest
    from nexus_ai.models.factory import build_adapters
    from nexus_ai.orchestrator.world_answer_graph import run_world_answer

    from nexus_ai.config import get_settings

    # the same settings reader the app uses, so the probe rides the operator's real configuration
    pool = build_adapters(get_settings())
    adapter = pool.get(_env("NEXUS_LLM_PROVIDER").lower())
    if adapter is None:
        print(f"FAIL: no adapter for {_env('NEXUS_LLM_PROVIDER')!r} — pool={list(pool)}")
        return 1

    measured: dict[str, object] = {}

    async def llm_call(system: str, prompt: str, max_tokens: int):
        started = time.perf_counter()
        response = await adapter.complete(LLMRequest(
            task_class="summary",
            payload={"query": args.query, "locale": args.locale},
            system=system, prompt=prompt, max_tokens=int(max_tokens),
            temperature=0.0, json_hint="json_object"))
        measured.clear()
        measured.update({
            "prompt_tokens": int(response.prompt_tokens or 0),
            "completion_tokens": int(response.completion_tokens or 0),
            "cached_tokens": int(response.cached_tokens or 0),
            "cache_reported": bool(response.cache_reported),
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "provider": response.provider, "model": response.model,
        })
        try:
            parsed = json.loads(response.text) if response.text else None
        except Exception:
            parsed = None
        return parsed if isinstance(parsed, dict) else None

    result = await run_world_answer(query=args.query, locale=args.locale,
                                    llm_call=llm_call, depth=args.depth)

    print(f"query   {args.query!r}  locale={args.locale}  depth={args.depth}")
    print(f"answer  {result.get('answer')!r}")
    print(f"chapters {result.get('chapters')}  confidence={result.get('confidence')} "
          f"degraded={result.get('degraded')}  reason={result.get('reason')}")
    print(f"budget  {result.get('budget')}")
    print(f"measured {measured}")
    if result.get("degraded"):
        print("FAIL: the lane degraded — the model never answered or the fence refused it")
        return 1
    print("PASS: the world-answer lane answered live through the app's own adapter path")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
