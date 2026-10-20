"""D393 - preference polarity: a negated preference is a dislike, not a like (§7.1 / §8).

The lexicon's `PREFERENCE_RULES` carry a fixed polarity of +1. A user who says "唔好咁嘈" or
"not quiet" is expressing a dislike, and the extractor must record `polarity=-1` so the ranking
lane demotes instead of boosting. This is the difference between "the page says the wrong
thing" and "the page says the opposite of what the user asked".
"""

from __future__ import annotations


from nexus_ai.nlu.polarity import apply_polarity, polarity_for
from nexus_ai.nlu.understand import extract_intent


# --------------------------------------------------------------------------- the helper
def test_a_bare_preference_is_positive():
    assert polarity_for("想找個安靜的地方", "安靜") == 1
    assert polarity_for("looking for a quiet place", "quiet") == 1


def test_a_cue_directly_before_the_token_negates_it():
    assert polarity_for("唔好安靜的地方", "安靜") == -1
    assert polarity_for("not a quiet place", "quiet") == -1


def test_a_cue_after_the_token_negates_it():
    # "我唔食辣" — the cue sits before, but the preference token is the constraint's value.
    assert polarity_for("安靜的不好", "安靜") == -1


def test_a_cue_far_from_the_token_does_not_negate_it():
    # The cue governs the sentence, but the token is 20 characters later and other
    # words sit between them: this is a different clause.
    assert polarity_for("唔好辣 想找個安靜的咖啡店", "安靜") == 1


def test_no_cue_means_positive():
    assert polarity_for("想找個熱鬧的地方", "熱鬧") == 1


def test_a_token_that_is_not_in_the_sentence_is_ungoverned():
    assert polarity_for("想找個咖啡店", "安靜") == 0


# --------------------------------------------------------------------------- the extractor
def test_a_negated_preference_is_extracted_with_negative_polarity():
    ex = extract_intent("唔好安靜的地方", {"locale": "zh-HK"})
    prefs = {p["key"]: p for p in ex.preferences}
    assert "ambience" in prefs
    assert prefs["ambience"]["polarity"] == -1


def test_a_plain_preference_keeps_positive_polarity():
    ex = extract_intent("想找個安靜的地方", {"locale": "zh-HK"})
    prefs = {p["key"]: p for p in ex.preferences}
    assert prefs["ambience"]["polarity"] == 1


def test_a_negated_preference_does_not_infer_a_category():
    # A dislike must not name a place: the inference reads the polarity, and -1
    # contributes negatively, so the score never reaches the threshold.
    ex = extract_intent("唔好熱鬧的地方", {"locale": "zh-HK"})
    assert ex.category is None or ex.confidence.get("category", 0) < 0.75


# --------------------------------------------------------------------------- the applier
def test_apply_polarity_leaves_an_unmentioned_preference_alone():
    prefs = [{"key": "access", "value": "mtr_near", "polarity": 1}]
    out = apply_polarity(prefs, "想找個安靜的地方")
    assert out[0]["polarity"] == 1


def test_apply_polarity_stamps_a_negated_preference():
    prefs = [{"key": "ambience", "value": "quiet", "polarity": 1}]
    out = apply_polarity(prefs, "not a quiet place")
    assert out[0]["polarity"] == -1


def test_apply_polarity_does_not_mutate_its_input():
    prefs = [{"key": "ambience", "value": "quiet", "polarity": 1}]
    apply_polarity(prefs, "not a quiet place")
    assert prefs[0]["polarity"] == 1
