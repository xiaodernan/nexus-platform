"""The `intent_v1` suite: does the rule floor read the query the way the contract says?

The contract (§7.1, §8) makes two promises about the intent the service extracts from a
user's words:

1. it reads what the user SAID — the category, the budget, the district, the time, the
   preferences, the party size;
2. it never asserts what the user did NOT say — §8 forbids guessing, and the contract's
   `unknowns` list is where "I could not tell" belongs.

The second promise is the one this suite measures as the HALLUCINATION RATE: a case that
asserts a field the query did not carry is a hallucination, and the CI's merge gate holds the
rate below 2%. The first promise is the ACCURACY: the fields the query did carry have to come
out right.

Each case is one line of JSON:

```json
{"id": "budget-500", "query": "預算500港幣的拉麵",
 "expect": {"intent": "discover_merchant", "budget": {"max": 500}},
 "must_not": ["party_size", "location"]}
```

`expect` is a SUBSET match: every key it names has to be right (a nested dict is matched key
by key, a list by containment). `must_not` names the fields the extraction must leave empty —
an empty value there is the whole point of the case.
"""

from __future__ import annotations

from typing import Any

from nexus_ai.eval.suites import Gate, SuiteResult, load_cases, rate

SUITE = "intent_v1"

#: The bounds the CI's merge gate names, in one place so the two cannot drift.
ACCURACY_FLOOR = 0.95
HALLUCINATION_CEILING = 0.02


def _empty(value: Any) -> bool:
    """Whether an extracted field says nothing."""
    return value in (None, {}, [], "", 0)


def _matches(actual: Any, expected: Any) -> bool:
    """Subset match: a dict key by key, a list by containment, anything else by equality."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(k in actual and _matches(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False
        for want in expected:
            if not any(_matches(got, want) for got in actual):
                return False
        return True
    return actual == expected


def run(cases: list[dict[str, Any]] | None = None) -> SuiteResult:
    """Measure the suite. The extraction is the RULE floor: no model, no network."""
    from nexus_ai.nlu.understand import extract_intent_dict

    cases = cases if cases is not None else load_cases(SUITE)
    result = SuiteResult(name=SUITE, cases=len(cases))

    accurate = 0
    hallucinating = 0
    for case in cases:
        query = str(case.get("query") or "")
        extracted = extract_intent_dict(query, case.get("context") or {})
        expect = case.get("expect") or {}
        must_not = case.get("must_not") or []

        wrong = [f"{key}={extracted.get(key)!r} != {want!r}"
                 for key, want in expect.items()
                 if not _matches(extracted.get(key), want)]
        invented = [key for key in must_not if not _empty(extracted.get(key))]

        if wrong:
            accurate += 0
        else:
            accurate += 1
        if invented:
            hallucinating += 1

        if wrong or invented:
            parts = []
            if wrong:
                parts.append("expected " + ", ".join(wrong))
            if invented:
                parts.append("invented " + ", ".join(
                    f"{key}={extracted.get(key)!r}" for key in invented))
            result.failures.append(f"{case.get('id')}: " + "; ".join(parts))
        else:
            result.passed += 1

    result.metrics["accuracy"] = rate(accurate, len(cases))
    result.metrics["hallucination_rate"] = rate(hallucinating, len(cases))
    result.metrics["case_pass_rate"] = rate(result.passed, len(cases))
    result.gates = [
        Gate(name="intent_accuracy", metric="accuracy", comparator=">=",
             threshold=ACCURACY_FLOOR, value=result.metrics["accuracy"],
             detail=f"{accurate}/{len(cases)} cases read the fields the query carried"),
        Gate(name="hallucination_rate", metric="hallucination_rate", comparator="<=",
             threshold=HALLUCINATION_CEILING, value=result.metrics["hallucination_rate"],
             detail=f"{hallucinating}/{len(cases)} cases asserted a field the query did not"),
    ]
    return result
