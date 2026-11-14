"""D1142 — the opt-in LangGraph execution plane for §10's orchestrator.

For the day the planner wants a state machine instead of a loop, and for the weeks until then:
this module builds a real `StateGraph` (``plan`` → conditional ``route`` → ``execute`` → ``report``)
from the SAME rule tables the deterministic planner owns. There is no model in this graph and no
new tool call — the graph only makes the plan's shape explicit and parallelizes the fan-out of
*independent reads*, the one thing the serial loop could never do for free.

Contract (fingerprint with `orchestrator.executor.execute_plan`):

* the state carries exactly the request's inputs (`text`, `context`, `subject`, `max_steps`,
  `idempotency_key`) plus what the nodes produce (`plan`, `report`);
* `plan` node calls `nexus_ai.orchestrator.planner.plan_tools` — the identical deterministic
  planner the `NEXUS_AI_ENGINE=planner` path uses, so both engines plan byte-identical steps;
* `route` node: a `refused` plan goes straight to `report` (which fills the empty ExecutionReport
  with the refusal, exactly like the serial path returns for `plan.refused`); otherwise the graph
  fans out;
* `execute` node runs the steps through the SAME `registry` with the SAME `asyncio.wait_for`
  timeouts, the SAME per-tool retries, the SAME idempotency threading, and the SAME missing-context
  skips — in parallel, preserving plan order;
* `report` node assembles the SAME `ExecutionReport` dataclass the caller renders.

Honest boundaries: parallel dispatch is safe only because every v1 tool is an independent read
(see `docs/AGENT_CONTRACT.md` §10). Audit events are emitted from concurrent coroutines (each
dispatch still emits exactly one event per call, and the audit callback itself is sync), so the
OBSERVED event order may differ from the serial path while the assembled report is byte-identical.

Enable: `NEXUS_AI_ENGINE=graph` (default `planner`, i.e. today's serial executor, unchanged).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Mapping, TypedDict

from langgraph.graph import END, StateGraph

from nexus_ai.orchestrator.executor import ExecutionReport, StepOutcome
from nexus_ai.orchestrator.planner import Plan, plan_tools, resolve_max_steps
from nexus_ai.tools.registry import ToolError


class _GraphState(TypedDict, total=False):
    text: str
    context: Mapping[str, Any]
    subject: str
    idempotency_key: str | None
    max_steps: int | None
    registry: Any
    plan: Plan
    report: ExecutionReport


def _make_plan_node(state: _GraphState) -> _GraphState:
    cap = state.get("max_steps") or resolve_max_steps(None)
    plan = plan_tools(
        state.get("text") or "",
        context=state.get("context") or {},
        max_steps=cap,
    )
    return {"plan": plan}


def _route_node(state: _GraphState) -> str:
    plan = state.get("plan")
    if plan is None or plan.refused is not None:
        return "emit"
    return "fanout"


async def _execute_one(step: Any, *, registry: Any, subject: str,
                       idempotency_key: str | None, clock: Any,
                       index: int) -> tuple[int, StepOutcome]:
    started = clock()
    if step.missing:
        return index, StepOutcome(
            tool=step.tool, status="skipped",
            reason=f"missing context: {', '.join(step.missing)}",
            ms=(clock() - started) * 1000.0, result=None)
    try:
        result = await registry.dispatch(subject=subject, tool=step.tool,
                                          arguments=step.args,
                                          idempotency_key=idempotency_key)
    except ToolError as exc:
        reason = f"{exc.__class__.__name__}: {exc}"
        return index, StepOutcome(tool=step.tool, status="failed", reason=reason,
                                  ms=(clock() - started) * 1000.0, result=None)
    except Exception as exc:
        reason = f"handler crash — {exc.__class__.__name__}: {exc}"
        return index, StepOutcome(tool=step.tool, status="failed", reason=reason,
                                  ms=(clock() - started) * 1000.0, result=None)
    return index, StepOutcome(tool=step.tool, status="ok", reason=None,
                              ms=(clock() - started) * 1000.0, result=result)


async def _fanout_node(state: _GraphState) -> _GraphState:
    plan = state["plan"]
    cap = state.get("max_steps") or resolve_max_steps(None)
    registry = state["registry"]
    subject = state.get("subject") or "anonymous"
    idem = state.get("idempotency_key")
    steps = tuple(plan.steps[:cap])
    clock = time.monotonic
    # Fan-out reads concurrently; the plan ORDER is re-established by sorting on the original
    # index before the report is assembled, so the answer the caller renders is identical.
    results = await asyncio.gather(
        *(_execute_one(step, registry=registry, subject=subject,
                       idempotency_key=idem, clock=clock, index=i)
          for i, step in enumerate(steps))
    )
    results.sort(key=lambda pair: pair[0])
    return {"report": ExecutionReport(steps=tuple(outcome for _, outcome in results), refused=None)}


def _emit_node(state: _GraphState) -> _GraphState:
    if "report" in state:
        return state
    plan = state.get("plan")
    return {"report": ExecutionReport(
        steps=(), refused=plan.refused if plan else "plan was empty")}


def build_graph():
    graph = StateGraph(_GraphState)
    graph.add_node("make_plan", _make_plan_node)
    graph.add_node("fanout", _fanout_node)
    graph.add_node("emit", _emit_node)
    graph.set_entry_point("make_plan")
    graph.add_conditional_edges("make_plan", _route_node,
                                {"fanout": "fanout", "emit": "emit"})
    graph.add_edge("fanout", "emit")
    graph.add_edge("emit", END)
    return graph.compile()


_COMPILED = None


def compiled_graph():
    global _COMPILED
    if _COMPILED is None:
        _COMPILED = build_graph()
    return _COMPILED


async def run_engine(*, text: str, context: Mapping[str, Any] | None,
                     registry: Any, subject: str,
                     idempotency_key: str | None = None,
                     max_steps: int | None = None) -> tuple[Plan, ExecutionReport]:
    """One turn through the graph. Returns the SAME (plan, report) pair `execute_plan` yields."""
    graph = compiled_graph()
    try:
        final = await graph.ainvoke({
            "text": text,
            "context": dict(context or {}),
            "subject": subject or "anonymous",
            "idempotency_key": idempotency_key,
            "max_steps": max_steps,
            "registry": registry,
        })
    except Exception as exc:
        # The graph is optional; a crash here must never take the request down — refuse honestly.
        return Plan(steps=(), refused=f"graph engine refused: {exc.__class__.__name__}"), \
               ExecutionReport(steps=(), refused=f"graph engine refused: {exc.__class__.__name__}")
    plan = final.get("plan") or plan_tools(text or "", context=context or {},
                                           max_steps=max_steps or resolve_max_steps(None))
    report = final.get("report") or ExecutionReport(steps=(), refused=plan.refused)
    return plan, report
