"""D486 - the constraint table is the vocabulary, and every entry is a promise.

The polarity table (nlu/polarity.py) names the "don't like" forms and the constraint table
did not, so a user who said "I don't like spicy" got NO constraint at all - neither the
first turn's reader nor the merge's. And the table's last value was a WRONG CHARACTER
(U+9EA9, which Unihan defines as "bran"), so the ginger it stood for was never read: "no
ginger" was no constraint in either language.

This gate holds the table to its promises:
  * every "don't like" form the product knows is a negation here ✓;
  * every negation and every value produces the constraint it names ✓ - in the first turn
    AND in the merge ✓ (the same turn, read two ways ✓).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.nlu.understand import extract_intent

#: the "don't like" forms - the product's own words, read out of the polarity table
DONT_LIKE = tuple(c for c in P.NEGATION_CUES
                  if c in ("\u5514\u937e\u610f", "\u5514\u937e", "\u4e0d\u559c\u6b61",
                           "\u4e0d\u559c\u6b22"))

BASE = {
    "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
    "budget": None, "party_size": None, "preferences": [], "constraints": [],
    "sort_preference": "relevance",
    "location": {"type": "district", "value": "Sha Tin"},
    "time": {}, "confidence": {}, "unknowns": [],
}


def test_the_dont_like_forms_are_known():
    """The polarity table's "don't like" forms - the product's own words."""
    assert len(DONT_LIKE) == 4, (
        f"the polarity table holds {len(DONT_LIKE)} of the four 'don't like' forms - the "
        f"gate's cases come from there")


@pytest.mark.parametrize("rule,negs,values", L.CONSTRAINT_RULES,
                         ids=[r[0] for r in L.CONSTRAINT_RULES])
def test_every_dont_like_form_is_a_negation_here(rule: str, negs: list[str],
                                                 values: list[str]):
    """Every "don't like" form the product knows is a negation of EVERY rule.

    The forms are generic - "I don't like it" applies to the cuisine, the diet, the
    noise - so a rule that lacks one of them answers a turn the product understands
    with nothing at all.
    """
    for form in DONT_LIKE:
        assert form in negs, (
            f"the rule {rule!r} does not carry the negation "
            f"{form.encode('unicode_escape').decode()!r} - the product knows it (the "
            f"polarity table holds it) and this rule does not, so a user who said it got "
            f"no constraint at all")


@pytest.mark.parametrize("rule,negs,values", L.CONSTRAINT_RULES,
                         ids=[r[0] for r in L.CONSTRAINT_RULES])
def test_every_negation_reads_its_rule(rule: str, negs: list[str], values: list[str]):
    """Every negation in the table produces that rule's constraint."""
    value = values[0]
    for negation in negs:
        text = f"{negation}{value}"
        constraints = {(c.get("key"), c.get("value"))
                       for c in extract_intent(text, {}).constraints}
        assert (rule, L.canon_constraint(value)) in constraints, (
            f"the negation {negation.encode('unicode_escape').decode()!r} with the value "
            f"{value.encode('unicode_escape').decode()!r} produced {constraints} - the "
            f"table's entry is a promise")


@pytest.mark.parametrize("rule,negs,values", L.CONSTRAINT_RULES,
                         ids=[r[0] for r in L.CONSTRAINT_RULES])
def test_every_value_is_read(rule: str, negs: list[str], values: list[str]):
    """Every value in the table is read - with the first negation."""
    negation = negs[0]
    for value in values:
        text = f"{negation}{value}"
        constraints = {(c.get("key"), c.get("value"))
                       for c in extract_intent(text, {}).constraints}
        assert (rule, L.canon_constraint(value)) in constraints, (
            f"the value {value.encode('unicode_escape').decode()!r} was not read - the "
            f"table's entry is a promise")


def test_the_merge_reads_them_too():
    """The same turn, read by the merge as well as by the first turn."""
    for text, expected in (("\u5514\u937e\u610f\u8fa3", ("cuisine_avoid", "spicy")),
                           ("no ginger", ("diet_avoid", "ginger")),
                           ("\u4e0d\u5403\u8fa3", ("cuisine_avoid", "spicy"))):
        first = {(c.get("key"), c.get("value"))
                 for c in extract_intent(text, {}).constraints}
        merged = {(c.get("key"), c.get("value"))
                  for c in merge_turn(dict(BASE), text).intent.get("constraints", [])}
        assert expected in first, f"the first turn read {first} for {text!r}"
        assert expected in merged, f"the merge read {merged} for {text!r}"
