"""D493 - the negations the product understands are ONE list, and every rule reads it.

The polarity module holds the product's vocabulary of "the negations it understands"
(NEGATION_CUES). The constraint table held its own, smaller list - and fifteen of the
product's words were missing from it, so a user who said "I don't want spicy", "I hate
spicy" or "no spicy" in Cantonese got NO constraint at all:

    唔好 (I don't want)      討厭 / 讨厌 (I hate)      冇 (no / without)
    唔係 / 不是 (is not)     don't / dont / do not      hate / dislike

D486's lesson: a copy that is a SUBSET is a copy that answers less - and here the copy
was the one the product ANSWERS with, so the words it did not carry were words the
product read and then did nothing with.

This gate holds the two lists to each other:
  * every negation the product knows is a negation of EVERY constraint rule ✓;
  * every one of them, with a rule's value, produces that rule's constraint ✓ - in the
    first turn AND in the merge ✓ (the same turn, read two ways ✓).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.nlu.understand import extract_intent

BASE = {
    "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
    "budget": None, "party_size": None, "preferences": [], "constraints": [],
    "sort_preference": "relevance",
    "location": {"type": "district", "value": "Sha Tin"},
    "time": {}, "confidence": {}, "unknowns": [],
}

#: the negations the product understands - the polarity module's own vocabulary
NEGATIONS = tuple(P.NEGATION_CUES)


def _phrase(negation: str, value: str) -> str:
    """The negation and the value, as a user would write them.

    A Chinese phrase has no space between the two; an English one has one - and the
    reader's window starts at the END of the negation, so the space is part of the
    phrase.
    """
    if negation.isascii():
        return f"{negation} {value}"
    return f"{negation}{value}"


def test_the_product_knows_its_negations():
    """The gate's cases come from the product's own table."""
    assert len(NEGATIONS) >= 25, (
        f"the polarity table holds {len(NEGATIONS)} negations - the gate's cases come "
        f"from there")


@pytest.mark.parametrize("rule,negs,values", L.CONSTRAINT_RULES,
                         ids=[r[0] for r in L.CONSTRAINT_RULES])
def test_every_negation_the_product_knows_is_a_negation_here(rule: str, negs: list[str],
                                                              values: list[str]):
    """The product knows it, so the constraint table reads it.

    The forms are generic - "I don't like it" applies to the cuisine, the diet, the
    noise - so a rule that lacks one of them answers a turn the product understands
    with nothing at all.
    """
    for negation in NEGATIONS:
        assert negation in negs, (
            f"the rule {rule!r} does not carry the negation "
            f"{negation.encode('unicode_escape').decode()!r} - the product knows it (the "
            f"polarity table holds it) and this rule does not, so a user who said it got "
            f"no constraint at all")


@pytest.mark.parametrize("rule,negs,values", L.CONSTRAINT_RULES,
                         ids=[r[0] for r in L.CONSTRAINT_RULES])
def test_every_negation_produces_its_constraint(rule: str, negs: list[str],
                                                 values: list[str]):
    """And the word is not only read - it produces the constraint it names."""
    value = values[0]
    expected = (rule, L.canon_constraint(value))
    for negation in NEGATIONS:
        text = _phrase(negation, value)
        constraints = {(c.get("key"), c.get("value"))
                       for c in extract_intent(text, {}).constraints}
        assert expected in constraints, (
            f"the phrase {text.encode('unicode_escape').decode()!r} gave {constraints} - "
            f"the negation is read but the constraint is not produced")
        merged = {(c.get("key"), c.get("value"))
                  for c in merge_turn(dict(BASE), text).intent.get("constraints", [])}
        assert expected in merged, (
            f"the merge read {text.encode('unicode_escape').decode()!r} as {merged} - the "
            f"first turn and the merge must answer the same question")


def test_the_measured_words_are_read():
    """The measured instances - the words the constraint table did not read."""
    for negation, value, expected in (
            ("唔好", "辣", ("cuisine_avoid", "spicy")),
            ("討厭", "辣", ("cuisine_avoid", "spicy")),
            ("冇", "辣", ("cuisine_avoid", "spicy")),
            ("唔係", "辣", ("cuisine_avoid", "spicy")),
            ("不要", "豬", ("diet_avoid", "pork"))):
        text = f"{negation}{value}"
        constraints = {(c.get("key"), c.get("value"))
                       for c in extract_intent(text, {}).constraints}
        assert expected in constraints, (
            f"the phrase {text.encode('unicode_escape').decode()!r} gave {constraints} - "
            f"the expected constraint is {expected}")
