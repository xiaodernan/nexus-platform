"""LIVE latency-on-cache probe — env-gated, never CI, never commits anything about the key.

Two arms, eight calls, one question: does the provider's cache actually move the *latency* of the
second answer on byte-identical prefixes?

  arm A: 4 different small prompts with the production SSE envelope (as the app serves them)
  arm B: the same 4 prompts again immediately (cache probe, same contract bytes)

Reports per-call `prompt_tokens`, `cached_tokens`, and `latency_ms`; then prints cold vs warm
averaged latency and cached-token share.

Run:

    NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://wkapi.pro/v1 NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=gpt-6-sol NEXUS_LLM_MODEL_MID=gpt-6-sol NEXUS_LLM_MODEL_REASON=gpt-6-sol \
    uv run python cache_latency_probe.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from nexus_ai.config import get_settings
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.factory import build_adapters


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


# A long, byte-identical frozen system line well past the provider's cache floor — the shape the
# pipeline's frozen prefix contract fills (D1050). The user prompt varies per arm so the only cache
# answer that matters is the shared-prefix share.
SYSTEM = (
    "You are a Hong Kong local-search assistant that answers only from supplied tool results. " * 90
).strip()

QUERIES = [
    "沙田最耐食嘅拉麵",
    "中環酒吧有咩高分",
    "旺角抵食茶餐廳推薦",
    "鰂魚涌壽司邊間好食",
]


def _request(query: str) -> LLMRequest:
    return LLMRequest(
        task_class="intent_extract",
        payload={"query": query, "context": {}},
        system=SYSTEM,
        json_hint=None,  # the latency arms carry no json_hint so no refusal can turn a warm arm cold
        max_tokens=16,
        temperature=0.0,
    )


def _report(tag: str, rows):
    pt = sum(r["prompt_tokens"] for r in rows)
    cached = sum(r["cached_tokens"] for r in rows)
    lat_cold = [r["latency_ms"] for r in rows]
    print(f"  {tag:<24} cached={cached}/{pt} ({cached / pt * 100 if pt else 0:.1f}%) "
          f"latencies={lat_cold}")
    return rows


async def main() -> int:
    provider = _env("NEXUS_LLM_PROVIDER").lower()
    key = _env("NEXUS_LLM_API_KEY")
    base = _env("NEXUS_LLM_BASE_URL")
    if provider in ("", "mock") or not key or not base:
        print("SKIP: NEXUS_LLM_PROVIDER/NEXUS_LLM_BASE_URL/NEXUS_LLM_API_KEY not supplied")
        return 2

    settings = get_settings()
    pool = build_adapters(settings)
    if pool.get("openai") is None:
        print("FAIL: the openai arm of the pool did not construct")
        return 1

    cold, warm = [], []
    async def one(req):
        resp = await pool["openai"].complete(req)
        return {"query": req.payload["query"], "prompt_tokens": resp.prompt_tokens,
                "cached_tokens": resp.cached_tokens, "latency_ms": resp.latency_ms}

    print("== cold arm ==")
    for i, q in enumerate(QUERIES, 1):
        row = await one(_request(q))
        cold.append(row)
        print(f"  call {i}: prompt={row['prompt_tokens']} cached={row['cached_tokens']} "
              f"latency={row['latency_ms']}ms")
    print("== warm arm (same queries) ==")
    for i, q in enumerate(QUERIES, 1):
        row = await one(_request(q))
        warm.append(row)
        print(f"  call {i}: prompt={row['prompt_tokens']} cached={row['cached_tokens']} "
              f"latency={row['latency_ms']}ms")

    lat_cold = sum(r["latency_ms"] for r in cold) / len(cold)
    lat_warm = sum(r["latency_ms"] for r in warm) / len(warm)
    print()
    print(f"mean latency cold={lat_cold:.0f}ms  warm={lat_warm:.0f}ms  delta={lat_cold - lat_warm:.0f}ms "
          f"(warm {(lat_cold - lat_warm) / lat_cold * 100 if lat_cold else 0:.1f}% faster)")
    try:
        print(json.dumps({"cold": cold, "warm": warm}, ensure_ascii=False, indent=2))
    except UnicodeEncodeError:
        print(json.dumps({"cold": cold, "warm": warm}, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
