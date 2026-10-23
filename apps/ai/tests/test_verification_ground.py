"""Contract tests for the claim-verification ground set (``trust/verification.py``, §4/§72).

`extract_claims` and the renderer gate are pinned by ``test_verification.py``; this file pins the
pieces they stand on: `normalize_entity`, `build_ground_set` (facts + request numbers + records),
`GroundSet.find`'s per-kind tolerances, and `verify_text`'s strip/no-strip behaviour. Pure and
DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.trust.verification as V


def _claim(kind: str, *, value=None, norm=None) -> V.Claim:
    return V.Claim(kind=kind, text="", start=0, end=0, value=value, norm=norm)


class TestNormalizeEntity:
    def test_strips_quotes_and_lowercases(self):
        assert V.normalize_entity("「龍苑 Kitchen」") == "龍苑 kitchen"

    def test_collapses_whitespace(self):
        assert V.normalize_entity("  A   B  ") == "a b"

    def test_strips_parentheses(self):
        assert V.normalize_entity("(X)") == "x"

    def test_empty(self):
        assert V.normalize_entity("") == ""


class TestBuildGroundSet:
    def test_request_numbers_and_entities(self):
        gs = V.build_ground_set(None, extra_numbers=[320], entities=["龍苑"],
                                extra_strings=["18:30"])
        assert (320.0, "request", None) in gs.numbers
        assert "龍苑" in gs.entities
        assert "18:30" in gs.strings
        assert 1110 in gs.times  # 18:30 as minute-of-day

    def test_records_contribute_numbers_and_entities(self):
        gs = V.build_ground_set(None, records=[{"display_name": "Ramen House",
                                                "avg_price_hkd": 120}])
        assert (120.0, "avg_price_hkd", None) in gs.numbers
        assert "ramen house" in gs.entities


class TestGroundSetFind:
    def test_money_within_tolerance(self):
        gs = V.build_ground_set(None, extra_numbers=[320])
        assert gs.find(_claim(V.MONEY_KIND, value=320)) == (True, None, 320.0)

    def test_money_far_off_is_ungrounded(self):
        gs = V.build_ground_set(None, extra_numbers=[320])
        assert gs.find(_claim(V.MONEY_KIND, value=500)) == (False, None, None)

    def test_rating_tolerance_is_tight(self):
        gs = V.build_ground_set(None, extra_numbers=[4.6])
        assert gs.find(_claim(V.RATING_KIND, value=4.65)) == (True, None, 4.6)
        assert gs.find(_claim(V.RATING_KIND, value=4.8)) == (False, None, None)

    def test_count_is_exact(self):
        gs = V.build_ground_set(None, extra_numbers=[3])
        assert gs.find(_claim(V.COUNT_KIND, value=3)) == (True, None, 3.0)
        assert gs.find(_claim(V.COUNT_KIND, value=4)) == (False, None, None)

    def test_entity_match(self):
        gs = V.build_ground_set(None, records=[{"display_name": "Ramen House"}])
        assert gs.find(_claim(V.ENTITY_KIND, norm="ramen house")) == (True, None, "ramen house")
        assert gs.find(_claim(V.ENTITY_KIND, norm="nope")) == (False, None, None)

    def test_time_match(self):
        gs = V.build_ground_set(None, extra_strings=["18:30"])
        assert gs.find(_claim(V.TIME_KIND, norm="18:30", value=1110)) == (True, None, "18:30")


class TestVerifyText:
    def test_all_grounded_is_not_stripped(self):
        gs = V.build_ground_set(None, extra_numbers=[320, 4.6])
        r = V.verify_text("Price HK$320, rating 4.6", gs)
        assert r.claim_count == 2
        assert r.grounded_count == 2
        assert r.text == "Price HK$320, rating 4.6"
        assert r.verified is True
        assert r.hallucination_count == 0
        assert r.note is None

    def test_fabricated_claim_is_stripped(self):
        gs = V.build_ground_set(None, extra_numbers=[320])
        r = V.verify_text("Price HK$500", gs)
        assert r.claim_count == 1
        assert r.hallucination_count == 1
        assert r.hallucination_rate == 1.0
        assert r.verified is False
        assert r.note == "ungrounded_claims_stripped"
        assert "500" not in r.text

    def test_strip_false_keeps_the_text_but_reports_it(self):
        gs = V.build_ground_set(None, extra_numbers=[320])
        r = V.verify_text("Price HK$500", gs, strip=False)
        assert r.text == "Price HK$500"
        assert len(r.stripped) == 1

    def test_no_claims_means_zero_rate(self):
        gs = V.build_ground_set(None)
        r = V.verify_text("A pleasant place.", gs)
        assert r.claim_count == 0
        assert r.hallucination_rate == 0.0
        assert r.ok is True
