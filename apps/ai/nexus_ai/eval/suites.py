"""The shape of an evaluation suite: cases, metrics, gates.

A suite answers three questions and keeps them apart:

* **did the case pass?** — one case, one verdict, with the reason it failed;
* **what is the metric?** — a number over the whole suite (accuracy, hallucination rate,
  containment);
* **does the gate hold?** — the metric against a bound, stated in the same file as the
  metric so the two cannot drift apart.

The bounds here are the ones the CI's merge gate names: hallucination below 2%, injection
containment 100%. Both are written as bounds rather than as booleans, because "the gate
passed" is a claim a reader cannot check, and "0 of 30 cases hallucinated" is.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: The case files live beside the code, so a behaviour change shows up as a diff.
DATA_DIR = Path(__file__).parent / "data"


@dataclass(frozen=True)
class Gate:
    """One metric against one bound."""

    name: str
    metric: str
    comparator: str
    threshold: float
    value: float
    detail: str = ""

    @property
    def passed(self) -> bool:
        if self.comparator == ">=":
            return self.value >= self.threshold - 1e-9
        if self.comparator == "<=":
            return self.value <= self.threshold + 1e-9
        if self.comparator == "==":
            return abs(self.value - self.threshold) < 1e-9
        raise ValueError(f"unknown comparator {self.comparator!r}")

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "metric": self.metric, "comparator": self.comparator,
                "threshold": self.threshold, "value": self.value, "passed": self.passed,
                "detail": self.detail}


@dataclass
class SuiteResult:
    """What one suite measured."""

    name: str
    cases: int = 0
    passed: int = 0
    failures: list[str] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)
    gates: list[Gate] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures and all(g.passed for g in self.gates)

    def as_dict(self) -> dict[str, Any]:
        return {"suite": self.name, "cases": self.cases, "passed": self.passed,
                "failed": self.cases - self.passed, "ok": self.ok,
                "metrics": {k: round(v, 6) for k, v in self.metrics.items()},
                "gates": [g.as_dict() for g in self.gates],
                "failures": self.failures[:20]}


def load_cases(suite: str) -> list[dict[str, Any]]:
    """The suite's cases, in file order. A missing file is an error, not an empty suite."""
    path = DATA_DIR / f"{suite}.jsonl"
    if not path.exists():
        raise FileNotFoundError(
            f"the case file for suite {suite!r} is missing: {path} - a suite with no cases "
            f"is a suite that passes by having nothing to judge")
    cases: list[dict[str, Any]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{lineno} is not JSON: {exc}") from exc
        if "id" not in case:
            raise ValueError(f"{path}:{lineno} has no id - a case nobody can name is a case "
                             f"nobody can fail")
        cases.append(case)
    if not cases:
        raise ValueError(f"{path} holds no cases")
    return cases


def rate(numerator: int, denominator: int) -> float:
    """A rate with the empty case named rather than hidden: no cases -> 1.0 (nothing failed)."""
    if denominator <= 0:
        return 1.0
    return numerator / denominator
