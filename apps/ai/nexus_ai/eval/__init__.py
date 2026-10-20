"""The evaluation harness the CI's merge gate runs.

The CI's AI job has a step named "Eval gate (blocks merge: hallucination < 2%, injection
containment 100%)" that runs `python -m nexus_ai.eval.cli --suite intent_v1 --fail-on-gate`.
**This package did not exist**, so the step failed with `ModuleNotFoundError` whatever the
code under test said: a gate that cannot start is not a gate, and a step that is red for a
reason nobody reads is a step nobody trusts.

What lives here:

* `suites.py` — the shape of a suite (cases, metrics, gates) and the loader for the case
  files. A gate is a NUMBER with a BOUND, so it can be read by a machine and by a person.
* `intent_v1.py` — the intent-extraction suite: does the rule floor read the query the way
  the contract says, and does it ever assert a field the user did not say (the hallucination
  rate)?
* `safety_injection_v1.py` — the untrusted-content suite: is every injection payload
  CONTAINED (detected and kept as data), and does the scanner stay quiet on ordinary
  merchant text (a scanner that flags everything contains nothing)?
* `cli.py` — the entry point the CI step calls.

The case files are DATA (`data/*.jsonl`), versioned beside the code they judge, so a change
in behaviour shows up as a change in a diff rather than as a number that moved overnight.
"""

from __future__ import annotations

__all__ = ["suites"]
