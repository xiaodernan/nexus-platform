"""The `tool_selection_v1` suite: does a turn plan the tools the contract says it needs?

AGENT_CONTRACT §10 names the planner's duty as *minimum necessary steps*: a greeting
plans nothing, a price question plans the price tool, and a multi-ask turn plans each
ask once. This suite judges `plan_tools` against labelled turns — the full planned
tool sequence (order included; the planner's rule order is deterministic) and the
arguments each planned step carries. Both halves of the contract are judged, because a
planner that names the right tool with a fabricated argument has failed the contract
as surely as one that names the wrong tool.

Honest scope (disclosed in STATUS §852): the cases are authored alongside the planner's
rules — this suite locks behaviour, it does not prove generalisation. Measuring
generalisation needs real traffic, which is the same honest-labels limit the AI lane
declared for `search_relevance_v1`.
"""

from __future__ import annotations

from typing import Any

from nexus_ai.eval.suites import Gate, SuiteResult, load_cases, rate
from nexus_ai.orchestrator import plan_tools

SUITE = "tool_selection_v1"

#: The gate: the whole labelled set, both halves. 0.9 leaves room for a documented
#: borderline case to fail honestly without the suite going green on an empty file.
EXACT_MATCH_FLOOR = 0.9


def run(cases: list[dict[str, Any]] | None = None) -> SuiteResult:
    cases = cases if cases is not None else load_cases(SUITE)
    result = SuiteResult(name=SUITE, cases=len(cases))

    matched = 0
    for case in cases:
        kind = case.get("kind")
        plan = plan_tools(case["text"], context=case.get("context"))
        tools = [s.tool for s in plan.steps]
        expected_tools = list(case["expected_tools"])

        tool_ok = tools == expected_tools
        args_ok = True
        for tool, want in (case.get("expected_args") or {}).items():
            got = next((dict(s.args) for s in plan.steps if s.tool == tool), None)
            if got != want:
                args_ok = False
                result.failures.append(
                    f"{case['id']}: {tool} args {got!r} != expected {want!r}")

        refused_ok = True
        if kind == "refusal":
            refused_ok = plan.refused is not None and not plan.steps
            if not refused_ok:
                result.failures.append(
                    f"{case['id']}: expected a refusal, got plan {tools!r}")
        elif kind == "exact":
            if not tool_ok:
                result.failures.append(
                    f"{case['id']}: planned {tools!r} != expected {expected_tools!r}")
        else:
            refused_ok = False
            result.failures.append(f"{case['id']}: unknown case kind {kind!r}")

        if tool_ok and args_ok and refused_ok:
            matched += 1
            result.passed += 1

    rate_value = rate(matched, len(cases))
    result.metrics["exact_match"] = rate_value
    result.gates.append(Gate(
        name="tool selection exact-match >= 0.9",
        metric="exact_match", comparator=">=", threshold=EXACT_MATCH_FLOOR,
        value=rate_value,
        detail=f"{matched}/{len(cases)} turns planned exactly the expected tools with the expected arguments",
    ))
    return result
