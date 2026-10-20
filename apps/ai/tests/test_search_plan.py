"""Contract tests for ``nexus_ai.search.service``'s pure request-shaping + row layer.

The async ``search`` orchestrator needs a backend (DB or static fixtures), but the layer around it
is pure and DB-free: ``plan_from_intent`` (§9 — turn an ``Intent`` into a ``SearchPlan``),
``_static_tokens`` / ``_filter_static`` (offline catalogue filtering), and the row helpers
(``_row_price`` / ``_row_sponsored`` / ``_relevance`` / ``_iso`` / ``_num`` / ``_slot_window``).

Every assertion was confirmed against the running module (empirical probe), never guessed.
Where a naive premise was wrong (``extract_intent`` returns an ``IntentExtraction`` whose
``location`` is a dict; ``plan_from_intent`` needs a validated ``contract.Intent``), the premise
was corrected, not the code.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import nexus_ai.search.service as S
from nexus_ai.contract import Intent
from nexus_ai.nlu.understand import extract_intent_dict


def _intent(query: str, **overrides) -> Intent:
    d = extract_intent_dict(query)
    d.update(overrides)
    return Intent.model_validate(d)


class TestStaticTokens:
    def test_cjk_bigrams_plus_full_token(self):
        # Chinese has no spaces; a naive split would miss "沙田餐延"
        assert S._static_tokens("沙田餐延") == ["沙田", "沙田餐延", "田餐", "餐延"]

    def test_latin_whitespace_tokens(self):
        assert S._static_tokens("hello world") == ["hello", "world"]

    def test_empty(self):
        assert S._static_tokens("") == []

    def test_mixed_single_char_cjk_has_no_bigram(self):
        # a lone CJK char (len < 2) yields no bigram, only the token itself
        assert S._static_tokens("a 沙田") == ["a", "沙田"]


class TestRowHelpers:
    def test_price_priority_order(self):
        assert S._row_price({"price_amount": 100}) == 100.0
        assert S._row_price({"avg_price_hkd": 200}) == 200.0
        assert S._row_price({"price_min": 50}) == 50.0
        assert S._row_price({}) is None

    def test_sponsored_from_dict_flags(self):
        assert S._row_sponsored({"attributes": {"sponsored": True}}) is True
        assert S._row_sponsored({"attributes": {"promoted": True}}) is True
        assert S._row_sponsored({}) is False

    def test_sponsored_from_json_string(self):
        assert S._row_sponsored({"attributes": '{"sponsored": true}'}) is True
        # invalid JSON degrades to not-sponsored rather than raising
        assert S._row_sponsored({"attributes": "not json"}) is False

    def test_relevance_ignores_vec_outside_vector_lane(self):
        assert S._relevance({"kw_score": 0.8}, vector_lane=False) == 0.8
        assert S._relevance({"kw_score": 0.8, "vec_score": 0.4}, vector_lane=False) == 0.8

    def test_relevance_fuses_in_vector_lane(self):
        # max(0.8,0.4) + 0.35*min(0.8,0.4) = 0.8 + 0.14 = 0.94
        assert S._relevance({"kw_score": 0.8, "vec_score": 0.4}, vector_lane=True) == 0.94

    def test_iso_datetime_to_z(self):
        assert S._iso(datetime(2026, 1, 1, tzinfo=timezone.utc)) == "2026-01-01T00:00:00Z"

    def test_iso_non_datetime_is_none(self):
        assert S._iso("x") is None

    def test_num_coercion(self):
        assert S._num(None) is None
        assert S._num("3.5") == 3.5
        assert S._num("abc") is None

    def test_slot_window_none_without_at_or_open_now(self):
        assert S._slot_window(S.SearchPlan()) is None

    def test_slot_window_open_now_is_three_hours(self):
        now = datetime(2026, 1, 1, 10, 0, tzinfo=timezone.utc)
        start, end = S._slot_window(S.SearchPlan(open_now=True, now=now))
        assert start == now
        assert end == now + timedelta(hours=3)

    def test_slot_window_around_at(self):
        at = datetime(2026, 1, 1, 18, 0, tzinfo=timezone.utc)
        start, end = S._slot_window(S.SearchPlan(at=at))
        assert start == at - timedelta(minutes=30)
        assert end == at + timedelta(hours=2)


class TestFilterStatic:
    ROWS = [
        {"display_name": "Ramen House", "category_primary": "restaurant",
         "district": "Sha Tin", "avg_price_hkd": 120, "tags": ["ramen"]},
        {"display_name": "Sushi Zen", "category_primary": "restaurant",
         "district": "Central", "avg_price_hkd": 400, "tags": ["sushi"]},
        {"display_name": "Cafe 沙田", "category_primary": "cafe",
         "district": "Sha Tin", "avg_price_hkd": 60, "tags": []},
    ]

    def _rows(self):
        return [dict(r) for r in self.ROWS]

    def test_empty_text_keeps_all(self):
        assert len(S._filter_static(self._rows(), "", {})) == 3

    def test_text_match_filters(self):
        out = S._filter_static(self._rows(), "ramen", {})
        assert [r["display_name"] for r in out] == ["Ramen House"]

    def test_category_filter(self):
        out = S._filter_static(self._rows(), "", {"category": "cafe"})
        assert [r["display_name"] for r in out] == ["Cafe 沙田"]

    def test_max_price_filter(self):
        out = S._filter_static(self._rows(), "", {"max_price": 100})
        assert [r["display_name"] for r in out] == ["Cafe 沙田"]

    def test_district_filter_is_case_insensitive(self):
        out = S._filter_static(self._rows(), "", {"district": "sha tin"})
        assert [r["display_name"] for r in out] == ["Ramen House", "Cafe 沙田"]

    def test_mutation_adds_scoring_fields(self):
        out = S._filter_static(self._rows(), "ramen", {})
        row = out[0]
        # name hit + tag hit: 0.25*1 + 0.4 = 0.65
        assert row["kw_score"] == 0.65
        assert row["subject_type"] == "merchant"
        assert row["vec_score"] == 0.0
        assert row["text_matched"] is True


class TestPlanFromIntent:
    def test_category_district_and_geo_from_resolved(self):
        plan = S.plan_from_intent(_intent("搵尖沙咀餐延"))
        assert plan.filters["category"] == "restaurant"
        assert plan.filters["district"] == "Tsim Sha Tsui"
        # resolved location seeds geo
        assert plan.geo == (22.2988, 114.1722)
        assert plan.subject_types == ("merchant",)

    def test_open_now_false_survives_the_drop_filter(self):
        # only None/""/[]/{} are dropped; False is kept as an explicit signal
        plan = S.plan_from_intent(_intent("搵尖沙咀餐延"))
        assert plan.filters["open_now"] is False

    def test_purchase_intent_maps_to_offering_subject(self):
        plan = S.plan_from_intent(_intent("買嘢"))
        assert plan.subject_types == ("offering",)

    def test_budget_maps_to_plan_fields(self):
        plan = S.plan_from_intent(
            _intent("搵餐延", budget={"max": 300, "per": "party"})
        )
        assert plan.budget_max == 300.0
        assert plan.budget_per == "party"

    def test_urgency_now_sets_open_now(self):
        plan = S.plan_from_intent(_intent("搵餐延", urgency="now"))
        assert plan.open_now is True
        assert plan.filters["open_now"] is True

    def test_cuisine_avoid_becomes_avoid_list(self):
        plan = S.plan_from_intent(
            _intent("搵餐延", constraints=[{"key": "cuisine_avoid", "value": "spicy"}])
        )
        assert plan.avoid == ["spicy"]
        assert plan.filters["avoid"] == ["spicy"]

    def test_intent_none_uses_query_and_geo_dict(self):
        plan = S.plan_from_intent(None, query="hello", geo={"lat": 22.3, "lng": 114.17})
        assert plan.query_text == "hello"
        assert plan.geo == (22.3, 114.17)
        # a supplied geo without an explicit radius defaults to 5000 m
        assert plan.radius_m == 5000

    def test_intent_none_accepts_geo_object(self):
        class G:
            lat = 22.4
            lng = 114.2

        plan = S.plan_from_intent(None, geo=G())
        assert plan.geo == (22.4, 114.2)

    def test_intent_none_passes_filters_through_verbatim(self):
        # with no intent, plan_from_intent returns early and does NOT run the drop-filter
        plan = S.plan_from_intent(None, filters={"category": None, "district": "", "tags": []})
        assert plan.filters == {"category": None, "district": "", "tags": []}

    def test_intent_path_drops_empty_filters(self):
        # the intent path drops None/""/[]/{} values from the final filter set
        plan = S.plan_from_intent(_intent("搵餐延"), filters={"tags": []})
        assert "tags" not in plan.filters
