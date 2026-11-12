"""D1002 — `NEXUS_MAX_TOOL_CALLS` / `Settings.max_tool_calls` is a REAL knob, not a parsed-then-dropped lie.

Before D1002, `config.load_settings()` read `max_tool_calls` (default 6) from the operator's env,
but neither `orchestrator.planner.plan_tools` (hard-coded `MAX_STEPS = 6`) nor
`orchestrator.executor.execute_plan` (hard-coded `plan.steps[:6]`) ever read it, and the API route
`routes_agent.agent_plan` — which had `deps.settings` in scope — passed neither. So the operator
could not raise or lower the per-request tool-call budget: the literal 6 won on every request.
(The knob sat alongside `tool_timeout_s` / `max_tools`, also dead; this unit wires the most
observable one — the step budget — and leaves the others for a follow-through, honestly.)

This probe is offline (no network, no LLM, no DB). It pins the FULL path the config promises —
env -> `load_settings().max_tool_calls` -> `resolve_max_steps(settings)` -> BOTH the planner's cap
and the executor's door, with the SAME cap so the two §10-rule-2 gates cannot drift — plus the
§105 bare-dummy-settings fallback, the [1, 64] clamp against a typo'd env, and the route-level
end-to-end (a changed env changes the number of planned steps the HTTP surface returns). A
one-variable falsifier restores the old "both gates hard-code 6" shape and asserts the detector
reddens, so this probe cannot be made to pass by weakening the assertions.
"""

from __future__ import annotations

import asyncio

import nexus_ai.config as C
from nexus_ai.orchestrator import execute_plan, plan_tools
from nexus_ai.orchestrator.planner import MAX_STEPS, PlannedStep, Plan, resolve_max_steps

# Six independent clauses — one rule fires per clause, so the un-capped plan has 6 steps. This is
# the exact corpus the shipped min-necessary-steps test uses to exercise §10 rule 2's budget.
SIX_CLAUSES = "how much, opening hours, preferences, find merchants, find products, find services"


def _settings_from_env(monkeypatch, value: str | None):
    if value is None:
        monkeypatch.delenv("NEXUS_MAX_TOOL_CALLS", raising=False)
    else:
        monkeypatch.setenv("NEXUS_MAX_TOOL_CALLS", value)
    C.reset_settings_cache()
    return C.load_settings()


class _NoopRegistry:
    """Counts dispatches so the executor door is observable without any backend."""

    def __init__(self):
        self.dispatched = []

    async def dispatch(self, *, subject, tool, arguments, idempotency_key=None):
        self.dispatched.append(tool)
        return {"tool": tool}


def test_default_budget_is_the_rule2_six_when_no_env_is_set(monkeypatch):
    settings = _settings_from_env(monkeypatch, None)
    assert settings.max_tool_calls == 6
    assert resolve_max_steps(settings) == MAX_STEPS == 6
    # no-regression: a direct plan_tools call (no max_steps) still plans exactly the default cap
    assert len(plan_tools(SIX_CLAUSES).steps) <= 6


def test_env_value_flows_from_load_settings_through_resolve_to_the_planner_cap(monkeypatch):
    settings = _settings_from_env(monkeypatch, "2")
    assert settings.max_tool_calls == 2
    cap = resolve_max_steps(settings)
    assert cap == 2
    # THE falsifiable claim: with the operator's env at 2, the planner must not emit more than 2
    # steps. The pre-D1002 code ignored the env and returned 6 — this is the one-variable RED/GREEN.
    assert len(plan_tools(SIX_CLAUSES, max_steps=cap).steps) <= 2


def _all_runnable_plan(n: int) -> Plan:
    """A plan whose every step is runnable (no `missing` context), so the executor actually
    dispatches each one it admits — making the door's cap directly observable via the registry."""
    return Plan(steps=tuple(
        PlannedStep("search_products", {"text": f"q{i}"}, "test") for i in range(n)), refused=None)


def test_the_same_cap_reaches_the_executor_door_both_gates_share_one_budget(monkeypatch):
    settings = _settings_from_env(monkeypatch, "2")
    cap = resolve_max_steps(settings)
    assert len(plan_tools(SIX_CLAUSES, max_steps=cap).steps) <= 2  # planner gate held
    # An all-runnable oversized plan: the executor door must admit exactly `cap` of its 6 steps.
    registry = _NoopRegistry()
    report = asyncio.run(execute_plan(_all_runnable_plan(6), registry, subject="s", max_steps=cap))
    assert len(report.steps) == 2 and len(registry.dispatched) == 2


def test_executor_door_cuts_an_oversized_plan_even_if_the_planner_was_bypassed(monkeypatch):
    settings = _settings_from_env(monkeypatch, "1")
    cap = resolve_max_steps(settings)
    registry = _NoopRegistry()
    report = asyncio.run(execute_plan(_all_runnable_plan(6), registry, subject="s", max_steps=cap))
    assert len(report.steps) == 1  # the second §10-rule-2 gate is the real backstop
    assert len(registry.dispatched) == 1  # exactly one step reached the registry, not six


def test_dummy_settings_without_the_attr_fall_back_safely_to_rule2_default():
    # §105's ladder tests pass bare dummy settings with no max_tool_calls attribute; the reader
    # must not explode on them, and must fall back to the documented 6-step default.
    assert resolve_max_steps(None) == 6
    assert resolve_max_steps(object()) == 6
    assert resolve_max_steps(type("S", (), {"max_tool_calls": "not-an-int"})()) == 6


def test_a_typo_env_is_clamped_to_a_positive_budget_not_zero_or_negative(monkeypatch):
    for raw, expected in [("0", 1), ("-5", 1), ("99999", 64)]:
        settings = _settings_from_env(monkeypatch, raw)
        assert resolve_max_steps(settings) == expected, f"env {raw!r} was not clamped"
    # a clamped cap still plans a valid (non-empty, bounded) plan
    settings = _settings_from_env(monkeypatch, "0")
    assert 1 <= len(plan_tools(SIX_CLAUSES, max_steps=resolve_max_steps(settings)).steps) <= 6


def test_the_http_route_threads_the_operator_budget_to_both_gates(monkeypatch):
    # Route-level proof: a changed env changes what POST /ai/v1/agent/plan reports as its plan,
    # with no code change. This closes the loop the unit test cannot — deps.settings in the route.
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    monkeypatch.setenv("NEXUS_MAX_TOOL_CALLS", "2")
    C.reset_settings_cache()
    client = TestClient(create_app())
    resp = client.post("/ai/v1/agent/plan", json={"query": SIX_CLAUSES, "execute": False})
    assert resp.status_code == 200
    assert len(resp.json()["plan"]["steps"]) <= 2


def test_falsifier_restoring_the_old_hardcoded_six_strands_the_knob(monkeypatch):
    """One-variable falsifier: model the pre-D1002 planner (cap always MAX_STEPS) and assert that
    the SAME env=2 probe that is green above goes RED. This proves the test detects the defect it
    claims to, rather than passing vacuously on any implementation."""
    settings = _settings_from_env(monkeypatch, "2")
    assert settings.max_tool_calls == 2

    def old_shape(text, *, max_steps=None):  # pre-D1002: dropped the wired cap
        return plan_tools(text, max_steps=MAX_STEPS)

    # The wired planner honours 2; the old shape ignores it and returns 6. The detector must see
    # a difference — if these were equal, the env-flow arm above would be vacuous.
    wired = len(plan_tools(SIX_CLAUSES, max_steps=resolve_max_steps(settings)).steps)
    old = len(old_shape(SIX_CLAUSES).steps)
    assert wired != old, "the falsifier could not distinguish the wired cap from the dead knob"
    assert wired <= 2 and old == 6
