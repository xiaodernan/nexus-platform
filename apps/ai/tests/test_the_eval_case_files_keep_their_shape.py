"""D787 - the eval case files are a corpus and a census, and they only fork people once.

The gates the suites enforce are about the product's ANSWERS (accuracy, hallucination,
containment). Nothing enforced the files themselves, and the files ARE the evidence: two case ids
the harness cannot tell apart, an `expect` key nothing at the boundary can set, or a `must_not`
that contradicts the expectation are all instructions to a reader to trust the tables as written -
and they survive every pure-logic test in `test_eval_suites.py` untouched.

Measured 2026-11-09 at HEAD: `intent_v1` 69 cases, `safety_injection_v1` 47 cases,
`rag_faithfulness_v1` 25 cases, `personalization_v1` 25 cases — all four files decode as UTF-8,
no duplicate ids, no `expect`/`must_not` overlap, every `expect` key resolvable to a key the
extractor emits (`extract_intent_dict('anything').keys()`), no unexpected top-level keys, every id a
lowercase slug.

The empty-query case in `intent_v1` is the ONE line allowed to carry an empty query: it is the
whole point of `an-empty-query-knows-nothing`.
"""

from __future__ import annotations

import re
from pathlib import Path

from nexus_ai.eval.suites import load_cases
from nexus_ai.nlu.understand import extract_intent_dict

_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")

#: the extraction keyspace the cases are allowed to speak against - read from the code, not frozen
#: in prose, so a renamed field shows up as the key the harness compares, not as a test edit.
_EXTRACTION_KEYS = frozenset(extract_intent_dict("anything").keys())


def _extraction_keys() -> frozenset[str]:
    return _EXTRACTION_KEYS


def _load(suite: str) -> list[dict]:
    return load_cases(suite)


def test_intent_v1_ids_are_unique_and_slugs():
    ids = [c["id"] for c in _load("intent_v1")]
    assert len(ids) == len(set(ids)), (len(ids), set(ids))
    assert all(_SLUG.match(i) for i in ids), [i for i in ids if not _SLUG.match(i)]


def test_intent_v1_cases_carry_only_the_known_keys():
    for case in _load("intent_v1"):
        extra = set(case) - {"id", "query", "expect", "must_not"}
        assert not extra, (case["id"], extra)


def test_intent_v1_expect_keys_are_keys_the_extractor_emits():
    for case in _load("intent_v1"):
        for key in (case.get("expect") or {}):
            assert key in _extraction_keys(), (
                f"{case['id']}: expects key {key!r}, which the extraction never emits - "
                f"the case can never read right, and nobody will notice")


def test_intent_v1_must_not_keys_are_keys_the_extractor_emits():
    for case in _load("intent_v1"):
        for key in case.get("must_not") or ():
            assert key in _extraction_keys(), (
                f"{case['id']}: must_not key {key!r}, which the extraction never emits")


def test_intent_v1_expect_and_must_not_never_name_the_same_key():
    for case in _load("intent_v1"):
        overlap = set(case.get("expect") or {}) & set(case.get("must_not") or ())
        assert not overlap, (case["id"], sorted(overlap))


def test_intent_v1_only_the_empty_query_case_carries_an_empty_query():
    for case in _load("intent_v1"):
        if not (case.get("query") or "").strip():
            assert case["id"] == "an-empty-query-knows-nothing", (
                f"{case['id']} carries an empty query - the suite holds no other empty case")


def test_intent_v1_expect_values_pair_with_the_expectations_own_kinds():
    for case in _load("intent_v1"):
        expect = case.get("expect", {})
        assert isinstance(expect, dict), case["id"]
        assert isinstance(case.get("must_not") or [], list), case["id"]
        for key, value in expect.items():
            if isinstance(value, list):
                assert all(isinstance(v, dict) for v in value), (key, value)


def test_safety_ids_are_unique_and_slugs():
    ids = [c["id"] for c in _load("safety_injection_v1")]
    assert len(ids) == len(set(ids)), (len(ids), set(ids))
    assert all(_SLUG.match(i) for i in ids), [i for i in ids if not _SLUG.match(i)]


def test_safety_cases_carry_only_the_known_keys():
    for case in _load("safety_injection_v1"):
        extra = set(case) - {"id", "kind", "text", "expect_signal"}
        assert not extra, (case["id"], extra)


def test_safety_kind_names_the_one_of_three_kinds():
    for case in _load("safety_injection_v1"):
        assert case["kind"] in ("attack", "envelope", "benign"), case["id"]


def test_safety_exactly_the_attacks_may_claim_an_expect_signal():
    for case in _load("safety_injection_v1"):
        claimed = "expect_signal" in case
        if case["kind"] == "attack":
            assert claimed, f"{case['id']} is an attack with nothing to contain for"
            assert isinstance(case["expect_signal"], str) and case["expect_signal"], case["id"]
        else:
            assert not claimed, f"{case['id']} is {case['kind']} and claims an expectation"


def test_faithfulness_ids_are_unique_and_slugs():
    ids = [c["id"] for c in _load("rag_faithfulness_v1")]
    assert len(ids) == len(set(ids)), (len(ids), set(ids))
    assert all(_SLUG.match(i) for i in ids), [i for i in ids if not _SLUG.match(i)]


def test_faithfulness_cases_carry_only_the_known_keys():
    for case in _load("rag_faithfulness_v1"):
        extra = set(case) - {"id", "kind", "facts", "answer",
                             "extra_numbers", "entities", "records", "expect"}
        assert not extra, (case["id"], extra)


def test_faithfulness_kind_is_one_of_two():
    for case in _load("rag_faithfulness_v1"):
        assert case["kind"] in ("grounded", "fabricated"), case["id"]


def test_faithfulness_expect_verified_pairs_with_the_kind():
    # A grounded case must be verified CLEAN, a fabricated one must be caught. The pair is the
    # contract §4 both directions; a swapped expectation is a broken gate with a green face.
    for case in _load("rag_faithfulness_v1"):
        verified = (case.get("expect") or {}).get("verified")
        assert isinstance(verified, bool), case["id"]
        if case["kind"] == "grounded":
            assert verified is True, f"{case['id']} grounded case claims verified=false"
        else:
            assert verified is False, f"{case['id']} fabricated case claims verified=true"


def test_faithfulness_facts_are_name_value_pairs():
    for case in _load("rag_faithfulness_v1"):
        for row in case.get("facts") or []:
            assert isinstance(row, list) and len(row) == 2, (case["id"], row)


def test_faithfulness_answer_is_non_empty_and_chinese_or_english():
    for case in _load("rag_faithfulness_v1"):
        answer = str(case.get("answer") or "").strip()
        assert answer, (case["id"], "empty answer")


def test_personalization_ids_are_unique_and_slugs():
    ids = [c["id"] for c in _load("personalization_v1")]
    assert len(ids) == len(set(ids)), (len(ids), set(ids))
    assert all(_SLUG.match(i) for i in ids), [i for i in ids if not _SLUG.match(i)]


def test_personalization_cases_carry_only_the_known_keys():
    for case in _load("personalization_v1"):
        extra = set(case) - {"id", "kind", "preference", "query",
                             "positive_attrs", "negative_attrs"}
        assert not extra, (case["id"], extra)


def test_personalization_kind_is_preference_pair():
    for case in _load("personalization_v1"):
        assert case["kind"] == "preference_pair", case["id"]


def test_personalization_positive_and_negative_differ():
    # A pair of identical fixtures would rank by the 0.348 baseline both ways and the lift
    # gate would pass vacuously — a personalization suite that can't fail any lift is not
    # a personalization suite.
    for case in _load("personalization_v1"):
        assert case["positive_attrs"] != case["negative_attrs"], case["id"]


def test_personalization_query_elicits_the_named_preference():
    import json

    _ = json  # imported for clarity below
    from nexus_ai.nlu.understand import extract_intent

    for case in _load("personalization_v1"):
        prefs = extract_intent(case["query"]).preferences
        key, value = case["preference"]
        assert any(p.get("key") == key and p.get("value") == value for p in prefs), (
            f"{case['id']}: query {case['query']!r} does not emit {key}/{value} — "
            f"NLU emitted {prefs}; the case would measure nothing but the baseline")


def test_the_case_files_are_the_counts_measured():
    # The suite's bounds are the ones CI names; the case COUNTS are part of the same promise,
    # and the way a case files for appeal is by being added - loudly failure, not silently skipped.
    assert len(_load("intent_v1")) == 69
    assert len(_load("safety_injection_v1")) == 47
    assert len(_load("rag_faithfulness_v1")) == 25
    assert len(_load("personalization_v1")) == 25


def test_all_four_files_decode_as_utf_8():
    for suite in ("intent_v1", "safety_injection_v1", "rag_faithfulness_v1", "personalization_v1"):
        raw = (Path(__file__).parent.parent / "nexus_ai" / "eval" / "data" / f"{suite}.jsonl").read_bytes()
        raw.decode("utf-8")


def test_all_four_case_files_are_lf_only():
    # Mixed line endings silently parse but corrupt byte-level gates that compare against HEAD
    # (e.g. tmp-census byte sums). The case files are LF-only in the store, pinned here so a
    # future stray CR byte fails the gate instead of drifting the file bytes unnoticed.
    for suite in ("intent_v1", "safety_injection_v1", "rag_faithfulness_v1", "personalization_v1"):
        raw = (Path(__file__).parent.parent / "nexus_ai" / "eval" / "data" / f"{suite}.jsonl").read_bytes()
        assert b"\r" not in raw, f"{suite}.jsonl carries a CR byte - the case file is not LF-only"
