"""Contract tests for ``nexus_ai.nlu.understand.extract_intent_dict`` — structured resolution.

D341 (§337) already pins the **§8 never-guess / unknowns** contract of this function. This file
pins the *structured extraction* slice D341 did NOT cover: district resolution, category-bucket
extraction, numeric party size, and the `cuisine_avoid` / `diet_avoid` constraint shaping — all
pure, DB-free (the rule engine runs offline).

Every assertion was confirmed against the running module (empirical probe), never guessed.
Where a naive premise was wrong, the premise was corrected, not the code:

* Absent district / time come back as ``{}`` (empty dict), **not** ``None``.
* ``confidence`` is a **dict** (``{intent, category, location}`` floats in [0,1]), not a scalar.
* ``budget`` and ``cuisine`` are deliberately NOT extracted here — they are handled downstream by
  ``nlu/state_merger`` (D352). Asserting them here would encode a wrong contract.
* ``"一个人"`` resolves to ``party_size is None`` (a single diner is not treated as a party), which
  is the honest, non-guessing behavior — pinned as observed, not forced to ``1``.
"""

from __future__ import annotations

import datetime as _dt

import nexus_ai.nlu.understand as U
import nexus_ai.search.categories as C


def _intent(query: str) -> dict:
    return U.extract_intent_dict(query, {})


class TestTopLevelShape:
    def test_required_keys_present(self):
        d = _intent("尖沙咀餐廳")
        for k in (
            "intent",
            "language",
            "confidence",
            "category",
            "location",
            "time",
            "party_size",
            "constraints",
            "unknowns",
            "raw_query",
        ):
            assert k in d

    def test_intent_is_nonempty_string(self):
        assert isinstance(_intent("書店")["intent"], str)
        assert _intent("書店")["intent"]

    def test_confidence_is_dict_of_unit_floats(self):
        conf = _intent("尖沙咀餐廳")["confidence"]
        assert isinstance(conf, dict)
        for v in conf.values():
            assert isinstance(v, float)
            assert 0.0 <= v <= 1.0

    def test_unknowns_is_a_list(self):
        assert isinstance(_intent("餐廳")["unknowns"], list)


class TestDistrictResolution:
    def test_no_district_returns_empty_dict(self):
        # absence is encoded as {} (not None)
        assert _intent("書店")["location"] == {}

    def test_chinese_districts_resolve_to_english_canonical(self):
        cases = {
            "尖沙咀食飯": "Tsim Sha Tsui",
            "銅鑼灣飲野": "Causeway Bay",
            "旺角": "Mong Kok",
        }
        for q, english in cases.items():
            loc = _intent(q)["location"]
            assert loc["type"] == "district"
            assert loc["value"] == english

    def test_english_districts_resolve(self):
        assert _intent("central restaurant")["location"]["value"] == "Central"
        assert _intent("causeway bay")["location"]["value"] == "Causeway Bay"

    def test_resolved_coords_present_as_floats(self):
        loc = _intent("尖沙咀食飯")["location"]
        res = loc["resolved"]
        assert isinstance(res["lat"], float) and res["lat"] != 0.0
        assert isinstance(res["lng"], float) and res["lng"] != 0.0

    def test_radius_is_unset_when_no_explicit_anchor(self):
        # radius_m stays None until a follow-up (state_merger) halves/expands it
        assert _intent("尖沙咀食飯")["location"]["radius_m"] is None

    def test_district_boosts_location_confidence(self):
        conf = _intent("尖沙咀餐廳")["confidence"]
        assert "location" in conf and conf["location"] > 0.0


class TestCategoryBucket:
    def test_known_buckets_extracted(self):
        cases = {
            "餐廳": "restaurant",
            "咖啡店": "cafe",
            "電影院": "cinema",
            "健身房": "gym",
            "瑜伽": "yoga",
            "寵物": "pet",
            "書店": "retail",
            "按摩": "beauty",
        }
        for q, bucket in cases.items():
            assert _intent(q)["category"] == bucket

    def test_category_is_a_string_bucket(self):
        cat = _intent("餐廳")["category"]
        assert isinstance(cat, str) and cat


class TestPartySize:
    def test_numeric_party_sizes(self):
        assert _intent("2人")["party_size"] == 2
        assert _intent("4个人")["party_size"] == 4
        assert _intent("我们6个")["party_size"] == 6

    def test_single_diner_is_not_a_party(self):
        # honest, non-guessing: "一个人" does not become party_size=1
        assert _intent("一个人")["party_size"] is None

    def test_no_party_signal_is_none(self):
        assert _intent("尖沙咀餐廳")["party_size"] is None


class TestConstraints:
    def test_spicy_avoid_shaped(self):
        cons = _intent("不吃辣")["constraints"]
        assert {"key": "cuisine_avoid", "value": "spicy"} in cons

    def test_beef_avoid_shaped(self):
        cons = _intent("唔食牛")["constraints"]
        assert {"key": "diet_avoid", "value": "beef"} in cons

    def test_positive_food_intent_is_not_an_avoid(self):
        # "食壽司" expresses a desire, not an avoidance -> no constraint
        assert _intent("食壽司")["constraints"] == []
        # "素食" is a dietary preference expressed positively -> no avoid constraint here
        assert _intent("素食")["constraints"] == []


class TestLanguageDetection:
    def test_chinese_markers(self):
        assert _intent("餐廳")["language"] == "zh-HK"
        assert _intent("我想食飯")["language"] == "zh-HK"

    def test_english_marker(self):
        assert _intent("restaurant")["language"] == "en"


class TestTimeShape:
    def test_no_time_returns_empty_dict(self):
        assert _intent("餐廳")["time"] == {}

    def test_tonight_is_a_range_with_quality(self):
        t = _intent("今晚")["time"]
        assert t["type"] == "range"
        start = _dt.datetime.fromisoformat(t["starts_at"])
        end = _dt.datetime.fromisoformat(t["ends_at"])
        assert end > start
        assert isinstance(t["quality"], str) and t["quality"]


class TestCategoryTaxonomyBridge:
    """The bucket this function emits must be consumable by ``categories.resolve`` (D367)."""

    def test_every_detected_bucket_resolves_to_slugs(self):
        for q in ["餐廳", "咖啡店", "電影院", "健身房", "瑜伽", "寵物", "書店", "按摩"]:
            bucket = _intent(q)["category"]
            assert isinstance(bucket, str)
            assert C.resolve(bucket), f"bucket {bucket!r} resolves to no taxonomy slugs"


class TestBudgetBoundary:
    """Documents that budget/cuisine are NOT extracted here (state_merger owns them, D352)."""

    def test_budget_signals_are_not_extracted_here(self):
        for q in ["平啲", "高檔", "奢華", "太貴"]:
            assert _intent(q)["budget"] is None

    def test_cuisine_is_not_extracted_here(self):
        # the function does not even emit a 'cuisine' field (state_merger owns it, D352)
        assert _intent("食壽司").get("cuisine") is None
