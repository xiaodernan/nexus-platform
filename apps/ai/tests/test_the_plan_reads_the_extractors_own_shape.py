"""The planner read the extractor's own output as a model, and died on it.

`plan_from_intent` is called with two shapes. The pipeline hands `validate_intent`'s contract
model; direct callers - and this suite's own `test_transient_preference_label.py`, red at
`5122794` with `'dict' object has no attribute 'type'` - hand `extract_intent`'s output, whose
`location`, `budget`, `time` and each `constraints` entry are plain dicts. Every read of those
fields was attribute access, so the sentence could not be planned at all:

    咖啡店            AttributeError: 'dict' object has no attribute 'type'
    300-500蚊的餐廴    AttributeError: 'dict' object has no attribute 'max'
    今晩7點的餐廴   AttributeError: 'str' object has no attribute 'astimezone'

The repair is `_field(obj, name)` - a dict answers `get`, anything else answers `getattr` - the
same choice `_plain` already makes for `filters`, applied at every read of the four fields, and
the extractor's ISO instant is parsed where it enters `plan.at` (every reader of `plan.at` calls
datetime methods on it). Measured after the cut: **ten sentences plan identically from both
shapes** - filters, geo, radius, budget, party, instant, the two open-hours bounds, the match text
and the avoid list (`tmp/d652_parity.py`).

Not claimed: `run_search` still takes the contract's Intent (it dumps each preference with
`model_dump`), so this unit is about the PLANNER, which is where the two red tests meet the
extractor's shape.
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent, extract_intent_dict
from nexus_ai.search.service import plan_from_intent

TOP_K = 10

SENTENCES = [
    "咖啡店",
    "尖沙咀餐廴",
    "深水埗咖啡店",
    "附近嘗餐廴",
    "300-500蚊的餐廴",
    "今晩7點的餐廴",
    "唔食花生嘗餐廴",
    "尖沙咀2人的餐廴",
    "今晩7點尖沙咀300-500蚊的餐廴",
    "宵夜餐廴",
]


def _model_plan(text):
    return plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)


def _extractor_plan(text):
    return plan_from_intent(extract_intent(text, {"locale": "zh-HK"}), query=text, limit=TOP_K)


def _signature(plan):
    return dict(
        filters=json.loads(json.dumps(plan.filters, ensure_ascii=False, sort_keys=True, default=str)),
        geo=plan.geo,
        radius_m=plan.radius_m,
        budget=(plan.budget_min, plan.budget_max, plan.budget_per),
        party_size=plan.party_size,
        at=plan.at,
        open_late_after=plan.open_late_after,
        open_early_before=plan.open_early_before,
        match_text=plan.match_text,
        avoid=list(plan.avoid),
    )


@pytest.mark.parametrize("text", SENTENCES)
def test_the_extractor_output_plans_at_all(text):
    plan = _extractor_plan(text)
    assert isinstance(plan.at, (datetime, type(None))), (text, plan.at)


@pytest.mark.parametrize("text", SENTENCES)
def test_both_shapes_plan_one_request(text):
    assert _signature(_extractor_plan(text)) == _signature(_model_plan(text)), text


def test_the_extractors_empty_boxes_are_not_values():
    empty = extract_intent("咖啡店", {"locale": "zh-HK"})
    assert empty.location == {}, empty.location
    assert empty.time == {}, empty.time
    plan = _extractor_plan("咖啡店")
    assert (plan.filters or {}).get("district") is None, plan.filters
    assert plan.geo is None and plan.at is None, (plan.geo, plan.at)


def test_a_district_dict_writes_the_district_and_the_geo():
    plan = _extractor_plan("尖沙咀餐廴")
    assert (plan.filters or {}).get("district") == "Tsim Sha Tsui", plan.filters
    assert plan.geo == (22.2988, 114.1722), plan.geo


def test_a_budget_dict_reaches_both_ends():
    plan = _extractor_plan("300-500蚊的餐廴")
    assert (plan.budget_min, plan.budget_max) == (300.0, 500.0), (plan.budget_min, plan.budget_max)


def test_a_time_dict_reaches_the_instant():
    text = "今晩7點的餐廴"
    plan = _extractor_plan(text)
    # A datetime, not the ISO string the extractor carries - every reader of `plan.at` calls
    # `astimezone` on it - and the same instant the contract model plans.
    assert isinstance(plan.at, datetime) and plan.at.tzinfo is not None, plan.at
    assert plan.at == _model_plan(text).at, (plan.at, _model_plan(text).at)


def test_a_refusal_dict_reaches_the_avoid_lane():
    plan = _extractor_plan("唔食花生嘗餐廴")
    assert plan.avoid == ["peanut"], plan.avoid
