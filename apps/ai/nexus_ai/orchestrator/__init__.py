"""The orchestrator — AGENT_CONTRACT §10's receive → plan → execute loop.

The contract names the loop and the two modules. What shipped here is the half
that can be honest on this plane: a **deterministic planner** (typed steps, min
necessary tools, no LLM improvisation) and an **executor** that runs the plan
through the one dispatch registry the process actually holds
(`nexus_ai.tools.registry`). Nothing here invents an argument, a subject or a
capability that does not exist.
"""

from nexus_ai.orchestrator.executor import ExecutionReport, StepOutcome, execute_plan
from nexus_ai.orchestrator.planner import Plan, PlannedStep, plan_tools

__all__ = [
    "ExecutionReport",
    "Plan",
    "PlannedStep",
    "StepOutcome",
    "execute_plan",
    "plan_tools",
]
