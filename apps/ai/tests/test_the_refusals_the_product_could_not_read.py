"""D534 - the refusals the product could not read: 無, 沒有, 没有.

The refusal table carried 冇 - the Cantonese character - and the standard-written refusals
were not in it. Measured before this unit, on the live rule path:

    無素食     ->  vegetarian +1     (a LIKE of the very thing refused)
    沒有素食   ->  vegetarian +1
    没有素食   ->  vegetarian +1
    无素食     ->  vegetarian +1     (canonicalised to 無素食, same hole)

So a user who refused in the standard written spelling was answered with the opposite of
what they asked, and the ranking lane boosted it - the D522 shape again, in the one
vocabulary the product has not finished.

Adding the cues was not safe before D533, and the reason is the point of this gate:

  * 無 sits inside 無障礙 (the accessible token) and inside 貴都無所謂 (the premium
    pattern), and 有無 / 有没有 is the product's own question form - so a naive table
    entry would have refused the wheelchair users, refused the premium diner who says
    price is no object, and turned "is there any outdoor seating?" into a dislike of
    outdoor seating. D533's attachment rule and its existential-question exemption are
    what make the entry honest, and the cases below are what keep it honest.

没有 is spelled out beside 沒有 because the canonical table has no 没 -> 沒 entry, so
canonicalisation cannot unify the two scripts; that hole is filed in PLAN, and when it is
filled this row canonicalises into 沒有 and costs nothing.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.polarity import NEGATION_CUES
from nexus_ai.nlu.understand import extract_intent

#: the refusals the product could not read, in the spellings a user types them. The
#: traditional pair is the cue table's own spelling; 没有 is the Simplified one the
#: canonical table cannot yet unify.
NEW_REFUSALS = ("無", "沒有", "没有")

#: the measured neighbours - sentences where the new cue sits inside another word, or
#: under the existential question's lead, or after the token it must not govern. Each
#: carries the constraints the sentence legitimately writes, so the check is about the
#: SMEAR and not about the refusal itself.
NOT_REFUSALS = (
    ("米芝蓮，貴都無所謂", ("price_sense", "premium"), []),   # 無 inside 無所謂
    ("貴都無所謂", ("price_sense", "premium"), []),            # the pattern carries its own 無
    ("有無戶外座位", ("style", "outdoor"), []),                # 有無 X is a question about X
    ("有无户外", ("style", "outdoor"), []),
    ("有無障礙", ("access", "accessible"), []),                # 無 inside the token 無障礙
    ("想找個安靜的咖啡店，唔好辣", ("ambience", "quiet"),       # the refusal is 辣's clause
     [("cuisine_avoid", "spicy")]),
)


@pytest.mark.parametrize("cue", NEW_REFUSALS, ids=NEW_REFUSALS)
def test_the_refusal_is_in_the_products_own_table(cue):
    """A gate whose cases come from a table that dropped them would pass forever."""
    assert cue in NEGATION_CUES, (
        f"{cue.encode('unicode_escape').decode()} is no longer a negation the product "
        f"knows - the refusal this unit measured is unread again")


@pytest.mark.parametrize("cue", NEW_REFUSALS, ids=NEW_REFUSALS)
def test_the_refusal_is_read_in_the_preference_lane(cue):
    ex = extract_intent(f"{cue}素食")
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(("cuisine", "vegetarian")) == -1, (
        f"{cue}素食 read the refusal as {prefs.get(('cuisine', 'vegetarian'))} - the "
        f"ranking lane would boost the thing the user refused")


@pytest.mark.parametrize("cue", NEW_REFUSALS, ids=NEW_REFUSALS)
def test_the_refusal_is_read_in_the_constraint_lane(cue):
    ex = extract_intent(f"{cue}辣")
    got = {(c["key"], c["value"]) for c in ex.constraints}
    assert ("cuisine_avoid", "spicy") in got, (
        f"{cue}辣 wrote no cuisine_avoid constraint ({got}) - the refusal the "
        f"preference lane reads is invisible to the constraint lane")


@pytest.mark.parametrize("text,pref,want_constraints", NOT_REFUSALS,
                         ids=[t for t, _p, _c in NOT_REFUSALS])
def test_the_word_that_looks_like_a_refusal_is_not_one(text, pref, want_constraints):
    """The neighbours: a cue inside another word, or in another clause, governs nothing.

    The constraint lane is held to the sentence's OWN refusal, not to an empty set:
    "想找個安靜的咖啡店，唔好辣" refuses the spicy and must keep saying so - what must
    not happen is the refusal reaching the quiet.
    """
    ex = extract_intent(text)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(pref) == 1, (
        f"{text} read {pref} as {prefs.get(pref)} - the new cue is refusing something "
        f"it merely sits next to")
    assert {(c["key"], c["value"]) for c in ex.constraints} == set(want_constraints), (
        f"{text} wrote constraints {ex.constraints} - the refusal is being smeared "
        f"across the constraint lane too")
