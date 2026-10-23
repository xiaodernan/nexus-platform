"""D535 - the clause is the unit of governance: a conjunction ends it, one verb bridge keeps it.

D533 established that a refusal governs the token it is attached to and the clause it sits
in, and enforced the boundary the punctuation marks. Two measured cases survived it,
because the normalizer turns a clause comma into a space and the OTHER clause markers
survive as words:

    cheap and no curry          ->  cheap -1     (the refusal is the curry's, not the cheap's)
    I do not want spicy food    ->  spicy +1     (a LIKE of the very thing refused)

The first is a conjunction: "X and no Y" coordinates two clauses, and the refusal belongs
to the second. The second is a verb: "do not WANT spicy" keeps the refusal inside its own
clause across one verb, and without the bridge the most natural English refusal read as a
LIKE - which the ranking lane then boosted (the D522 shape, in English).

So the rule is: a cue governs a token in its own clause; a conjunction ends a clause; one
verb may sit between a refusal and the thing refused. Both halves are pinned below, with
the cases D533 already fixed held green so the two units cannot drift apart.

Residue measured and filed, not fixed: the CONSTRAINT lane's window is eight characters
past the negation, so "don't want spicy" (the value sits ten past the cue) still writes no
`cuisine_avoid`. Widening it to sixteen was measured too: it then reads "no rush, want
spicy" as a refusal of spicy. That lane's grammar is the next unit's, not this one's.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.polarity import _CLAUSE_CONJUNCTIONS, _VERB_BRIDGE, polarity_for
from nexus_ai.nlu.understand import extract_intent

#: "cheap <conjunction> no curry" - the coordination shape, in both languages.
COORDINATED = ("cheap and no curry", "cheap or no curry", "cheap but no curry",
               "cheap 同 no curry", "平同唔要咖喱", "平同埋唔要咖喱")

#: a refusal with one verb between it and the thing refused.
BRIDGED = ("I do not want spicy food", "don't want spicy", "not like quiet",
           "not eat spicy", "唔好食辣")

#: what must NOT change: the refusals and non-refusals the earlier units fixed.
PRESERVED = (
    ("no spicy please", "spicy", -1),
    ("not a quiet place", "quiet", -1),
    ("唔好咁嘈", "嘈", -1),
    ("安靜的不好", "安靜", -1),
    ("素食唔好", "素食", -1),
    ("想找個安靜的咖啡店，唔好辣", "安靜", 1),
    ("有冇辣", "辣", 1),
    ("有冇海鮮", "海鮮", 1),
)


@pytest.mark.parametrize("conj", _CLAUSE_CONJUNCTIONS, ids=_CLAUSE_CONJUNCTIONS)
def test_a_conjunction_ends_the_clause(conj):
    """Every conjunction the table names must end the clause the refusal sits in."""
    text = f"cheap {conj} no curry"
    assert polarity_for(text, "cheap") == 1, (
        f"{text!r} still reads the cheap as refused - the conjunction {conj!r} is not "
        f"ending the clause")
    assert polarity_for(text, "curry") == -1, (
        f"{text!r} stopped reading the refusal of the curry - the conjunction rule ate "
        f"the refusal it was meant to bound")


@pytest.mark.parametrize("text", COORDINATED, ids=COORDINATED)
def test_a_coordinated_turn_reads_both_halves(text):
    """The behavioural half: the wanted half stays wanted, the refused half refused.

    The constraint lane is only asserted for the English spellings: the Cantonese
    "咖喱" writes no `cuisine_avoid` at all, because that rule's value list carries the
    ASCII "curry" and not the word a Cantonese user types. That hole is measured and
    filed for its own unit; pinning it here would make this gate red for a reason that
    is not the clause rule.
    """
    ex = extract_intent(text)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    # 咖喱 and curry are one fact, and the preference lane spells it indian.
    refused = ("cuisine", "indian")
    assert prefs.get(("price_sense", "cheap")) == 1, (
        f"{text} read the cheap half as {prefs.get(('price_sense', 'cheap'))}")
    assert prefs.get(refused) == -1, (
        f"{text} read the refused half as {prefs.get(refused)}")
    if "curry" in text:
        assert {("cuisine_avoid", "curry")} <= {(c["key"], c["value"]) for c in ex.constraints}, (
            f"{text} wrote no curry constraint: {ex.constraints}")


@pytest.mark.parametrize("text", BRIDGED, ids=BRIDGED)
def test_one_verb_keeps_the_refusal_inside_its_clause(text):
    """"I do not WANT spicy" refuses the spicy; "唔好食辣" refuses the 辣."""
    ex = extract_intent(text)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    refused = ("ambience", "quiet") if "quiet" in text else ("cuisine", "spicy")
    assert prefs.get(refused) == -1, (
        f"{text} read the refusal as {prefs.get(refused)} - the ranking lane would "
        f"boost the very thing refused")


@pytest.mark.parametrize("text,token,want", PRESERVED, ids=[t for t, _k, _w in PRESERVED])
def test_the_earlier_units_hold(text, token, want):
    """D533's boundary, attachment and question rules must survive the new ones."""
    assert polarity_for(text, token) == want


def test_the_bridge_is_one_verb_and_nothing_more():
    """A gap that is not a bridge verb and not short is another clause, not a bridge."""
    assert "want" in _VERB_BRIDGE
    assert polarity_for("not the quiet place", "quiet") == -1   # "the" is short
    assert polarity_for("cheap and no curry", "cheap") == 1    # "and" is a conjunction
