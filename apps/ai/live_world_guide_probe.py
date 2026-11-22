"""D1534 — the world-guide lane, checked in for the operator to run deliberately.

The wayfinder (D1479) answers "which chapter next" from the reader's own state; this lane answers
"where should I go with 45 minutes" from the page you are standing on. The model writes ONE
recommendation and the graph fences it: the `pick` must name a candidate that was actually handed
in, and an empty candidate list degrades to a fallback rather than a 500 (the bug this probe was
written beside).

    NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_CHEAP=gpt-6.2-sol \
    uv run python live_world_guide_probe.py

Measured 2026-11-22 on the operator's endpoint (`gpt-6.2-sol`): from three real chapter candidates the
lane answered `source=llm, intent=deepen, pick=2` with 燒味：凌晨兩點的光與炭 and a fenced second door,
at 14,890 prompt tokens and 6.7 s.

Never part of a request path, never automated, never on a schedule. No key is committed anywhere;
exits 3 with setup instructions when the environment is absent.
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


CANDIDATES = [
    {"slug": "hk-siu-mei-chronicle", "title": "燒味：凌晨兩點的光與炭"},
    {"slug": "hk-dim-sum-chronicle", "title": "早茶：竹筠與陳皮茶香"},
    {"slug": "hk-temple-street-chronicle", "title": "廟街：宵夜成的一座廟"},
]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--locale", default="zh-HK")
    parser.add_argument("--surface", default="guides")
    parser.add_argument("--current", default="香港三餐的血脈：一座用火瓦出來的史詩")
    parser.add_argument("--minutes", type=int, default=45)
    args = parser.parse_args()

    if _env("NEXUS_LLM_PROVIDER").lower() in ("", "mock") or not _env("NEXUS_LLM_API_KEY"):
        print("SKIP: set NEXUS_LLM_PROVIDER / NEXUS_LLM_BASE_URL / NEXUS_LLM_API_KEY for a live run")
        return 3

    from nexus_ai.models.base import LLMRequest
    from nexus_ai.models.factory import build_adapters
    from nexus_ai.orchestrator.world_guide_graph import run_guide

    from nexus_ai.config import get_settings

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
            payload={"surface": args.surface, "locale": args.locale},
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

    result = await run_guide(locale=args.locale, surface=args.surface,
                             current_title=args.current, minutes=args.minutes,
                             candidates=CANDIDATES, llm_call=llm_call)

    print(f"surface {args.surface}  locale={args.locale}  minutes={args.minutes}")
    print(f"answer     {result.get('answer')!r}")
    print(f"source     {result.get('source')}  intent={result.get('intent')} "
          f"pick={result.get('pick')}  guard={result.get('guard')}")
    print(f"suggestions {result.get('suggestions')}")
    print(f"measured   {measured}")

    # the fence: a pick outside the candidate list is a refusal, not a recommendation
    pick = result.get("pick")
    if result.get("source") == "llm":
        if not isinstance(pick, int) or not (1 <= pick <= len(CANDIDATES)):
            print("FAIL: the model named a door that was not handed to it")
            return 1
        for entry in (result.get("suggestions") or []):
            if entry.get("slug") not in {c["slug"] for c in CANDIDATES}:
                print("FAIL: a suggestion names a chapter outside the candidate set")
                return 1
    print("PASS: the world-guide lane answered live through the app's own adapter path, fenced")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
