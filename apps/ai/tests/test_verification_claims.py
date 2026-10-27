"""Contract tests for the two claim-verification wrappers (``trust/verification``).

`verify_text` (pinned by D511) calls both; this file pins what they themselves promise:
`verify_claims` returns a **new list** holding the **same Claim objects**, which it marks in
place (`grounded`, `fact_id`, `grounded_value`); `extract_and_verify` is extraction then
verification, in document order. Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.trust.verification as V


def _claim(value: float, text: str, start: int) -> V.Claim:
    return V.Claim(kind=V.MONEY_KIND, text=text, start=start, end=start + len(text), value=value)


def _ground() -> V.GroundSet:
    return V.build_ground_set(None, extra_numbers=[320])


class TestVerifyClaims:
    def test_returns_a_new_list_of_the_same_objects(self):
        claims = [_claim(320, "HK$320", 0), _claim(500, "HK$500", 10)]
        out = V.verify_claims(claims, _ground())
        assert out is not claims  # a new list
        assert out[0] is claims[0] and out[1] is claims[1]  # the same objects

    def test_marks_each_claim_in_place(self):
        grounded, fabricated = _claim(320, "HK$320", 0), _claim(500, "HK$500", 10)
        V.verify_claims([grounded, fabricated], _ground())
        assert (grounded.grounded, grounded.grounded_value) == (True, 320.0)
        assert (fabricated.grounded, fabricated.grounded_value) == (False, None)

    def test_a_request_number_has_no_fact_id(self):
        claim = _claim(320, "HK$320", 0)
        V.verify_claims([claim], _ground())
        assert claim.fact_id is None

    def test_empty_list(self):
        assert V.verify_claims([], _ground()) == []


class TestExtractAndVerify:
    def test_extracts_then_verifies(self):
        claims = V.extract_and_verify("Price HK$320", _ground())
        assert [(c.kind, c.grounded, c.value) for c in claims] == [("money", True, 320.0)]

    def test_an_ungrounded_claim_stays_ungrounded(self):
        claims = V.extract_and_verify("Price HK$500", _ground())
        assert claims and all(not c.grounded for c in claims)

    def test_empty_text(self):
        assert V.extract_and_verify("", _ground()) == []
