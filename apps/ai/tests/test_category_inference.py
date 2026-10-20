"""D391 - category inference from resolved signals (nlu/understand, §7.1 / §8).

A Chinese sentence rarely names a category outright. "帮我找一个适合情侣约会的地方" says
`occasion=date` and nothing else, so the category has to be READ from the signals the
extractor resolved. The inference is deliberately lower-confidence than a direct category
hit (§8: never fill a field in as if it were certain), and it never overrides a category
the query actually named.
"""

from __future__ import annotations


from nexus_ai.nlu.understand import extract_intent, extract_intent_dict


# --------------------------------------------------------------------------- occasion
def test_occasion_date_infers_a_category():
    ex = extract_intent("帮我找一个适合情侣约会的地方", {"locale": "zh-HK"})
    assert ex.category == "restaurant"
    assert ex.confidence["category"] < 0.95  # inferred, never as certain as a named category
    assert "category" not in ex.unknowns


def test_occasion_solo_infers_a_category():
    ex = extract_intent("想找个适合独自用餐的咖啡厅", {"locale": "zh-HK"})
    assert ex.category == "cafe"


def test_occasion_group_infers_a_category():
    ex = extract_intent("想找个适合朋友聚会的餐厅", {"locale": "zh-HK"})
    assert ex.category == "restaurant"


def test_occasion_family_infers_a_category():
    ex = extract_intent("想找个适合家庭聚餐的地方", {"locale": "zh-HK"})
    assert ex.category == "restaurant"


def test_occasion_business_infers_a_category():
    ex = extract_intent("想找个适合商务宴请的餐厅", {"locale": "zh-HK"})
    assert ex.category == "restaurant"


# --------------------------------------------------------------------------- preferences
def test_quiet_ambience_infers_a_category():
    ex = extract_intent("找个安静的地方", {"locale": "zh-HK"})
    assert ex.category in ("cafe", "restaurant")


def test_lively_ambience_infers_a_bar():
    ex = extract_intent("想找个热闹的地方", {"locale": "zh-HK"})
    assert ex.category == "bar"


def test_open_late_infers_a_bar():
    ex = extract_intent("想找个通宵营业的地方", {"locale": "zh-HK"})
    assert ex.category == "bar"


def test_scenic_view_infers_a_category():
    ex = extract_intent("想找个有景观的餐厅", {"locale": "zh-HK"})
    assert ex.category in ("restaurant", "hotel", "attraction")


def test_mtr_near_infers_a_category():
    ex = extract_intent("想找个靠近地铁的地方", {"locale": "zh-HK"})
    assert ex.category in ("restaurant", "mall")


def test_parking_infers_a_category():
    ex = extract_intent("想找个有停车位的地方", {"locale": "zh-HK"})
    assert ex.category in ("mall", "restaurant")


def test_rainy_day_infers_an_indoor_category():
    ex = extract_intent("下雨天想找个室内的地方", {"locale": "zh-HK"})
    assert ex.category in ("restaurant", "cafe", "mall")


def test_outdoor_style_infers_an_attraction():
    ex = extract_intent("想找个户外的地方", {"locale": "zh-HK"})
    assert ex.category in ("attraction", "park")


# --------------------------------------------------------------------------- precedence
def test_a_named_category_wins_over_the_inference():
    ex = extract_intent("找間安靜的咖啡店", {"locale": "zh-HK"})
    assert ex.category == "cafe"
    assert ex.confidence["category"] == 0.95  # a direct hit, not an inference


def test_the_inference_never_raises_the_confidence_of_a_direct_hit():
    ex = extract_intent("找間安靜的咖啡店", {"locale": "zh-HK"})
    assert ex.confidence["category"] <= 0.95


def test_a_query_with_no_signal_stays_unknown():
    # "嗯" is not a request at all: the intent itself is unknown, so the unknowns list
    # names the intent and nothing else (a category unknown is only owed once the turn
    # is understood to be a discovery).
    ex = extract_intent("嗯", {"locale": "zh-HK"})
    assert ex.category is None
    assert ex.unknowns == ["intent"]


def test_the_inference_is_reported_in_the_dict_shape():
    data = extract_intent_dict("帮我找一个适合情侣约会的地方", {"locale": "zh-HK"})
    assert data["category"] == "restaurant"
    assert "category" in data["confidence"]


def test_a_negative_preference_does_not_infer_a_category():
    # polarity -1 is a dislike: the inference must not name a place the user does not
    # want. This is the inference's own arithmetic, so it is measured on the function
    # that does it rather than through a sentence whose category may come from
    # elsewhere (the cuisine lexicon matches the noun even under a negation).
    from nexus_ai.nlu.understand import IntentExtraction, _infer_category_from_signals

    ex = IntentExtraction(raw_query="x")
    ex.preferences = [{"key": "occasion", "value": "date", "polarity": -1}]
    assert _infer_category_from_signals(ex) is None

    ex2 = IntentExtraction(raw_query="x")
    ex2.preferences = [{"key": "occasion", "value": "date", "polarity": 1}]
    assert _infer_category_from_signals(ex2) is not None
