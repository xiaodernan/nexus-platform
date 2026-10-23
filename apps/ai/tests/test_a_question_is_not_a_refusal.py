"""D533 - a question is not a refusal, and a refusal governs only the clause it sits in.

The product names its question vocabulary in `ASK_MERCHANT_CUES` - 有無, 有无, 有冇 - and its
refusal vocabulary in `NEGATION_CUES` - 冇 among them. Two tables, one pair of characters,
opposite meanings, and the reader that runs on the sentence had to pick one. It picked the
refusal. Measured before this unit, on the live rule path:

    有冇辣             ->  spicy   -1,  cuisine_avoid=spicy   (the user ASKED about spicy)
    有冇海鮮           ->  seafood -1,  diet_avoid=seafood
    想問有冇嘈         ->  quiet   -1,  noise_avoid=嘈
    有冇安靜啲嘅餐廳   ->  quiet   -1

A question demoted the very merchants it asked about, in the preference lane and the
constraint lane alike - the D529 shape with the sign the other way round: not a refusal
read as evidence for everything else, but a question read as a refusal.

The same unit closes the other half of the rule this module's docstring already claims - a
cue must GOVERN the token. A cue that merely sat somewhere later in the turn governed it:

    想找個安靜的咖啡店，唔好辣  ->  quiet -1   (the refusal belongs to the 辣 clause)

So the rule now reads: a cue under the lead of the existential question governs nothing; a
cue governs a token it is attached to - adjacent, modulo a short in-clause gap - and
governs the turn only from inside the turn's own clause. This gate holds both halves to
the product's own tables, so a question form added to ASK_MERCHANT_CUES is covered by
construction rather than by memory.

D538 spent the residue this file used to file: `normalize_query` no longer turns the clause
comma into a space. It writes the clause separator instead, so "平，唔要咖喱" and "平 唔要咖喱"
are different strings by the time this reader runs, and the boundary between the two clauses
is read here the way it is read everywhere else.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.polarity import NEGATION_CUES, is_existential_question, polarity_for
from nexus_ai.nlu.understand import extract_intent

#: the question forms the product itself names - ASK_MERCHANT_CUES, the 有-led ones.
QUESTION_FORMS = tuple(dict.fromkeys(c for c in L.ASK_MERCHANT_CUES if c.startswith("有")))

#: the tails of those question forms that the refusal table also claims - the characters
#: the two tables name with opposite meanings. The gate is only meaningful while this is
#: non-empty: a refusal table that stops claiming them would make every case below pass
#: for the wrong reason.
CONTESTED = tuple(q[1:] for q in QUESTION_FORMS if q[1:] in NEGATION_CUES)

#: a surface token -> the preference it carries, so a question can be checked against the
#: preference it asks about rather than against "no negation happened".
ASKED_ABOUT = (
    ("辣", ("cuisine", "spicy")),
    ("海鮮", ("cuisine", "seafood")),
    ("嘈", ("ambience", "quiet")),
    ("戶外", ("style", "outdoor")),
)


def test_the_two_tables_contest_the_same_characters():
    """The measured conflict: 有冇 is a question and 冇 is a refusal, in one product."""
    assert "冇" in CONTESTED, (
        f"no question form in ASK_MERCHANT_CUES ends in a cue NEGATION_CUES carries "
        f"(contested: {CONTESTED}) - the tables no longer disagree, so this gate "
        f"proves nothing")


def test_the_product_names_question_forms_this_gate_can_read():
    """A gate whose cases come from an empty table would pass forever."""
    assert QUESTION_FORMS, "ASK_MERCHANT_CUES names no 有-led question form"
    assert "有冇" in QUESTION_FORMS and "有無" in QUESTION_FORMS


@pytest.mark.parametrize("form", QUESTION_FORMS, ids=QUESTION_FORMS)
@pytest.mark.parametrize("token,pref", ASKED_ABOUT, ids=[t for t, _p in ASKED_ABOUT])
def test_a_question_leaves_the_thing_asked_about_positive(form, token, pref):
    """有冇 X asks whether X exists; the preference survives the question untouched."""
    ex = extract_intent(f"{form}{token}")
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(pref) == 1, (
        f"{form}{token} read the preference it asks about as {prefs.get(pref)} - a "
        f"question is being answered as a refusal")
    assert ex.constraints == [], (
        f"{form}{token} wrote constraints {ex.constraints} - the question became an "
        f"avoid-rule against the thing it asks about")


@pytest.mark.parametrize("cue,value,expected", [
    ("冇", "辣", ("cuisine", "spicy")),
    ("唔好", "辣", ("cuisine", "spicy")),
    ("唔要", "海鮮", ("cuisine", "seafood")),
    ("不要", "素食", ("cuisine", "vegetarian")),
])
def test_the_same_word_without_the_question_lead_still_refuses(cue, value, expected):
    """The exemption is the question's lead, not the cue: 冇辣 is still a refusal."""
    ex = extract_intent(f"{cue}{value}")
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(expected) == -1, (
        f"{cue}{value} read the preference as {prefs.get(expected)} - the refusal "
        f"stopped being read")


def test_a_refusal_later_in_a_turn_that_opens_with_a_question_still_refuses():
    """The exemption must not shield a real refusal further along the same turn.

    "有冇辣，冇海鮮" asks about spicy and refuses seafood. A reader that stops at the
    first 冇 - now exempted as a question - would answer neither.
    """
    ex = extract_intent("有冇辣，冇海鮮")
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(("cuisine", "seafood")) == -1, (
        f"the second 冇 stopped refusing: {prefs}")
    assert ("diet_avoid", "seafood") in {(c["key"], c["value"]) for c in ex.constraints}, (
        f"the constraint lane stopped reading the second 冇: {ex.constraints}")


def test_a_cue_that_merely_sits_later_in_the_turn_governs_nothing():
    """The refusal belongs to its own clause: 唔好辣 does not refuse the quiet."""
    assert polarity_for("想找個安靜的咖啡店，唔好辣", "安靜") == 1
    assert polarity_for("想找個咖喱，唔好辣", "咖喱") == 1


def test_a_cue_attached_after_the_token_still_negates_it():
    """The exemption is attachment, not position: 安靜的不好 is still a refusal."""
    assert polarity_for("安靜的不好", "安靜") == -1
    assert polarity_for("素食唔好", "素食") == -1


def test_the_exemption_is_the_questions_own_lead():
    assert is_existential_question("有冇", 1) is True
    assert is_existential_question("有無", 1) is True
    assert is_existential_question("問有冇", 2) is True
    assert is_existential_question("冇", 0) is False
    assert is_existential_question("有", 0) is False
    assert is_existential_question("have no", 5) is False
