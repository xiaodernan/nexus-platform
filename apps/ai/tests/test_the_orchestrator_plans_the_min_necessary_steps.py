"""D852 - the orchestrator's first honest turn: typed plan, executed through the registry.

AGENT_CONTRACT §10: `receive → classify → build plan (min necessary steps) → execute →
collect`. The planner plans from explicit text triggers and the caller's context only —
an argument it cannot derive is a `missing` key, never a guess, and a turn no rule
matched is refused, never improvised. The executor runs the plan through the same
registry the HTTP layer advertises, so a plan that names a tool the process does not
hold fails as a verdict, not as a crash. §10's cap (max 6 steps) is enforced twice:
at the planner and at the executor door.
"""

from __future__ import annotations

import asyncio

from nexus_ai.orchestrator import ExecutionReport, Plan, PlannedStep, execute_plan, plan_tools
from nexus_ai.tools.builtin import register_read_tools
from nexus_ai.tools.registry import Registry

MERCHANT = "00000000-0000-0000-0000-000000000001"


class TestPlannerHours:
    def test_hours_trigger_with_context(self):
        plan = plan_tools("你們幾點開？", context={"merchant_id": MERCHANT})
        assert [s.tool for s in plan.steps] == ["get_business_hours"]
        assert plan.steps[0].args == {"merchant_id": MERCHANT}
        assert plan.steps[0].missing == ()

    def test_hours_trigger_english(self):
        plan = plan_tools("what time do you open?", context={"merchant_id": MERCHANT})
        assert [s.tool for s in plan.steps] == ["get_business_hours"]

    def test_hours_trigger_without_context_is_missing_not_guessed(self):
        plan = plan_tools("幾點開")
        assert [s.tool for s in plan.steps] == ["get_business_hours"]
        assert plan.steps[0].args == {}
        assert plan.steps[0].missing == ("merchant_id",)

    def test_bare_open_now_is_hours_never_retrieval(self):
        plan = plan_tools("is it open now?", context={"merchant_id": MERCHANT})
        assert [s.tool for s in plan.steps] == ["get_business_hours"]


class TestPlannerPrice:
    def test_price_trigger_with_merchant_context(self):
        plan = plan_tools("how much is this?", context={"merchant_id": MERCHANT})
        assert [s.tool for s in plan.steps] == ["get_price"]
        assert plan.steps[0].args == {"subject_id": MERCHANT, "subject_type": "merchant"}

    def test_price_trigger_with_subject_context(self):
        plan = plan_tools("幾錢啊", context={"subject_id": "offering-1", "subject_type": "offering"})
        assert plan.steps[0].args == {"subject_id": "offering-1", "subject_type": "offering"}

    def test_price_trigger_without_context_names_the_missing_keys(self):
        plan = plan_tools("價格幾多？")
        assert [s.tool for s in plan.steps] == ["get_price"]
        assert set(plan.steps[0].missing) == {"subject_id", "subject_type"}


class TestPlannerPreferences:
    def test_preferences_trigger_needs_no_context(self):
        plan = plan_tools("my preferences")
        assert [s.tool for s in plan.steps] == ["get_user_preferences"]
        assert plan.steps[0].args == {}

    def test_chinese_preferences_trigger(self):
        plan = plan_tools("我的偏好")
        assert [s.tool for s in plan.steps] == ["get_user_preferences"]


class TestPlannerSearch:
    def test_search_merchants_chinese(self):
        plan = plan_tools("搵一間餐廳")
        assert [s.tool for s in plan.steps] == ["search_merchants"]
        assert plan.steps[0].args == {"text": "一間餐廳"}

    def test_search_products_for_a_product_hint(self):
        plan = plan_tools("find products skincare")
        assert [s.tool for s in plan.steps] == ["search_products"]
        assert plan.steps[0].args == {"text": "skincare"}

    def test_search_services_for_a_service_hint(self):
        plan = plan_tools("find services haircut")
        assert [s.tool for s in plan.steps] == ["search_services"]
        assert plan.steps[0].args == {"text": "haircut"}

    def test_search_with_no_query_is_missing_not_fabricated(self):
        plan = plan_tools("search")
        assert [s.tool for s in plan.steps] == ["search_merchants"]
        assert plan.steps[0].missing == ("text",)

    def test_search_products_chinese(self):
        plan = plan_tools("搵產品 潤膚")
        assert [s.tool for s in plan.steps] == ["search_products"]


class TestPlannerRefusalAndBudget:
    def test_greeting_is_refused_never_planned(self):
        plan = plan_tools("你好")
        assert plan.steps == ()
        assert plan.refused is not None

    def test_max_steps_is_six(self):
        plan = plan_tools(
            "how much, opening hours, preferences, find merchants, find products, find services")
        assert len(plan.steps) <= 6

    def test_price_and_hours_in_one_turn_plan_both(self):
        plan = plan_tools("幾點開？價格幾多？", context={"merchant_id": MERCHANT})
        assert [s.tool for s in plan.steps] == ["get_business_hours", "get_price"]


class _Backend:
    async def hours(self, merchant_ids):
        return [{"merchant_id": m, "weekday": "mon", "opens_at": "09:00",
                 "closes_at": "18:00", "crosses_midnight": False} for m in merchant_ids]

    async def facts(self, ids):
        return []

    async def merchant_candidates(self, **kw):
        return []

    async def preference_rows(self, user_id):
        return []


def _registry(**kw):
    events: list[dict] = []
    backend = _Backend()
    registry = register_read_tools(Registry(audit=lambda e: events.append(e), **kw), backend)
    return registry, events


class TestExecutor:
    def test_full_turn_answers_through_the_registry(self):
        registry, events = _registry()
        plan = plan_tools("what time do you open?", context={"merchant_id": MERCHANT})
        report = asyncio.run(execute_plan(plan, registry, subject="u1"))
        assert report.answerable
        assert report.succeeded[0].tool == "get_business_hours"
        assert report.succeeded[0].result["weekly_hours"][0]["merchant_id"] == MERCHANT
        assert events[-1]["outcome"] == "ok"

    def test_a_missing_key_skips_never_guesses(self):
        registry, _ = _registry()
        plan = plan_tools("幾點開")
        report = asyncio.run(execute_plan(plan, registry, subject="u1"))
        assert not report.answerable
        assert report.steps[0].status == "skipped"
        assert "merchant_id" in (report.steps[0].reason or "")
        assert report.needs_clarification == ("merchant_id",)

    def test_refused_turn_executes_nothing(self):
        registry, events = _registry()
        report = asyncio.run(execute_plan(plan_tools("你好"), registry, subject="u1"))
        assert report.refused is not None
        assert report.steps == ()
        assert events == []

    def test_a_denied_tool_is_a_failed_step_never_a_crash(self):
        registry, _ = _registry(permissions=lambda _s: set())
        plan = plan_tools("what time do you open?", context={"merchant_id": MERCHANT})
        report = asyncio.run(execute_plan(plan, registry, subject="u1"))
        assert report.steps[0].status == "failed"
        assert "PermissionDenied" in (report.steps[0].reason or "")
        assert not report.answerable

    def test_an_unknown_tool_is_a_failed_step(self):
        registry, _ = _registry()
        plan = Plan(steps=(PlannedStep("tool_that_does_not_exist", {"text": "x"}, "bogus"),))
        report = asyncio.run(execute_plan(plan, registry, subject="u1"))
        assert report.steps[0].status == "failed"
        assert "UnknownTool" in (report.steps[0].reason or "")

    def test_the_report_carries_verdicts_never_content(self):
        report = asyncio.run(execute_plan(plan_tools("你好"), _registry()[0], subject="u1"))
        assert not hasattr(report, "answer")
        assert isinstance(report, ExecutionReport)
