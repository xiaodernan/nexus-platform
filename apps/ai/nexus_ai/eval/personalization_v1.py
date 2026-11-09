"""The `personalization_v1` suite: does a typed preference lift the merchants it names?

AGENT_CONTRACT §3/§7 (preference lane) — the NLU emits `intent_preferences` like
`ambience/quiet` for "安靜" and `view/scenic` for "海景"; the ranking lane reads them
against the merchant's own attributes and orders merchants by how well the query's typed
preferences hold. A personalization suite that measures only that preferences are produced
("the NLU emitted ambience/quiet") is a parse assertion, not a personalization assertion:
the consumer asks for a quiet place and gets the loud one, and the NLU answered perfectly.

The cases here are pairs. One candidate scores high on the preference's attribute, the
counterpart low; every other attribute is held identical (same category, tags, rating,
district) so the order is decided by the preference lane alone. The runner asserts
that the scorer-ordered candidate set lifts the positive candidate above the negative one.

Case file lines are `preference_pair` records: the preference key and value the NLU
would emit, the query that elicits it, and the two-candidate fixture. Price preferences
are scored on the row's own `avg_price_hkd` column rather than a boolean attribute, so
those cases vary the row price instead. The runner asserts on the scored order only —
a preference that cannot lift its own candidate above a candidate it scores 0.0 on has
not fired.
"""

from __future__ import annotations

import asyncio
from typing import Any

from nexus_ai.eval.suites import Gate, SuiteResult, load_cases, rate

SUITE = "personalization_v1"

#: A preference the user actually typed in must move its positive candidate above the
#: negative one whenever the only varying attribute is the one it reads; anything less is
#: the preference lane being unread.
LIFT_FLOOR = 1.0


def _mk_merchant(subject_id: str, *, category: str, attrs: dict[str, Any],
                 display_name: str, display_name_zh: str) -> dict[str, Any]:
    # The row's own `avg_price_hkd` wins over whatever the attrs dict carries — the
    # `_ROW_FIELDS` fold in the scorer reads it from `attrs` after merging the row back in.
    row_price = float(attrs.get("avg_price_hkd", 120))
    return {
        "subject_id": subject_id,
        "merchant_id": subject_id,
        "subject_type": "merchant",
        "display_name": display_name,
        "display_name_zh": display_name_zh,
        "category_primary": str(attrs.get("category_primary") or category),
        "rating_agg": 4.5,
        "review_count": 30,
        "avg_price_hkd": row_price,
        "tags": [c for c in (str(attrs.get("tags") or "restaurant").split(" "))[:1]],
        "attributes": attrs,
        "data_origin": "demo",
        "images": [],
        "plan": "pro",
        "ai_agent_enabled": True,
    }


def _preference_dicts(ex: Any) -> list[dict[str, Any]]:
    prefs = getattr(ex, "preferences", None) or ()
    return [p.model_dump() if hasattr(p, "model_dump") else dict(p) for p in prefs]


async def _ranked(backend: Any, plan: Any, ex: Any):
    import nexus_ai.search.service as S

    _cards, _resp, _b, scored = await S.search(
        backend=backend, plan=plan, intent_preferences=_preference_dicts(ex))
    return scored


def run(cases: list[dict[str, Any]] | None = None) -> SuiteResult:
    """Measure personalization. No model, no DB, no network — just preference vs ranking."""
    import nexus_ai.search.service as S
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.nlu.understand import extract_intent_dict

    class StaticLikeBackend(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

    cases = cases if cases is not None else load_cases(SUITE)
    result = SuiteResult(name=SUITE, cases=len(cases))

    lifted = 0
    elicited = 0
    for case in cases:
        if case.get("kind") != "preference_pair":
            continue
        positive = {**case["positive_attrs"], "category_primary": "restaurant",
                    "tags": "restaurant"}
        negative = {**case["negative_attrs"], "category_primary": "restaurant",
                    "tags": "restaurant"}
        backend = StaticLikeBackend(merchants=[
            _mk_merchant("m-pos", category="restaurant", attrs=positive,
                         display_name="Positive Kitchen", display_name_zh="正向餐廳"),
            _mk_merchant("m-neg", category="restaurant", attrs=negative,
                         display_name="Negative Kitchen", display_name_zh="反向餐廳"),
        ])
        ex = validate_intent(extract_intent_dict(case["query"]))
        plan = S.plan_from_intent(ex, query=case["query"], limit=10)

        scored = asyncio.run(_ranked(backend, plan, ex))
        by_id = {s.candidate.subject_id: s for s in scored}
        if "m-pos" not in by_id or "m-neg" not in by_id:
            result.failures.append(f"{case['id']}: one candidate disappeared ({list(by_id)})")
            continue
        key, value = case["preference"]
        pref_dicts = _preference_dicts(ex)
        if any(p.get("key") == key and p.get("value") == value for p in pref_dicts):
            elicited += 1
        if by_id["m-pos"].organic_score > by_id["m-neg"].organic_score:
            lifted += 1
            result.passed += 1
        else:
            result.failures.append(
                f"{case['id']}: typed preference did not lift m-pos — "
                f"m-pos {by_id['m-pos'].organic_score:.3f} vs "
                f"m-neg {by_id['m-neg'].organic_score:.3f} "
                f"(preferences={pref_dicts})")

    result.metrics["preference_lift"] = rate(lifted, len(cases))
    result.metrics["preferences_elicited"] = float(elicited)
    result.metrics["preference_cases"] = float(len(cases))
    result.gates = [
        Gate(name="preference_lift", metric="preference_lift", comparator=">=",
             threshold=LIFT_FLOOR, value=result.metrics["preference_lift"],
             detail=f"{lifted}/{len(cases)} typed preferences lifted the positive candidate"),
    ]
    return result
