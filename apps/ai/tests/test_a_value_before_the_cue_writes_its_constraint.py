"""D539 - the constraint lane reads a refusal written the Cantonese way round.

A Cantonese refusal puts the value FIRST: "咖喱唔要" refuses the curry. The polarity
lane has read a cue that sits AFTER its token since D533 ("素食唔好" refuses the 素食),
and the lane that writes the §7.1 constraints - the one the search plan's avoid list
is built from - read forward only. Measured at HEAD over the rules' own surfaces and
the negations both tables carry, every backward shape wrote nothing: 490 of 490, while
the preference lane read a dislike for every one of them. The search filtered nothing
and the ranking demoted the curry - a refusal the product half-read, in the language
most of its users type.

The arm is the mirror of three rules the polarity lane already reads, and it is NOT
`forward_gap` run backwards:

  * the gap between the value and the cue keeps EVERY separator in it. Forward, the
    separator directly under the cue is the cue's own punctuation ("唔好，辣" refuses
    the 辣, D538); backward, the comma really did end the value's clause, so "辣，唔好"
    leaves the 辣 alone.
  * the cue must be final in its own clause. A cue with an object of its own keeps
    that object (D537): "辣唔好咖喱" refuses the curry and not the 辣.
  * the existential question is exempt (D533), from both sides: "有冇咖喱" asks whether
    curry exists, and so does the topic-fronted "咖喱有冇" - the 有 sits directly under
    the cue there too, so the one exemption reads both orders.

The population is derived, never hand-written: the cues are the negations BOTH tables
carry (the four the constraint table alone reads - 不吃 / 別 / 避免 / 少 - are the D493
debt, and the agreement door next to this one holds them), and the values are the
rules' own surfaces. A value or a cue added to the tables is walked by this door by
itself, and every row charges both halves: the constraint is written AND the polarity
lane reads the dislike, because a refusal one lane reads and the other does not is the
D538 seam reopened from the other side.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.canonical import canonical, canonical_node
from nexus_ai.nlu.lexicon import CONSTRAINT_RULES, canon_constraint, normalize_query
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: Every negation, as the ONE matcher wants it - stripped of the trailing space a Latin
#: entry carries (D538), and canonicalised the way both tables are at import.
RULE_NEGATIONS = canonical_node(tuple(dict.fromkeys(
    n.strip() for _k, negs, _v in CONSTRAINT_RULES for n in negs)))
POLARITY_NEGATIONS = canonical_node(tuple(c.strip() for c in P.NEGATION_CUES))

#: the negations BOTH lanes read - the population this door walks. A cue the polarity
#: table does not carry is the D493 debt, not this door's question.
SHARED_NEGATIONS = tuple(c for c in RULE_NEGATIONS if c in POLARITY_NEGATIONS)

#: Every surface a constraint rule can name, the rule that carries it, and the canon
#: value it reads as.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_OF = {v.strip(): k for k, _n, vs in CONSTRAINT_RULES for v in vs}
RULE_KEYS = tuple(k for k, _n, _v in CONSTRAINT_RULES)


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _backward(value: str, cue: str, gap: str) -> str:
    """The refusal as a user writes it: the value first, the cue after it.

    An English cue needs its space; a Chinese one does not, and the gap - nothing, or
    one space - goes between the two either way.
    """
    return f"{value}{gap} {cue}" if cue.isascii() else f"{value}{gap}{cue}"


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


#: the census: every surface the rules name, under every negation both lanes read, in
#: the order a Cantonese user writes them.
ROWS = [(value, cue) for value in VALUES for cue in SHARED_NEGATIONS]


@pytest.mark.parametrize("value,cue", ROWS, ids=[f"{v}|{c}" for v, c in ROWS])
def test_a_value_before_the_cue_writes_its_constraint(value: str, cue: str) -> None:
    """The backward refusal writes the rule's constraint, and the polarity lane agrees."""
    sentence = _prepare(_backward(value, cue, ""))
    ex = extract_intent(sentence)
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(ex), (
        f"{_backward(value, cue, '')!r} wrote {sorted(_written(ex)) or 'nothing'} - the "
        f"value sits before the cue and the lane read the refusal as nothing")

    low = sentence.lower()
    for surface in VALUES:
        if cue_in(surface, sentence, low):
            sign = P.polarity_for(sentence, surface)
            assert sign == -1, (
                f"{sentence!r}: the constraint lane refused {surface!r} and the polarity "
                f"lane read it {sign:+d} - the two lanes disagree about one sentence")


#: the same walk with a space in the gap: whitespace is filler, not a boundary.
SPACED = [(value, SHARED_NEGATIONS[i % len(SHARED_NEGATIONS)])
          for i, value in enumerate(VALUES)]


@pytest.mark.parametrize("value,cue", SPACED, ids=[f"{v}|{c}|sp" for v, c in SPACED])
def test_a_space_in_the_backward_gap_is_still_filler(value: str, cue: str) -> None:
    """One space between the value and the cue does not end the value's clause."""
    sentence = _prepare(_backward(value, cue, " "))
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(extract_intent(sentence)), (
        f"{_backward(value, cue, ' ')!r} wrote "
        f"{sorted(_written(extract_intent(sentence))) or 'nothing'} - a space between the "
        f"value and the cue is filler, not a clause boundary")


#: what the arm must NOT read. Each sentence carries a value before a cue, and the
#: refusal is not that value's - or is nobody's.
NOT_BACKWARD = (
    ("辣，唔好", set()),
    ("辣，唔好，咖喱唔要", {("cuisine_avoid", "curry")}),
    ("辣唔好咖喱", {("cuisine_avoid", "curry")}),
    ("有冇咖喱", set()),
    ("咖喱有冇", set()),
    ("咖喱呀有冇", set()),
    ("I want spicy no cilantro", {("diet_avoid", "coriander")}),
    ("想食辣，咖喱唔好", {("cuisine_avoid", "curry")}),
)


@pytest.mark.parametrize("text,want", NOT_BACKWARD, ids=[t for t, _w in NOT_BACKWARD])
def test_the_backward_arm_does_not_reach_across_a_clause(text, want):
    """The gap keeps its separator, the cue keeps its object, the question stays a question."""
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads "
        f"{sorted(want) or 'nothing'}")


#: the forward readings D538 pinned. The separator under the cue is still the cue's own
#: punctuation, and none of these may move.
UNMOVED = (
    ("唔好，辣", {("cuisine_avoid", "spicy")}),
    ("no, spicy", {("cuisine_avoid", "spicy")}),
    ("唔好食辣", {("cuisine_avoid", "spicy")}),
    ("don't want spicy", {("cuisine_avoid", "spicy")}),
    ("no rush want spicy", set()),
    ("no rush, want spicy", set()),
)


@pytest.mark.parametrize("text,want", UNMOVED, ids=[t for t, _w in UNMOVED])
def test_the_forward_readings_do_not_move(text, want):
    """What the forward direction read before this unit, it reads after it."""
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} moved: the lane now writes {sorted(got) or 'nothing'}")


#: the two languages in one sentence - the cue and the value need not share a script.
MIXED = (
    ("咖喱 no ", {("cuisine_avoid", "curry")}),
    ("curry 唔要", {("cuisine_avoid", "curry")}),
)


@pytest.mark.parametrize("text,want", MIXED, ids=[t for t, _w in MIXED])
def test_a_bilingual_refusal_reads_in_both_orders(text, want):
    """A Hong Kong user mixes the two scripts inside one refusal."""
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads "
        f"{sorted(want) or 'nothing'}")


def test_the_census_population_is_real():
    """A door that walks nothing agrees vacuously."""
    assert VALUES and SHARED_NEGATIONS, (
        "the rules carry no surface, or no negation both tables read - the rows above "
        "are empty and their green means nothing")
    keys = {RULE_OF[v] for v in VALUES}
    assert not set(RULE_KEYS) - keys, (
        f"the census walks no value for {sorted(set(RULE_KEYS) - keys)} - that rule's "
        f"backward direction is untested")

