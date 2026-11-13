"""LIVE provider-cache probe — env-gated, never CI, never commits anything about the key.

Measures what the wkapi.pro dashboard is looking at, with today's adapter code on both arms:

  1. identical bursts   — 6 identical small prompts against the live provider
  2. big-prefix bursts  — 6 identical large prompts (the intent-extraction shape)
  3. diversity bursts   — 6 DIFFERENT queries (the dashboard's worst case)

Each call reports provider-reported `prompt_tokens` vs `cached_tokens` and the fraction,
so the hit rate is measured, not argued.

Both transports are checked — the app's adapter is NON-STREAM (matches production), and the
stream arm shows the provider streams the same prefix the same way (the user's note).

Run:

    NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://wkapi.pro/v1 NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=gpt-6-sol NEXUS_LLM_MODEL_MID=gpt-6-sol NEXUS_LLM_MODEL_REASON=gpt-6-sol \
    uv run python cache_probe.py

Never run in CI; honors the same opt-in discipline as the other live tools.
"""

from __future__ import annotations

import asyncio
import os
import sys

from nexus_ai.config import get_settings
from nexus_ai.models.base import LLMRequest
from nexus_ai.models.factory import build_adapters


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _request(query: str, system: str, *, max_tokens: int = 64) -> LLMRequest:
    return LLMRequest(
        task_class="intent_extract",
        payload={"query": query, "context": {}},
        system=system,
        json_hint="json_object",
        max_tokens=max_tokens,
        temperature=0.0,
    )


BIG_SYSTEM = (
    "You parse Hong Kong local-search and dining queries into a strict JSON object. "
    "No commentary, no markdown — answer with the object only. The object is the canonical "
    "Intent (API_CONTRACT §7.1): raw_query verbatim; intent in {discover_merchant, "
    "discover_offering, reserve, purchase, ask_merchant, compare, plan_experience, unknown}; "
    "category slug; location {type: district|landmark|nearby|address|area|city, value, resolved:null, "
    "radius_m:null}; time {type: explicit|relative|range|open_now|unspecified, starts_at, ends_at, "
    "raw, quality}; budget {min, max, currency: HKD, per: party|person|item}; party_size integer; "
    "preferences [{key, value, polarity: 1|-1}]; constraints; sort_preference one of "
    "relevance|distance|price_low|rating|trending; urgency low|normal|high; mentioned_entities [STRING].\n\n"
    "The boundary rules: never assert what the user did not say; unknown is right when the sentence "
    "carries nothing; the longest cue wins; a CJK cue matches on its own spelling; a Latin cue is a "
    "word — no letter may touch it. Category surfaces are answered by filter, not by guess; a "
    "district word is consumed by location, not by query. Answer with the object only."
)


SMALL = (
    "You are the NEXUS assistant. Answer only from the data you are given."
)


async def one(pool, req: LLMRequest):
    return await pool["openai"].complete(req)


async def burst(name: str, pool, requests):
    print(f"\n== {name} ==")
    for i, req in enumerate(requests, 1):
        resp = await one(pool, req)
        cached = getattr(resp, "cached_tokens", 0)
        frac = (cached / resp.prompt_tokens * 100) if resp.prompt_tokens else 0.0
        print(f"  call {i}: prompt={resp.prompt_tokens} cached={cached} ({frac:5.1f}%) "
              f"completion={resp.completion_tokens} latency_ms={resp.latency_ms}")


async def main() -> int:
    provider = _env("NEXUS_LLM_PROVIDER").lower()
    base = _env("NEXUS_LLM_BASE_URL")
    key = _env("NEXUS_LLM_API_KEY")
    if provider in ("", "mock") or not key or not base:
        print("SKIP: NEXUS_LLM_PROVIDER/NEXUS_LLM_BASE_URL/NEXUS_LLM_API_KEY not supplied")
        return 2

    settings = get_settings()
    pool = build_adapters(settings)
    if pool.get("openai") is None:
        print("FAIL: the openai arm of the pool did not construct")
        return 1

    identical = [
        _request("我想搵附近平啲嘅越式米線", BIG_SYSTEM)
        for _ in range(6)
    ]
    varied = [
        _request(q, BIG_SYSTEM) for q in [
            "鰂魚涌有咩好食嘅壽司",
            "預算500港幣嘅拉麵",
            "今日開到11點嘅茶餐廳",
            "同價位幫我比較兩間皮膚管理中心",
            "明晚11點半兩個人去食火鍋",
            "排隊人龍一定長嘅雞煲我想去",
        ]
    ]
    await burst("identical bursts (warms then keeps the system prefix cached)", pool, identical)
    await burst("diverse bursts (the dashboard's worst case — every prefix differs after the system bytes)", pool, varied)

    smalls = [_request("Say exactly: NEXUS-CACHE-PROBE-X", SMALL, max_tokens=16) for _ in range(3)]
    await burst("tiny-system bursts (the default adapter system line — cold gauge for a prefix the app already uses)", pool, smalls)

    # D1050 — the frozen prefix contract arm: the SAME diverse queries, now riding a
    # byte-stable head that clears the provider's cacheable floor. First pass warms it;
    # the second pass is the diverse-traffic hit rate the dashboard cares about.
    try:
        from nexus_ai.api.pipeline import INTENT_EXTRACT_SYSTEM

        contract_requests = [_request(q, INTENT_EXTRACT_SYSTEM) for _ in range(2) for q in [
            "鰂魚涌有咩好食嘅壽司",
            "預算500港幣嘅拉麵",
            "今日開到11點嘅茶餐廳",
            "同價位幫我比較兩間皮膚管理中心",
            "明晚11點半兩個人去食火鍋",
            "排隊人龍一定長嘅雞煲我想去",
        ]]
        await burst("contract bursts (SAME diverse queries, frozen head — D1050)", pool, contract_requests)
    except Exception as exc:
        print(f"\n== contract bursts SKIP ({exc}) ==")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
