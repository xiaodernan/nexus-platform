"""`nlu/state_merger.py` — follow-up / conversation-state merging (API_CONTRACT §7.1, spec §34).

The merge semantics are a *contract*: "太贵了" shrinks `budget.max` by 30%, "近一点" tightens
the radius and switches sort to distance, "不吃辣" appends a dietary constraint, party size is
read from a regex, "比较" + top subjects flips to a compare intent, and — critically — a merge
never invents a budget or a radius it was not given (§8). Merging is pure and ordered, so it
unit-tests without a model. It had **no tests**. This pins it. DB-free.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.state_merger import (
    _question_for,
    merge_followup,
    merge_turn,
)


def _base(**kw) -> dict:
    d = {"intent": "dining", "language": "zh-HK"}
    d.update(kw)
    return d


# ------------------------------------------------------------- price (§7.1)
def test_cheaper_cue_scales_budget_by_07():
    res = merge_turn(_base(budget={"max": 1000, "currency": "HKD"}), "太贵了")
    assert res.intent["budget"]["max"] == 700
    assert any(c["op"] == "scale" for c in res.changes)


def test_pricier_cue_scales_budget_up_by_14():
    res = merge_turn(_base(budget={"max": 1000}), "高档")
    assert res.intent["budget"]["max"] == 1400


def test_cheaper_with_no_budget_is_not_invented():
    # §8: there is no stated budget to scale, so nothing is fabricated
    res = merge_turn(_base(), "太贵了")
    assert res.intent.get("budget") in (None, {})
    assert any(c["op"] == "budget_relative" and c["applied"] is False for c in res.changes)


def test_cheaper_with_no_budget_still_orders_by_price():
    # The refusal to invent a number must not cost the user the whole refinement: "太贵了" with no
    # stated budget still moves the sort, exactly the way "近一点" does with no radius to scale.
    res = merge_turn(_base(), "太贵了")
    assert res.intent.get("sort_preference") == "price_low"
    assert res.intent.get("budget") in (None, {})
    assert any(c["op"] == "budget_relative" and c.get("sort_preference") == "price_low"
               and c["applied"] is False for c in res.changes)


# ------------------------------------------------------------- distance (§7.1)
def test_nearer_cue_tightens_radius_and_sorts_distance():
    res = merge_turn(_base(location={"radius_m": 2000, "type": "nearby"}), "近啲")
    assert res.intent["location"]["radius_m"] == 1000
    assert res.intent.get("sort_preference") == "distance"


def test_nearer_with_no_geo_anchor_does_not_invent_radius():
    res = merge_turn(_base(), "近啲")
    assert res.intent.get("sort_preference") == "distance"
    assert res.intent.get("location", {}).get("radius_m") is None  # never invented


def test_farther_cue_loosens_radius():
    res = merge_turn(_base(location={"radius_m": 2000}), "擴大範圍")
    assert res.intent["location"]["radius_m"] == 4000


# ------------------------------------------------------------- party size
def test_party_size_read_from_regex():
    res = merge_turn(_base(), "4个人")
    assert res.intent["party_size"] == 4


def test_party_size_out_of_range_is_ignored():
    res = merge_turn(_base(), "50人")
    assert res.intent.get("party_size") is None


# ------------------------------------------------------------- dietary / ambience
def test_no_spicy_appends_cuisine_avoid_constraint():
    res = merge_turn(_base(), "不吃辣")
    cons = res.intent["constraints"]
    assert any(c["key"] == "cuisine_avoid" and c["value"] == "spicy" for c in cons)


def test_no_beef_appends_diet_avoid_constraint():
    res = merge_turn(_base(), "不吃牛")
    cons = res.intent["constraints"]
    assert any(c["key"] == "diet_avoid" and c["value"] in ("牛", "beef") for c in cons)


def test_quiet_ambience_preference():
    res = merge_turn(_base(), "安靜")
    prefs = res.intent["preferences"]
    assert any(p["key"] == "ambience" and p["value"] == "quiet" for p in prefs)


# ------------------------------------------------------------- urgency
def test_urgency_now_cue():
    res = merge_turn(_base(), "而家")
    assert res.intent["urgency"] == "now"


# ------------------------------------------------------------- compare top-N (§34)
def test_compare_cue_flips_to_compare_intent_with_top_subjects():
    res = merge_turn(_base(), "比较", context={"top_subjects": ["s1", "s2", "s3", "s4"]})
    assert res.intent["intent"] == "compare"
    assert res.intent["mentioned_entities"] == ["s1", "s2", "s3"]   # capped at 3


# ------------------------------------------------------------- "show me others"
def test_other_cue_excludes_shown_ids():
    res = merge_turn(_base(), "其他", context={"shown_ids": ["a", "b"]})
    assert res.intent["filters"]["exclude"] == ["a", "b"]


# ------------------------------------------------------------- reset
def test_reset_cue_clears_state():
    res = merge_turn(_base(budget={"max": 1000}), "重新")
    assert res.is_followup_only is True
    assert res.intent.get("budget") is None          # state cleared


# ------------------------------------------------------------- pure-followup shape
def test_empty_turn_is_a_noop():
    res = merge_turn(_base(budget={"max": 1000}), "")
    assert res.intent["budget"]["max"] == 1000
    assert res.changes == []


def test_pure_followup_is_flagged_followup_only():
    res = merge_turn(_base(budget={"max": 1000}), "太贵了")
    assert res.is_followup_only is True


def test_merge_is_deterministic():
    a = merge_turn(_base(budget={"max": 1000}), "太贵了")
    b = merge_turn(_base(budget={"max": 1000}), "太贵了")
    assert a.intent["budget"]["max"] == b.intent["budget"]["max"]


# ------------------------------------------------------------- §8 single follow-up question
def test_question_for_asks_one_missing_thing_locale_aware():
    assert _question_for({"unknowns": ["party_size", "time"], "language": "zh-HK"}) == "请问几位？"
    assert _question_for({"unknowns": ["party_size"], "language": "en"}) == "How many people?"
    assert _question_for({"unknowns": []}) is None


# ------------------------------------------------------------- alias
def test_merge_followup_is_merge_turn():
    assert merge_followup is merge_turn
