"""§10's executor: run a Plan through the one registry that reaches the data.

The pipeline's own audit/log already lives inside the registry's `dispatch`; this
module does not double-log. What it enforces on top:

* a step with missing context is **skipped with the key named** — never guessed,
  never executed;
* a step whose tool the registry does not know, or that it denies, or that fails,
  is recorded as failed with the reason — remaining steps still run (all v1 tools
  are independent reads);
* nothing is composed into an answer here. The report carries each step's verdict
  and payload; the caller renders — an empty answer means the tools said so, never
  a model's improvisation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from nexus_ai.orchestrator.planner import Plan, resolve_max_steps
from nexus_ai.tools.registry import ToolError


@dataclass(frozen=True)
class StepOutcome:
    tool: str
    status: str  # "ok" | "skipped" | "failed"
    reason: str | None
    ms: float
    result: Any | None = None


@dataclass(frozen=True)
class ExecutionReport:
    steps: tuple[StepOutcome, ...] = field(default_factory=tuple)
    refused: str | None = None

    @property
    def answerable(self) -> bool:
        """True when at least one step produced a result — the only honest condition
        under which the caller may render tool-backed content."""
        return any(step.status == "ok" for step in self.steps)

    @property
    def succeeded(self) -> tuple[StepOutcome, ...]:
        return tuple(step for step in self.steps if step.status == "ok")

    @property
    def needs_clarification(self) -> tuple[str, ...]:
        keys: list[str] = []
        for step in self.steps:
            if step.status == "skipped" and step.reason and step.reason.startswith("missing context: "):
                keys.extend(k for k in step.reason.removeprefix("missing context: ").split(", ") if k)
        return tuple(dict.fromkeys(keys))


async def execute_plan(plan: Plan, registry: Any, *, subject: str,
                       idempotency_key: str | None = None,
                       clock: Any = time.monotonic,
                       max_steps: int | None = None) -> ExecutionReport:
    if plan.refused is not None:
        return ExecutionReport(steps=(), refused=plan.refused)

    # D1002: §10 rule 2 is enforced again at the door — with the SAME operator budget the planner
    # used (the two gates must not drift). `resolve_max_steps(None)` is the 6-step default, so
    # direct callers and existing tests keep their behaviour; the route passes settings-derived cap.
    cap = max_steps if max_steps is not None else resolve_max_steps(None)
    outcomes: list[StepOutcome] = []
    for step in plan.steps[:cap]:
        started = clock()
        if step.missing:
            outcomes.append(StepOutcome(
                tool=step.tool, status="skipped",
                reason=f"missing context: {', '.join(step.missing)}",
                ms=(clock() - started) * 1000.0, result=None))
            continue
        try:
            result = await registry.dispatch(subject=subject, tool=step.tool,
                                             arguments=step.args,
                                             idempotency_key=idempotency_key)
        except ToolError as exc:  # the registry's own verdict family — denied/unknown/invalid/failed/timeout
            reason = f"{exc.__class__.__name__}: {exc}"
        except Exception as exc:  # a handler crash: still a verdict, never a 500 here
            reason = f"handler crash — {exc.__class__.__name__}: {exc}"
        else:
            outcomes.append(StepOutcome(
                tool=step.tool, status="ok", reason=None,
                ms=(clock() - started) * 1000.0, result=result))
            continue
        outcomes.append(StepOutcome(
            tool=step.tool, status="failed", reason=reason,
            ms=(clock() - started) * 1000.0, result=None))

    return ExecutionReport(steps=tuple(outcomes), refused=None)
