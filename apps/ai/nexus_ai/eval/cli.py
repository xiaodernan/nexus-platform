"""The entry point the CI's merge gate calls.

```
python -m nexus_ai.eval.cli --suite intent_v1,safety_injection_v1 --fail-on-gate
```

The output is a report a person can read and a machine can check: per suite the case count,
the metrics, the gates with their bounds, and the cases that failed with the reason. With
`--fail-on-gate` the exit code is 1 when any gate fails or any case fails, which is what
makes the step a gate rather than a print.

`--json` prints the same report as JSON, for a reader that wants to keep it.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from nexus_ai.eval import intent_v1, safety_injection_v1

#: The suites this repository ships, by the name the CI step uses.
SUITES = {
    intent_v1.SUITE: intent_v1.run,
    safety_injection_v1.SUITE: safety_injection_v1.run,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m nexus_ai.eval.cli",
        description="Run the evaluation suites and report their gates.")
    parser.add_argument("--suite", default=",".join(SUITES),
                        help="the suite(s) to run, comma separated (default: all)")
    parser.add_argument("--fail-on-gate", action="store_true",
                        help="exit 1 when a gate or a case fails")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    return parser


def run_suites(names: list[str]) -> list[Any]:
    out = []
    for name in names:
        name = name.strip()
        if not name:
            continue
        runner = SUITES.get(name)
        if runner is None:
            raise SystemExit(
                f"unknown suite {name!r}; the suites this repository ships are: "
                f"{', '.join(sorted(SUITES))}")
        out.append(runner())
    return out


def format_report(results: list[Any]) -> str:
    lines: list[str] = []
    for result in results:
        lines.append(f"suite {result.name}: {result.passed}/{result.cases} cases passed")
        for name, value in result.metrics.items():
            lines.append(f"  metric {name} = {value:.4f}")
        for gate in result.gates:
            lines.append(
                f"  gate  {gate.name}: {gate.metric} {gate.comparator} {gate.threshold} "
                f"-> {gate.value:.4f} [{'PASS' if gate.passed else 'FAIL'}] {gate.detail}")
        for failure in result.failures[:20]:
            lines.append(f"  FAIL  {failure}")
        if len(result.failures) > 20:
            lines.append(f"  ... and {len(result.failures) - 20} more")
        lines.append(f"  => {result.name}: {'PASS' if result.ok else 'FAIL'}")
    ok = all(r.ok for r in results)
    lines.append(f"RESULT: {'PASS' if ok else 'FAIL'} - "
                 f"{len(results)} suite(s), "
                 f"{sum(1 for r in results if not r.ok)} failing")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    names = [n for n in str(args.suite).split(",") if n.strip()]
    results = run_suites(names)
    ok = all(r.ok for r in results)
    if args.json:
        print(json.dumps({"ok": ok,
                          "suites": [r.as_dict() for r in results]},
                         ensure_ascii=False, indent=2))
    else:
        print(format_report(results))
    if args.fail_on_gate and not ok:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
