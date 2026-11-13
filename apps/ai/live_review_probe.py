"""LIVE code-review probe — env-gated, never CI, asks the operator's model to audit the
cache-fixing lane adversarially and answer in strict JSON.

The reviewer sees exactly what the adapter now sends for a few representative payloads and is
told what the harness measured. If the reviewer finds a real defect, print it; if not, say so.
Never run in CI.
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


REVIEW_SYSTEM = (
    "You are a brutally honest senior reviewer for a Hong Kong local-search platform. "
    "You receive a short description of code behaviour and the measurements gathered so far. Your job: "
    "identify ONE real defect or one documented edge the author missed, or state explicitly if nothing "
    "is wrong; do not invent hypothetical weaknesses that do not belong. Reply with strict JSON of the "
    "single most-important issue (or empty issues if truly none): {\"issues\": [{\"where\": string, "
    "\"what\": string, \"impact\": string, \"severity\": \"low|medium|high\"}]}. No commentary, no markdown."
)

REVIEW_PAYLOAD = {
    "what_prompt": (
        "The OpenAI-compatible adapter that used to send requests in the wkapi proxy. The proxy's "
        "dashboard showed low cache hit rate and asymmetry with stream=False calls; the user reported it. "
        "Fix applied: payloads are now serialized with sort_keys=True and fixed separators; responses now "
        "carry usage.prompt_tokens_details.cached_tokens lifted verbatim; an opt-in NEXUS_LLM_STREAM transport "
        "arm exists that is wire-identical to the property but shows as stream to the operator's dashboard. "
        "Measurements: identical-prefix bursts show break-even caching (5/6 cached_pct=100) in 6 quick calls; "
        "diverse inputs show stepwise cache reuse via shared stem bytes. Python's sorted serialization means "
        "the same keys always produce the same prefix; different payload values produce different prefixes."
    ),
    "constraints_you_know": (
        "LLMResponse cannot know the PRICE of cache-hits; the cost discounts are NOT computed from the cache "
        "accounting today; the ledger cannot distinguish cache-hit from full-price; the untrusted usage from "
        "providers gets flagged by sanitize_usage only for completion_tokens plausibility."
    ),
    "task": "Find ONE real defect or consequence the fix misses. If the fix is incomplete in a way that matters,"
           " name it; do not manufacture issues.",
}


async def main() -> int:
    provider = _env("NEXUS_LLM_PROVIDER").lower()
    key = _env("NEXUS_LLM_API_KEY")
    base = _env("NEXUS_LLM_BASE_URL")
    if provider in ("", "mock") or not key or not base:
        print("SKIP: NEXUS_LLM_PROVIDER/NEXUS_LLM_BASE_URL/NEXUS_LLM_API_KEY not supplied")
        return 2

    settings = get_settings()
    pool = build_adapters(settings)
    live = pool.get("openai")
    if live is None:
        print("FAIL: openai arm did not construct")
        return 1

    req = LLMRequest(
        task_class="reason",
        payload=REVIEW_PAYLOAD,
        system=REVIEW_SYSTEM,
        json_hint="json_object",
        max_tokens=1200,
        temperature=0.0,
    )
    resp = await live.complete(req)
    text = (resp.text or "").strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        print(f"FAIL: malformed review (not JSON): {text[:400]!r}")
        return 1
    issues = obj.get("issues") or []
    if not isinstance(issues, list):
        print(f"FAIL: 'issues' is not a list: {issues!r}")
        return 1
    for issue in issues:
        if not isinstance(issue, dict):
            print(f"  (skip non-dict issue: {issue!r})")
            continue
        print(f"  [{issue.get('severity')}] {issue.get('where')}: {issue.get('what')} (impact: {issue.get('impact')})")
    if not issues:
        print("RESULT: PASS — the reviewer found no material missed consequence")
    else:
        print(f"RESULT: NOTED — the reviewer named {len(issues)} item(s)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
