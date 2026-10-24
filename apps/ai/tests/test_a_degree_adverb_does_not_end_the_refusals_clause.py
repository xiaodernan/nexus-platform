"""D544 - a degree adverb between the cue and the value does not end the refusal's clause.

D535 let ONE verb sit between a refusal and the thing refused, and the gap rule that came
out of it reads anything up to three characters as the refusal's own - which is why "not so
spicy" and "not too spicy" work and "唔好咁辣" works. The English degree words are longer
than that: measured at HEAD, "not very spicy" (the gap "very", four characters) answered
spicy +1 and wrote no constraint, and "not really like spicy" read the same - the ranking
lane boosted the very thing the user refused, the D522 shape, from one adverb.

A degree word modifies the value; it does not open a clause of its own. The rule this unit
writes: the gap between a cue and the thing it governs may be a degree adverb, or a degree
adverb and the bridge verb together ("not really like spicy" - the verb the cue governs,
with the adverb in front of it). A word that is neither still separates them, which is what
keeps D536's "no rush want spicy" unread: "rush" is a noun, not a degree.

The door walks the product's own tables: every surface the constraint rules name, every
negation they read (the shared ones charge the polarity lane as well), and every degree
adverb x every bridge verb as the gap. The seam door next door takes the new gap shapes up
by itself, because it derives its population from the tables `clause_attached` reads.
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

#: the negations BOTH lanes read - the rows that may charge the polarity lane.
SHARED_NEGATIONS = tuple(c for c in RULE_NEGATIONS if c in POLARITY_NEGATIONS)

#: Every surface a constraint rule can name, the rule that carries it, and the canon value.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_OF = {v.strip(): k for k, _n, vs in CONSTRAINT_RULES for v in vs}
RULE_KEYS = tuple(k for k, _n, _v in CONSTRAINT_RULES)

#: the degree adverbs and the bridge verbs - the two halves of the new gap shapes.
DEGREES = tuple(P._DEGREE_ADVERBS)
VERBS = tuple(P._VERB_BRIDGE)


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _phrase(negation: str, shape: str, value: str) -> str:
    """The three parts as a user writes them, with the gap between the cue and the value.

    An English negation needs its space, a Chinese one does not.
    """
    return f"{negation}{shape} {value}" if negation.isascii() else f"{negation}{shape}{value}"


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


#: the census: every surface the rules name, under every negation they read, with the
#: longest degree adverb in the gap - the four-character word the old length rule could
#: not reach.
ROWS = [(value, negation) for value in VALUES for negation in RULE_NEGATIONS]


@pytest.mark.parametrize("value,negation", ROWS, ids=[f"{v}|{c}" for v, c in ROWS])
def test_a_degree_adverb_in_the_gap_keeps_the_refusal_whole(value: str, negation: str) -> None:
    """The refusal reads through a degree adverb - and the shared cues read as a dislike.

    The adverb modifies the value, so the gap it sits in is the refusal's own clause.
    """
    sentence = _prepare(_phrase(negation, " very ", value))
    ex = extract_intent(sentence)
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(ex), (
        f"{_phrase(negation, ' very ', value)!r} wrote {sorted(_written(ex)) or 'nothing'} - "
        f"the degree adverb in the gap ended the refusal's clause")

    if negation not in POLARITY_NEGATIONS:
        return  # the D493 debt: not this door's question
    # The polarity charge follows the constraint lane's OWN reading, and a surface that
    # sits inside a longer one is not charged at all: "煙" inside "二手煙" is two
    # characters further from the cue, so the clause reaches the longer form and not the
    # shorter one - the reach residue, filed since D540, not a contradiction. No
    # preference rule names the shorter surface, so the ranking lane never asks about it;
    # the seam door next door is where a real contradiction would be caught, because it
    # walks only the values BOTH vocabularies name.
    written = {canon for _k, canon in _written(ex)}
    low = sentence.lower()
    found = [s for s in VALUES if cue_in(s, sentence, low)]
    for surface in found:
        if any(other != surface and surface in other for other in found):
            continue
        if canon_constraint(surface) in written:
            sign = P.polarity_for(sentence, surface)
            assert sign == -1, (
                f"{sentence!r}: the constraint lane refused {surface!r} and the polarity "
                f"lane read it {sign:+d} - the two lanes disagree about one sentence")


#: the gap vocabulary itself: every degree adverb x every bridge verb, the negation and the
#: surface strided so the walk covers every one of each (the floor clause below proves it).
DEGREE_VERB_GAPS = tuple(f" {d} {v} " for d in DEGREES for v in VERBS)
#: Both axes walk with step one and the door holds more rows than either table has
#: entries, so the negation axis and the surface axis are each covered whole - no
#: stride arithmetic to get wrong, and the floor clause below proves it either way.
GAP_ROWS = [(gap, SHARED_NEGATIONS[i % len(SHARED_NEGATIONS)],
            VALUES[i % len(VALUES)])
            for i, gap in enumerate(DEGREE_VERB_GAPS)]


@pytest.mark.parametrize("gap,negation,value", GAP_ROWS,
                         ids=[f"{g}|{c}|{v}" for g, c, v in GAP_ROWS])
def test_a_degree_adverb_before_the_bridge_verb_keeps_the_refusal_whole(
        gap: str, negation: str, value: str) -> None:
    """The adverb may sit in front of the verb the cue governs - "not really like spicy".

    The cue governs the verb; the adverb modifies the value. Two words, in that order, and
    nothing else.
    """
    sentence = _prepare(_phrase(negation, gap, value))
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(extract_intent(sentence)), (
        f"{_phrase(negation, gap, value)!r} wrote "
        f"{sorted(_written(extract_intent(sentence))) or 'nothing'} - the gap {gap!r} did "
        f"not keep the refusal whole")


#: the sentences this unit was measured on, plus the shapes that already worked.
SHAPES = (
    ("not very spicy", {("cuisine_avoid", "spicy")}),
    ("not really like spicy", {("cuisine_avoid", "spicy")}),
    ("don't really want spicy", {("cuisine_avoid", "spicy")}),
    ("I do not really want spicy food", {("cuisine_avoid", "spicy")}),
    ("唔好 very 辣", {("cuisine_avoid", "spicy")}),
    ("唔好 really like 辣", {("cuisine_avoid", "spicy")}),
    ("not quite spicy", {("cuisine_avoid", "spicy")}),
    ("not so spicy", {("cuisine_avoid", "spicy")}),
    ("not too spicy", {("cuisine_avoid", "spicy")}),
    ("唔好咁辣", {("cuisine_avoid", "spicy")}),
    ("唔好太辣", {("cuisine_avoid", "spicy")}),
)


@pytest.mark.parametrize("text,want", SHAPES, ids=[t for t, _w in SHAPES])
def test_the_measured_sentences_read(text: str, want) -> None:
    """Every shape the degree vocabulary names, in either script."""
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads {sorted(want)}")


#: what the degree gap must NOT become: a word that is neither a degree nor a verb still
#: separates the cue from its object, and a boundary or a coordinator still ends the
#: clause wherever it sits.
NOT_READ = (
    ("no rush want spicy", set()),
    ("not very, spicy", set()),
    ("not really, spicy", set()),
    ("not very and spicy", set()),
    ("辣，唔好", set()),
)


@pytest.mark.parametrize("text,want", NOT_READ, ids=[t for t, _w in NOT_READ])
def test_a_word_that_is_neither_a_degree_nor_a_verb_still_separates(text: str, want) -> None:
    """D536's hole stays shut, and the boundary keeps its teeth around the adverb.

    "rush" is a noun: "no rush want spicy" refuses nothing. A comma after the adverb is
    still a clause boundary.
    """
    got = _written(extract_intent(_prepare(text)))
    assert got == set(want), (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads {sorted(want)}")


def test_the_censuses_walk_the_whole_vocabulary():
    """A door that walks nothing agrees vacuously - and so does a strided one that misses.

    The gap axis strides the negation and the surface; this clause holds the stride to the
    coverage it claims, so a longer table cannot quietly drop a row from the walk.
    """
    assert VALUES and SHARED_NEGATIONS and DEGREES and VERBS, (
        "a table this door reads is empty - the rows above agree by reading nothing")
    assert {n for _g, n, _v in GAP_ROWS} == set(SHARED_NEGATIONS), (
        "the strided gap walk misses a negation - fix the stride, do not drop the clause")
    assert {v for _g, _n, v in GAP_ROWS} == set(VALUES), (
        "the strided gap walk misses a surface - fix the stride, do not drop the clause")
    keys = {RULE_OF[v] for v in VALUES}
    assert not set(RULE_KEYS) - keys, (
        f"the census walks no value for {sorted(set(RULE_KEYS) - keys)} - that rule's "
        "degree-gap direction is untested")
