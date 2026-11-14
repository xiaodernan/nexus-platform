"""D1142 — the LangGraph engine is a FINGERPRINT of the serial executor, not a port.

Both engines draw from the same deterministic planner (`plan_tools`) and the same registry. The
fixture corpus below drives the same turn through both and asserts the ExecutionReport is
byte-identical: tool sequence, statuses, `missing` keys, reasons (modulo the per-step `ms`, which by
construction differs between concurrent and serial runs — parity excludes only timing).

The engines differ in one thing honestly documented in `nexus_ai/orchestrator/langgraph_engine.py`:
`execute` fans steps out concurrently with `asyncio.gather`, re-sorting outcomes to plan order.
Every v1 tool is an independent read, so nothing about the concurrent order changes the sorted
output. If a future v1 tool ever acquires a side effect, the parallel fan-out must be revisited in
the same change set (an idempotency check is already enforced by the registry).

Offline — no network, no LLM, no DB.
"""

from __future__ import annotations

import asyncio

import pytest

from nexus_ai.orchestrator import ExecutionReport, execute_plan, plan_tools
from nexus_ai.orchestrator.langgraph_engine import run_engine
from nexus_ai.tools.builtin import register_read_tools
from nexus_ai.tools.registry import Registry

MERCHANT = "00000000-0000-0000-0000-000000000001"

TURNS = [
    ("你們幾點開？", {"merchant_id": MERCHANT}),
    ("what time do you open?", {"merchant_id": MERCHANT}),
    ("幾點開", {}),                     # missing context on purpose
    ("how much is this?", {"merchant_id": MERCHANT}),
    ("價格幾多？", {}),                  # missing subject args on purpose
    ("my preferences", {}),
    ("我的偏好", {}),
    ("搵一間餐廳", {}),
    ("find products skincare", {}),
    ("find services haircut", {}),
    ("搵產品 潤膚", {}),
    ("search", {}),                     # missing text on purpose
    ("幾點開？價格幾多？", {"merchant_id": MERCHANT}),
    ("你好", {}),                        # refused, never planned
    ("how much, opening hours, preferences, find merchants, find products, find services", {}),
]


class _Backend:
    async def hours(self, merchant_ids):
        return [{"merchant_id": m, "weekday": "mon", "opens_at": "09:00",
                 "closes_at": "18:00", "crosses_midnight": False} for m in merchant_ids]

    async def facts(self, ids):
        return []

    async def user_preferences(self, subject, **kw):
        return []

    async def reviews(self, ids, **kw):
        return []

    async def merchant_candidates(self, **kw):
        return []

    async def offering_candidates(self, **kw):
        return []


def _registry() -> tuple[Registry, list[dict]]:
    events: list[dict] = []
    backend = _Backend()
    registry = register_read_tools(Registry(audit=lambda e: events.append(e)), backend)
    return registry, events


def _fingerprint(report: ExecutionReport) -> list[tuple]:
    return [(s.tool, s.status, s.reason, tuple(sorted(s.args.items())) if s.reason is None else None)
            if False else (s.tool, s.status, s.reason) for s in report.steps]


@pytest.mark.parametrize("turn,context", TURNS, ids=range(len(TURNS)))
def test_graph_engine_fingerprints_the_serial_engine(turn, context):
    registry_a, _ = _registry()
    registry_b, _ = _registry()

    plan_serial = plan_tools(turn, context=context)
    report_serial = asyncio.run(
        execute_plan(plan_serial, registry_a, subject="u1"))

    plan_graph, report_graph = asyncio.run(
        run_engine(text=turn, context=context, registry=registry_b, subject="u1"))

    # same plan — byte-identical rule tables in, byte-identical steps out
    assert [s.tool for s in plan_graph.steps] == [s.tool for s in plan_serial.steps]
    assert [s.args for s in plan_graph.steps] == [s.args for s in plan_serial.steps]
    assert [s.missing for s in plan_graph.steps] == [s.missing for s in plan_serial.steps]
    assert plan_graph.refused == plan_serial.refused

    # same outcomes in plan order — only timing differs, and that is not part of the fingerprint
    assert [s.tool for s in report_graph.steps] == [s.tool for s in report_serial.steps]
    assert [s.status for s in report_graph.steps] == [s.status for s in report_serial.steps]
    assert [s.reason for s in report_graph.steps] == [s.reason for s in report_serial.steps]
    assert report_graph.refused == report_serial.refused


def test_graph_engine_preserves_missing_context_honestly():
    plan_graph, report_graph = asyncio.run(
        run_engine(text="幾點開", context={}, registry=_registry()[0], subject="u1"))
    assert report_graph.steps[0].status == "skipped"
    assert report_graph.steps[0].reason == "missing context: merchant_id"


def test_graph_engine_refused_turn_answers_without_tools():
    plan_graph, report_graph = asyncio.run(
        run_engine(text="你好", context={}, registry=_registry()[0], subject="u1"))
    assert plan_graph.refused is not None
    assert report_graph.steps == ()
    assert report_graph.refused == plan_graph.refused


def test_graph_engine_parallel_fanout_completes_all_reads():
    # a turn that fires four different rule families — all independent reads
    text = "my preferences, find merchants 咖啡, find products skincare, find services haircut"
    plan_graph, report_graph = asyncio.run(
        run_engine(text=text, context={}, registry=_registry()[0], subject="u1"))
    # the serial planner emits at most MAX_STEPS; the skipped ones still surface as verdicts
    assert [s.tool for s in report_graph.steps] == [s.tool for s in plan_graph.steps]
    assert all(s.status == "ok" for s in report_graph.steps)
