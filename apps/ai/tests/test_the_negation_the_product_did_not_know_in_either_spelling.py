"""D547 - the negation the product did not know, in either spelling: 没 / 沒.

Every other spelling of "did not / do not" was a word the product understood:
唔食辣, 不吃辣, 不想吃辣, 不要吃辣, 讨厌吃辣, 冇食辣 and 無食辣 all wrote the
refusal and read it -1. The Simplified and standard-written 没 / 沒 was in NO table at
all, and measured at D546 every sentence that used it came back the opposite of what was
asked:

    没食辣   ->  cuisine spicy +1, intent unknown     (a LIKE of the refused cuisine)
    没吃辣   ->  cuisine spicy +1, intent unknown
    我没吃辣  ->  cuisine spicy +1, intent unknown
    没素食   ->  cuisine vegetarian +1
    没吃花生  ->  nothing at all

Not in `CANONICAL_FORMS`, so the two scripts could not meet; not in `NEGATION_CUES`, so
neither lane read it; and because the marker sets are DERIVED from the canon
(`SIMPLIFIED_MARKERS = ... | frozenset(CANONICAL_FORMS)`), not in the locale detector
either - "没有素食" was answered in the Traditional locale for a user who typed Simplified.
D534 filed the canon hole in this exact sentence and predicted the row would canonicalise
into 沒有 and cost nothing when it was filled; this unit fills it.

The fix is one canon entry and one cue, and the two together reach three readers:

  * `canonical("没") == "沒"`, so the two spellings are one word and every table that
    canonicalises at import (D447) holds one form of it;
  * the bare cue joins `NEGATION_CUES`, from which the constraint table derives its own
    negations, so ONE entry is read by both lanes (D493's shape) rather than taught to
    each of them;
  * the locale markers gain the pair for free, because they are derived.

The neighbours are what keep the bare cue honest, and they are the same neighbours 無
needed (D534): a cue inside another word governs nothing, and the existential question is
exempt.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.canonical import CANONICAL_FORMS, canonical
from nexus_ai.nlu.lexicon import CONSTRAINT_RULES, canon_constraint, detect_language
from nexus_ai.nlu.polarity import NEGATION_CUES
from nexus_ai.nlu.understand import extract_intent

#: the two spellings of the one word, written as escapes (D409: a writer's memory of a
#: code point is not a reference).
SIMPLIFIED = "\u6ca1"      # 没 - "not, have not, no"
TRADITIONAL = "\u6c92"     # 沒 - the standard spelling of the same word

SPELLINGS = (SIMPLIFIED, TRADITIONAL)
IDS = ("simplified", "traditional")


# ------------------------------------------------------------------ the canon
def test_the_two_spellings_of_one_word_meet_in_the_canon():
    assert CANONICAL_FORMS.get(SIMPLIFIED) == TRADITIONAL, (
        "the canon has no 没 -> 沒 entry, so the Simplified spelling of the negation is a "
        "different word from the Traditional one and the two can never meet")
    assert canonical(SIMPLIFIED) == TRADITIONAL
    assert canonical(TRADITIONAL) == TRADITIONAL, "the table is not an equivalence"


def test_each_spelling_votes_for_the_locale_it_belongs_to():
    # The marker sets are derived from the canon, so the entry reaches the detector too.
    assert detect_language(SIMPLIFIED) == "zh-CN", (
        "a Simplified user typing the negation is read as a Hong Kong user")
    assert detect_language(TRADITIONAL) == "zh-HK", (
        "a Traditional user typing the negation is read as a Simplified user")


# ------------------------------------------------------------------ the cue, both lanes
@pytest.mark.parametrize("spelling", SPELLINGS, ids=IDS)
def test_the_bare_cue_is_a_negation_the_product_knows(spelling):
    assert canonical(spelling) in NEGATION_CUES, (
        "the bare did-not is no longer a negation the product knows - the refusal this "
        "unit measured is unread again")


@pytest.mark.parametrize("spelling", SPELLINGS, ids=IDS)
@pytest.mark.parametrize("rule,negs,values", CONSTRAINT_RULES,
                         ids=[r[0] for r in CONSTRAINT_RULES])
def test_the_bare_cue_writes_every_rules_refusal(spelling, rule, negs, values):
    """The census: the cue the constraint table derives from the polarity list writes
    every rule's refusal, in both spellings, so no lane is taught the word alone."""
    text = f"{spelling}{values[0]}"
    got = {(c["key"], c["value"]) for c in extract_intent(text).constraints}
    assert (rule, canon_constraint(values[0])) in got, (
        f"{text!r} wrote {got} - the bare did-not is read by neither lane")


# ------------------------------------------------------------------ the measured sentences
#: every sentence measured at D546 as reading a LIKE of the thing it refused, or nothing
#: at all, in the spelling the user typed it.
MEASURED = (
    ("\u6ca1\u98df\u8fa3", ('cuisine', 'spicy')),
    ("\u6ca1\u5403\u8fa3", ('cuisine', 'spicy')),
    ("\u6211\u6ca1\u5403\u8fa3", ('cuisine', 'spicy')),
    ("\u6ca1\u7d20\u98df", ('cuisine', 'vegetarian')),
    ("\u6c92\u98df\u8fa3", ('cuisine', 'spicy')),
    ("\u6c92\u5403\u8fa3", ('cuisine', 'spicy')),
    ("\u6211\u6c92\u5403\u8fa3", ('cuisine', 'spicy')),
    ("\u6ca1\u5403\u82b1\u751f", ('diet_avoid', 'peanut')),   
)


@pytest.mark.parametrize("text,want", MEASURED, ids=[m[0].encode("unicode_escape").decode()
                                                     for m in MEASURED])
def test_the_measured_refusal_is_not_read_as_a_like(text, want):
    ex = extract_intent(text)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    cons = {(c["key"], c["value"]) for c in ex.constraints}
    if want[0] == "cuisine":
        assert prefs.get(want) == -1, (
            f"{text!r} read the cuisine it refuses as {prefs.get(want)} - the ranking "
            f"lane would boost the very thing the user refused")
        assert ex.intent != "unknown", (
            f"{text!r} answered the intent unknown - the refusal was read and the turn "
            f"was refused")
    else:
        assert want in cons, (
            f"{text!r} wrote {cons} - the refusal the product reads is invisible to the "
            f"constraint lane")


def test_the_refusal_also_lands_in_the_search_plan():
    """The end of the chain the D541/D546 units built: the refusal reaches `plan.avoid`."""
    from nexus_ai.contract import Intent
    from nexus_ai.search.service import plan_from_intent

    text = "\u6ca1\u98df\u8fa3"      # 没食辣
    d = extract_intent(text).to_dict()
    plan = plan_from_intent(Intent.model_validate(d), query=text)
    assert "spicy" in plan.avoid, (
        f"the refusal reached the plan as {plan.avoid} - it was read and then dropped")


# ------------------------------------------------------------------ the neighbours
#: the sentences where the bare cue sits inside another word, under the existential
#: question's lead, or in another clause. Each carries what the sentence legitimately
#: writes, so the check is about the SMEAR and not about the refusal.
NOT_REFUSALS = (
    ("\u7c73\u829d\u84ee\uff0c\u8cb4\u90fd\u7121\u6240\u8b02", ('price_sense', 'premium'), []),
    ("\u7c73\u829d\u84ee\uff0c\u8cb4\u90fd\u6ca1\u6240\u8c13", ('price_sense', 'premium'), []),
    ("\u6709\u7121\u6236\u5916\u5ea7\u4f4d", ('style', 'outdoor'), []),
    ("\u6709\u7121\u969c\u7919", ('access', 'accessible'), []),
    ("\u60f3\u627e\u500b\u5b89\u975c\u7684\u5496\u5561\u5e97\uff0c\u5514\u597d\u8fa3", ('ambience', 'quiet'), [('cuisine_avoid', 'spicy')]),
)


@pytest.mark.parametrize("text,pref,want_constraints", NOT_REFUSALS,
                         ids=[t.encode("unicode_escape").decode() for t, _p, _c in NOT_REFUSALS])
def test_the_word_that_looks_like_a_refusal_is_not_one(text, pref, want_constraints):
    ex = extract_intent(text)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(pref) == 1, (
        f"{text!r} read {pref} as {prefs.get(pref)} - the bare cue is refusing something "
        f"it merely sits next to")
    assert {(c["key"], c["value"]) for c in ex.constraints} == set(want_constraints), (
        f"{text!r} wrote constraints {ex.constraints} - the refusal is being smeared "
        f"across the constraint lane too")
