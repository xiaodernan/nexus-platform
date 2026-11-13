"""LIVE eval of the intent-extraction contract through the operator's model — opt-in, never CI.

The service's streaming path depends on the `INTENT_EXTRACT_SYSTEM` prompt producing a
PARSEABLE JSON object with the contract's shape. The rule floor covers the deterministic
cases; when the model is the primary extractor (the degraded/absent-LLM path), its output is
what reaches validators. Nothing in the repository before this tool asked *today's* model
whether it still honours the contract after a model release, a provider change, or a proxy
upgrade — precisely the silent-rot case an operator switch can introduce.

Run with the live provider env supplied (never commit the key):

    NEXUS_LLM_PROVIDER=openai \
    NEXUS_LLM_BASE_URL=https://YOUR-OPENAI-COMPATIBLE-ENDPOINT/v1 \
    NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=<model> NEXUS_LLM_MODEL_MID=<model> NEXUS_LLM_MODEL_REASON=<model> \
    uv run python eval_live_intent.py

Never runs in CI. Exit 0 when every frozen case holds, 1 when any fails, 2 when the env is not
supplied. Cost ≈ one completion per case × 5 cases; expect a few cents.
If the provider is slow, prefix NEXUS_REQUEST_TIMEOUT_S=180 — the factory reads it.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


CASES = [
    {
        "id": "budget-ramen",
        "query": "預算500港幣的拉麵",
        "require": {"intent": "discover_merchant"},
        "expect_budget_max": 500,
        "expect_category_nonnull": True,
    },
    {
        "id": "location-sushi",
        "query": "鰂魚涌有咩好食嘅壽司",
        "require": {"intent": "discover_merchant"},
        "expect_category_nonnull": True,
        "expect_location_value": "鰂魚涌",
    },
    {
        "id": "reserve-1105",
        "query": "明晚11點半枱要留位",
        "require": {"intent": "reserve"},
    },
    {
        "id": "compare-100",
        "query": "呢兩個同價嘅幫我比較",
        "require": {"intent": "compare"},
    },
    {
        "id": "unknown-never-guesses",
        "query": "嗯嗯嗯",
        "require": {},
        "accept_intent_in": {"unknown", "discover_merchant", "plan_experience"},
    },
]


_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


def main() -> int:
    provider = _env("NEXUS_LLM_PROVIDER").lower()
    key = _env("NEXUS_LLM_API_KEY")
    base = _env("NEXUS_LLM_BASE_URL")
    if provider in ("", "mock") or not key or not base:
        print("SKIP: NEXUS_LLM_PROVIDER/NEXUS_LLM_BASE_URL/NEXUS_LLM_API_KEY are not supplied for a live eval")
        return 2

    from nexus_ai.config import get_settings
    from nexus_ai.models.base import LLMRequest
    from nexus_ai.models.factory import build_adapters

    # Imported lazily: the prompt template is production code; if it moves, the eval says so.
    from nexus_ai.api import pipeline

    settings = get_settings()
    pool = build_adapters(settings)
    live = pool.get(provider)
    if live is None:
        print(f"FAIL: the configured provider {provider!r} did not construct — pool={list(pool)}")
        return 1

    system = getattr(pipeline, "INTENT_EXTRACT_SYSTEM", "")
    if not system:
        print("FAIL: INTENT_EXTRACT_SYSTEM is not exported from nexus_ai.api.pipeline — the eval cannot stay in lock-step with production")
        return 1

    async def one_case(case) -> tuple[str, bool, str]:
        req = LLMRequest(
            task_class="intent_extract",
            payload={"query": case["query"], "context": {}},
            system=system,
            json_hint="json_object",
            max_tokens=1024,
            temperature=0.0,
        )
        try:
            resp = await live.complete(req)
        except Exception as exc:
            return case["id"], False, f"adapter raised {type(exc).__name__}: {exc}"
        text = (resp.text or "").strip()
        match = _JSON_OBJECT.search(text)
        if not match:
            return case["id"], False, f"no JSON object in the reply: {text[:120]!r}"
        try:
            obj = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            return case["id"], False, f"malformed JSON ({exc.msg}): {text[:120]!r}"
        problems: list[str] = []
        for field, want in case.get("require", {}).items():
            got = obj.get(field)
            if got != want:
                problems.append(f"{field}={got!r} != {want!r}")
        if case.get("expect_budget_max") is not None:
            budget = obj.get("budget") or {}
            if not isinstance(budget, dict) or budget.get("max") != case["expect_budget_max"]:
                problems.append(f"budget={budget!r} (expected max={case['expect_budget_max']})")
        if case.get("expect_category_nonnull") and not obj.get("category"):
            problems.append("category is null/absent")
        if case.get("expect_location_value"):
            loc = obj.get("location") or {}
            if not isinstance(loc, dict):
                problems.append("location is not an object")
            elif case["expect_location_value"] not in str(loc.get("value")):
                problems.append(f"location.value={loc.get('value')!r} (expected to hold {case['expect_location_value']!r})")
        accept = case.get("accept_intent_in")
        if accept and obj.get("intent") not in accept:
            problems.append(f"intent={obj.get('intent')!r} not in {sorted(accept)}")
        ok = not problems
        return case["id"], ok, "; ".join(problems) if problems else f"intent={obj.get('intent')!r} category={obj.get('category')!r} cost=${getattr(resp, 'cost_usd', 0):.5f}"

    async def all_cases():
        results = []
        for case in CASES:
            results.append(await one_case(case))
        return results

    results = asyncio.run(all_cases())
    failures = [r for r in results if not r[1]]
    for cid, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'} {cid:28s} {detail}")
    print()
    if failures:
        print(f"RESULT: FAIL — {len(failures)}/{len(results)} intent-extraction contract case(s) broke under the configured provider")
        return 1
    print(f"RESULT: PASS — all {len(results)} intent-extraction contract case(s) answered parseable contract JSON under the configured provider")
    return 0


if __name__ == "__main__":
    sys.exit(main())
