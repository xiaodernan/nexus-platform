"""The `rag_faithfulness_v1` suite: is every claim in the generated copy backed by a fact?

AGENT_CONTRACT §4 and §72 make this the product's central quality gate:

> "LLM output is post-validated: every numeric/entity claim in generated text is matched
> back to retrieved facts; unmatched claims are stripped and counted in
> `hallucination_rate`. This is the single most important quality gate in the product."

**Containment and false positives, in one file.** A faithfulness suite that measures only
"fabrications get caught" is a scanner that flags every merchant description — it contains
nothing. And a suite that measures only "grounded copy passes" is a gate that passes as long
as nothing is ever demanded of it. So the file carries both directly:

* `grounded` — answers written FROM the facts in the case (Hong Kong copy in both scripts,
  prices in HK$/港幣, ratings, distances, minutes, counts, the caller's own budget). The
  verifier must find every claim; a fabricated flag here is a product bug the same way an
  injection false positive is.
* `fabricated` — answers with at least one invented number/entity against the same facts.
  The verifier must catch them (`verified: False`, and `hallucination_count >= 1`).

The case file is DATA (`data/rag_faithfulness_v1.jsonl`): one JSON object per line, with
`kind` either `grounded` or `fabricated`, and `expect: {"verified": bool}`.
"""

from __future__ import annotations

from typing import Any

from nexus_ai.eval.suites import Gate, SuiteResult, load_cases, rate

SUITE = "rag_faithfulness_v1"

#: AGENT_CONTRACT §72 names the hallucination bound a release gate: below 2%.
#: Measured per grounded case and pooled — a suite where the one shipped answer class is
#: 2.01% wrong is a suite failing its contract, not a rounding error.
HALLUCINATION_CEILING = 0.02
#: The gate the contract names for the fabricated half: every invented claim is caught.
FABRICATION_FLOOR = 1.0


def _bundle(case: dict[str, Any]):
    from nexus_ai.trust.facts import FactBundle

    bundle = FactBundle()
    for row in case.get("facts") or []:
        attribute, value = row[0], row[1]
        bundle.synth(subject_type="merchant", subject_id=f"m-{case['id']}",
                     attribute=str(attribute), value=value)
    return bundle


def run(cases: list[dict[str, Any]] | None = None) -> SuiteResult:
    """Measure faithfulness. The verifier is pure text-in / claims-out: no model, no network."""
    from nexus_ai.trust.verification import verify_generated_text

    cases = cases if cases is not None else load_cases(SUITE)
    result = SuiteResult(name=SUITE, cases=len(cases))

    grounded = [c for c in cases if c.get("kind") == "grounded"]
    fabricated = [c for c in cases if c.get("kind") == "fabricated"]

    grounded_ok = 0
    grounded_claims = 0
    grounded_hallucinated = 0
    for case in grounded:
        report = verify_generated_text(str(case.get("answer") or ""), _bundle(case),
                                       extra_numbers=case.get("extra_numbers") or [],
                                       entities=case.get("entities") or [],
                                       records=case.get("records") or [],
                                       strip=False)
        claims = len(report.claims)
        grounded_claims += claims
        grounded_hallucinated += report.hallucination_count
        expect = (case.get("expect") or {}).get("verified", True)
        if report.verified != expect:
            result.failures.append(
                f"{case.get('id')}: grounded answer not verified "
                f"(ungrounded={[c.text for c in report.stripped]})")
        else:
            grounded_ok += 1
            result.passed += 1

    fabricated_ok = 0
    fabricated_claims = 0
    fabricated_hallucinated = 0
    for case in fabricated:
        report = verify_generated_text(str(case.get("answer") or ""), _bundle(case),
                                       extra_numbers=case.get("extra_numbers") or [],
                                       entities=case.get("entities") or [],
                                       records=case.get("records") or [],
                                       strip=False)
        fabricated_claims += len(report.claims)
        fabricated_hallucinated += report.hallucination_count
        expect = (case.get("expect") or {}).get("verified", False)
        if report.verified != expect:
            result.failures.append(
                f"{case.get('id')}: fabricated answer verified clean "
                f"— the verifier caught nothing: {case.get('answer')!r}")
        else:
            fabricated_ok += 1
            result.passed += 1

    hallucination_rate = rate(grounded_hallucinated, grounded_claims)
    fabrication_detection = rate(fabricated_ok, len(fabricated))
    result.metrics["faithful_answers_verified"] = rate(grounded_ok, len(grounded))
    result.metrics["fabrication_detection"] = fabrication_detection
    result.metrics["hallucination_rate"] = hallucination_rate
    result.metrics["grounded_claims"] = float(grounded_claims)
    result.metrics["grounded_hallucinated"] = float(grounded_hallucinated)
    result.metrics["grounded_cases"] = float(len(grounded))
    result.metrics["fabricated_cases"] = float(len(fabricated))
    result.metrics["fabricated_hallucinated_claims"] = float(fabricated_hallucinated)
    result.metrics["fabricated_claims_total"] = float(fabricated_claims)
    result.gates = [
        Gate(name="faithful_answers_verified", metric="faithful_answers_verified",
             comparator=">=", threshold=FABRICATION_FLOOR,
             value=result.metrics["faithful_answers_verified"],
             detail=f"{grounded_ok}/{len(grounded)} grounded answers verified clean"),
        Gate(name="fabrication_detection", metric="fabrication_detection",
             comparator=">=", threshold=FABRICATION_FLOOR,
             value=fabrication_detection,
             detail=f"{fabricated_ok}/{len(fabricated)} fabricated answers caught"),
        Gate(name="answer_hallucination_rate", metric="hallucination_rate",
             comparator="<=", threshold=HALLUCINATION_CEILING,
             value=hallucination_rate,
             detail=f"{grounded_hallucinated}/{grounded_claims} grounded claims ungrounded"),
    ]
    return result
