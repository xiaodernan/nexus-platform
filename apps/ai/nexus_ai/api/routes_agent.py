"""POST /ai/v1/agent/plan — §10's first user-reachable agent surface.

The deterministic planner (`nexus_ai.orchestrator.planner`) plans the minimum tools the
turn names; the executor, when `execute=true` (the default), runs them through the one
registry the process holds and returns each step's verdict. Nothing here composes an
answer: the caller renders under `report.answerable` and no other condition, and a
refusal (`plan.refused`) is answered without tools.

Read-only tools only — the planner never emits a side-effect tool, so no idempotency key
is required of the caller. Budget: the planner caps the plan at six steps (§10 rule 2).
The run is recorded to `agent_runs` either way (§10 rule 4) with the executor's real
verdicts in `tool_calls`, or an empty list when the plan was not executed — never a
fabricated one.

Service-to-service surface (§7.0): never called by a browser; the web BFF proxies the
conversation surfaces, not this one.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.encoders import jsonable_encoder

from nexus_ai.api import runs
from nexus_ai.api.degraded import degraded_json
from nexus_ai.contract import AgentPlanRequest
from nexus_ai.orchestrator import execute_plan, plan_tools

log = logging.getLogger("nexus_ai.api.agent")

router = APIRouter()


@router.post("/ai/v1/agent/plan")
async def agent_plan(request: Request, body: AgentPlanRequest):
    deps = request.app.state.deps
    started = time.monotonic()
    run_id = runs.new_id()

    context = body.context.model_dump(exclude_none=True) if body.context else {}
    plan = plan_tools(body.query, context=context)

    report = None
    tool_calls: list[dict[str, Any]] = []
    if body.execute:
        report = await execute_plan(plan, deps.tool_registry(),
                                    subject=body.subject or "anonymous")
        tool_calls = [
            {"tool": step.tool, "status": step.status, "ok": step.status == "ok",
             "reason": step.reason, "ms": round(step.ms, 2)}
            for step in report.steps
        ]

    elapsed_ms = (time.monotonic() - started) * 1000.0
    await runs.record_run(deps, {
        "agent_run_id": run_id, "agent": "agent_plan", "status": "succeeded",
        "provider": "none", "model": None,  # zero-LLM path — the planner is deterministic
        "conversation_id": None, "user_id": None, "tenant_id": deps.tenant_id(),
        "input_summary": body.query[:500],
        "output_summary": (plan.refused or f"{len(plan.steps)} planned, "
                           f"{sum(1 for s in tool_calls if s['ok'])} succeeded")[:500],
        "plan": {"steps": [s.tool for s in plan.steps],
                 "refused": plan.refused,
                 "executed": body.execute},
        "tool_calls": tool_calls,
        "retrieval": [], "fact_ids": [],
        "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0,
        "latency_ms": int(elapsed_ms), "fallback_used": None, "error": None,
        "started_at": None, "finished_at": None,
    })

    degraded = bool(deps.backend_degraded())
    return degraded_json(jsonable_encoder({
        "agent_run_id": run_id,
        "plan": {
            "steps": [
                {"tool": s.tool, "args": dict(s.args), "reason": s.reason,
                 "missing": list(s.missing)}
                for s in plan.steps
            ],
            "refused": plan.refused,
        },
        "report": None if report is None else {
            "steps": [
                {"tool": s.tool, "status": s.status, "reason": s.reason,
                 "ok": s.status == "ok", "ms": round(s.ms, 2),
                 **({"result": s.result} if s.result is not None else {})}
                for s in report.steps
            ],
            "answerable": report.answerable,
            "needs_clarification": list(report.needs_clarification),
        },
        "degraded": degraded,
    }))
