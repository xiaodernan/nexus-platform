"""Contract tests for ``nexus_ai.search.service.candidates_from_rows`` — the §4 row→Candidate map.

This pure function turns backend rows (merchant/offering dicts) into ``Candidate`` objects with
relevance, price, distance, availability, sponsorship, personalization and freshness attached. It
is DB-free: pass empty fact/hour/slot maps and a dummy ``FactBundle`` (the parameter is accepted
but not read in the body) and the mapping is fully exercisable offline.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.search.service as S
from nexus_ai.search.ranking import RankingWeights

W = RankingWeights()


def _call(rows, *, plan=None, facts=None, hours=None, slots=None, personalization=None,
          vector_lane=False):
    return S.candidates_from_rows(
        rows,
        plan or S.SearchPlan(party_size=2),
        bundle=None,  # accepted but unused by the body
        facts_by_subject=facts or {},
        hours_by_merchant=hours or {},
        slots_by_merchant=slots or {},
        personalization=personalization or {},
        weights=W,
        vector_lane=vector_lane,
    )


FULL_ROW = {
    "subject_type": "merchant",
    "subject_id": "m1",
    "merchant_id": "m1",
    "kw_score": 0.8,
    "vec_score": 0.4,
    "rating_agg": 4.5,
    "review_count": 10,
    "tenant_mean_rating": 4.0,
    "meters": 120,
    "price_amount": 100,
    "popularity_score": 0.3,
    "attributes": {"sponsored": True},
    "district": "Sha Tin",
    "category_primary": "restaurant",
}


class TestFieldMapping:
    def test_identity_fields(self):
        c = _call([FULL_ROW], vector_lane=True)[0]
        assert c.subject_type == "merchant"
        assert c.subject_id == "m1"
        assert c.merchant_id == "m1"

    def test_relevance_fuses_in_vector_lane(self):
        c = _call([FULL_ROW], vector_lane=True)[0]
        assert c.relevance == 0.94  # max(0.8,0.4) + 0.35*min = 0.94

    def test_relevance_ignores_vec_outside_lane(self):
        c = _call([FULL_ROW], vector_lane=False)[0]
        assert c.relevance == 0.8

    def test_rating_and_tenant_mean(self):
        c = _call([FULL_ROW], vector_lane=True)[0]
        assert c.rating == 4.5
        assert c.rating_count == 10
        assert c.tenant_mean_rating == 4.0

    def test_distance_and_price(self):
        c = _call([FULL_ROW], vector_lane=True)[0]
        assert c.distance_m == 120.0
        assert c.price == 100.0

    def test_sponsored_and_personalization(self):
        c = _call([FULL_ROW], vector_lane=True, personalization={"m1": 0.7})[0]
        assert c.sponsored is True
        assert c.personalization == 0.7

    def test_district_and_category(self):
        c = _call([FULL_ROW], vector_lane=True)[0]
        assert c.district == "Sha Tin"
        assert c.category == "restaurant"


class TestAvailability:
    def test_no_slot_means_no_availability(self):
        assert _call([FULL_ROW], vector_lane=True)[0].availability is None

    def test_enough_capacity_is_available(self):
        c = _call([FULL_ROW], slots={"m1": {"capacity_left": 5}}, vector_lane=True)[0]
        assert c.availability == "available"

    def test_partial_capacity_is_limited(self):
        c = _call([FULL_ROW], slots={"m1": {"capacity_left": 1}}, vector_lane=True)[0]
        assert c.availability == "limited"

    def test_zero_capacity_is_full(self):
        c = _call([FULL_ROW], slots={"m1": {"capacity_left": 0}}, vector_lane=True)[0]
        assert c.availability == "full"


class TestDefaults:
    def test_minimal_row_defaults(self):
        c = _call([{"subject_id": "x1", "id": "x1"}])[0]
        assert c.subject_type == "merchant"
        assert c.merchant_id == "x1"
        assert c.tenant_mean_rating == 3.5  # tenant prior
        assert c.popularity == 0.0
        assert c.relevance == 0.0
        assert c.price is None
        assert c.rating is None
        assert c.rating_count == 0

    def test_merchant_id_falls_back_to_key(self):
        c = _call([{"subject_id": "s1", "merchant_id_key": "mk1"}])[0]
        assert c.merchant_id == "mk1"

    def test_district_falls_back_to_area(self):
        c = _call([{"subject_id": "s1", "area": "Kowloon"}])[0]
        assert c.district == "Kowloon"

    def test_category_falls_back_to_kind(self):
        c = _call([{"subject_id": "s1", "kind": "experience"}])[0]
        assert c.category == "experience"

    def test_open_now_none_without_hours(self):
        assert _call([FULL_ROW], vector_lane=True)[0].open_now is None

    def test_freshness_none_without_facts(self):
        assert _call([FULL_ROW], vector_lane=True)[0].freshness is None

    def test_empty_rows(self):
        assert _call([]) == []


class TestRawShape:
    def test_raw_carries_provenance(self):
        c = _call([FULL_ROW], vector_lane=True)[0]
        assert set(c.raw) >= {"row", "text_matched", "as_of", "organic_rank",
                              "availability", "open_state", "slot"}
        assert c.raw["organic_rank"] is None
        assert c.raw["row"] is FULL_ROW

    def test_text_matched_reflects_row_flag(self):
        c = _call([dict(FULL_ROW, text_matched=True)], vector_lane=True)[0]
        assert c.raw["text_matched"] is True
