"""A one-character refusal that is the tail of a longer word is not a refusal.

The refusal vocabulary is one list now, and widening it to the single-character cues (別,
少) is what makes this door exist: the constraint lane had been reading them alone, and
measured on the live service that reading was already wrong -

    特別辣的餐廳   "an EXTRA-spicy restaurant"  ->  cuisine_avoid:spicy

- the product filtered out the very thing the user asked for, because 特別 is one word and
別 is the second character of it, not the cue "don't". 最少辣 and 多少辣 read the same way
through 少. Chinese has no spaces to lean on, so the boundary has to be a word rule, and the
word it checks is the pair the character to the LEFT makes with the cue.

The rule is a refusal, not a vocabulary: `NEGATION_COMPOUNDS` names, per cue, the left
neighbours that complete a different word. A cue with no entry is read at every position the
matcher finds, and the doors below hold both halves - a compound never governs, and a real
refusal still does. The second half matters as much as the first: a boundary rule that only
ever refuses is a rule that quietly deletes the cue, and every "no spicy" in the product
would then read as a like of it.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.canonical import canonical, canonical_node
from nexus_ai.nlu.lexicon import (
    CONSTRAINT_RULES,
    PREFERENCE_RULES,
    canon_constraint,
    normalize_query,
)
from nexus_ai.nlu.understand import extract_intent

#: Every surface a constraint rule can name, and the collision ones the ranking lane also
#: reads as a preference - the values that can be filtered out and boosted at once.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
PREFERENCE_VALUES = {value for _k, value, _t, _p in PREFERENCE_RULES}
COLLISION_SURFACES = tuple(sorted(
    {v for v in VALUES if canon_constraint(v) in PREFERENCE_VALUES}))


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


def _boosted(ex) -> set[str]:
    return {p["value"] for p in ex.preferences if int(p.get("polarity", 1) or 1) > 0}


#: The compounds the table declares, as rows: the cue, the left neighbour, and a surface
#: that both vocabularies name so the same sentence charges both lanes.
COMPOUND_ROWS = [(prefix + cue, surface)
                 for cue, prefixes in P.NEGATION_COMPOUNDS.items()
                 for prefix in prefixes
                 for surface in COLLISION_SURFACES]


@pytest.mark.parametrize("compound,surface", COMPOUND_ROWS,
                         ids=[f"{c}+{s}" for c, s in COMPOUND_ROWS])
def test_a_compound_refuses_nothing_in_either_lane(compound: str, surface: str) -> None:
    """`特別辣` is one word: neither the plan's avoid list nor the ranking reads a refusal."""
    sentence = _prepare(f"{compound}{surface}")
    ex = extract_intent(sentence)
    assert not _written(ex), (
        f"{sentence!r} wrote {sorted(_written(ex))} - {compound!r} is a single word and the "
        f"cue inside it governs nothing: the product would filter out what the user asked for")
    assert P.polarity_for(sentence, surface) != -1, (
        f"{sentence!r}: the polarity lane read {surface!r} as a dislike the constraint lane "
        f"did not write - the two lanes owe each other one answer (D538)")


@pytest.mark.parametrize("surface", COLLISION_SURFACES, ids=list(COLLISION_SURFACES))
def test_the_measured_compound_keeps_the_value_the_user_asked_for(surface: str) -> None:
    """The sentence D539's debt was paid into is the sentence that used to be wrong.

    特別辣的餐廳 asked for extra spice and got the spice filtered out. The fix is not only
    that no refusal is written: the value keeps the polarity the user's own words gave it,
    so the ranking still floats it.
    """
    sentence = _prepare(f"特別{surface}的餐廳")
    ex = extract_intent(sentence)
    assert not _written(ex), f"{sentence!r} wrote {sorted(_written(ex))} - a refusal the user did not write"
    assert P.polarity_for(sentence, surface) == 1, (
        f"{sentence!r}: the polarity lane reads {P.polarity_for(sentence, surface):+d} for "
        f"{surface!r} under the intensifier 特別 - the compound rule reached too far")


#: A cue with no compound entry is read wherever the matcher finds it; a cue with one is
#: still a cue at its own positions. Each row is the cue opening its own clause.
REFUSAL_ROWS = [(cue, surface) for cue in P.NEGATION_COMPOUNDS for surface in COLLISION_SURFACES]


@pytest.mark.parametrize("cue,surface", REFUSAL_ROWS,
                         ids=[f"{c}+{s}" for c, s in REFUSAL_ROWS])
def test_the_same_cue_still_refuses_when_it_is_a_word(cue: str, surface: str) -> None:
    """The boundary rule refuses compounds, never the cue: at clause start the refusal bites.

    This is the half that keeps a guard from becoming a deletion. A cue whose every position
    were rejected would write no constraint and leave the value boosted - the D493 contradiction
    back again, hidden behind a rule that looks like a fix.
    """
    sentence = _prepare(f"{cue}{surface}")
    ex = extract_intent(sentence)
    assert _written(ex), (
        f"{sentence!r} wrote no refusal - {cue!r} is the word the user typed here, not the "
        f"tail of another one, so the boundary rule must not reach it")
    assert not (_refused_values(ex) & _boosted(ex)), (
        f"{sentence!r}: the plan refuses {sorted(_refused_values(ex))} and the ranking boosts "
        f"the same value - one sentence, two answers")


def _refused_values(ex) -> set[str]:
    return {value for _k, value in _written(ex)}


#: The sentence the live service answered with a refusal of the thing it was asked for.
MEASURED = (
    "特別辣的餐廳",
    "最少辣",
    "多少辣",
    "特別海鮮多啲",
)


@pytest.mark.parametrize("text", MEASURED, ids=list(MEASURED))
def test_the_measured_false_refusal_is_gone(text: str) -> None:
    """Each of these wrote a constraint while asking for the value - measured, not argued."""
    sentence = _prepare(text)
    ex = extract_intent(sentence)
    assert not _written(ex), (
        f"{text!r} wrote {sorted(_written(ex))} - the intensifier or the quantity word was "
        f"read as a refusal of the value the user asked for")


def test_every_declared_compound_is_a_pair_around_a_real_cue() -> None:
    """The table's own honesty: each entry guards a cue the vocabulary actually carries."""
    cues = canonical_node(tuple(c.strip() for c in P.NEGATION_CUES))
    single = {c for c in cues if len(c) == 1 and not c.isascii()}
    for cue, prefixes in P.NEGATION_COMPOUNDS.items():
        assert cue in single, (
            f"{cue!r} has compound entries but is not a one-character cue in NEGATION_CUES - "
            f"the table guards a word the product no longer reads")
        assert prefixes, f"{cue!r} declares an empty compound list - a rule that guards nothing"
        for prefix in prefixes:
            assert len(prefix) == 1, (
                f"{cue!r}: the compound prefix {prefix!r} is not one character - the rule "
                f"compares the character directly to the cue's left")


def test_the_boundary_rule_touches_no_longer_cue() -> None:
    """A two-character refusal is a word of its own: 唔好食辣 still bites at every offset."""
    sentence = _prepare("餐廳唔好食辣")
    assert ("cuisine_avoid", "spicy") in _written(extract_intent(sentence)), (
        f"{sentence!r} wrote {sorted(_written(extract_intent(sentence)))} - the rule widened "
        f"itself past the one-character cues it was written for")


def test_the_door_walks_a_real_population() -> None:
    """A guard over an empty vocabulary agrees vacuously."""
    assert COLLISION_SURFACES, "no constraint surface is also a preference value - these rows read nothing"
    assert P.NEGATION_COMPOUNDS, "the compound table is empty - the boundary rule was deleted, not obeyed"
    assert COMPOUND_ROWS, "the compound rows came out empty - the table and the surfaces do not meet"
