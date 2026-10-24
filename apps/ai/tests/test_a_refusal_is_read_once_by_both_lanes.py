"""D539 - the two lanes that read a refusal must answer to one sentence, twice over.

D538 gave the polarity lane the constraint lane's locator and reach. This door is what
the pair owes each other once they share both, and it is written as the two questions a
user can actually feel:

  * does the LANE read what the other READS? For a sentence built from a negation the
    product knows, one of the clause's own gap shapes and one of the rules' own surfaces,
    the constraint table writes a refusal exactly where the polarity table reads a
    dislike. Cues the polarity table does not carry are excluded from this row - they are
    the second question, not a footnote to the first.
  * does the PRODUCT answer with one voice? A refusal the search filters for must never
    also be a preference the ranking boosts. This is the seam the user walks into: the
    constraint value goes into the plan's `avoid` list and the preference's polarity goes
    into the order, so a sentence that writes both gives a merchant list with the
    refused thing removed from it AND floated to the top of what is left.

The second question is narrower than it looks, and that is a finding rather than a
limitation: only a few values are named by BOTH vocabularies, so only those can contradict.
The set is derived from the tables here, never typed - when a value joins either vocabulary
the door takes it up by itself, and if the derived set ever came out empty the floor clause
would say so instead of agreeing vacuously.

The population is derived, not hand-written: negations come from the constraint rules' own
list, gap shapes come from the tables `clause_attached` is defined over, and values from the
rules' own surfaces. What a shape's class *is* gets asserted against the prepared text, so
the door re-classifies when the normalizer changes - the clause comma is the case in point.
Under the old normaliser a comma arrived as a space and no reader could see the boundary;
the shapes below are classified by what the prepared text actually says, so the door lands
on whichever side of that change its basis is.
"""

from __future__ import annotations

import re

import pytest

from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.canonical import canonical, canonical_node
from nexus_ai.nlu.lexicon import (
    CONSTRAINT_RULES,
    CUISINE_TERMS,
    PREFERENCE_RULES,
    canon_constraint,
    normalize_query)
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: Every negation, as the ONE matcher wants it - stripped of the trailing space a Latin
#: entry carries (D538), and canonicalised the way both tables are at import.
RULE_NEGATIONS = canonical_node(tuple(dict.fromkeys(
    n.strip() for _k, negs, _v in CONSTRAINT_RULES for n in negs)))
POLARITY_NEGATIONS = canonical_node(tuple(c.strip() for c in P.NEGATION_CUES))

#: the negations BOTH lanes read - the population the agreement rows are built from.
SHARED_NEGATIONS = tuple(c for c in RULE_NEGATIONS if c in POLARITY_NEGATIONS)

#: the negations the constraint table reads and the polarity table does not. The pin is
#: the debt: it may shrink as the vocabulary is unified, and must not grow. The one list
#: is what D493's door argues for; it holds that direction only, which is why this half
#: could open. Filed as the next unit, with the word-boundary question 別 and 少 bring.
NEGATIONS_THE_POLARITY_LANE_LACKS = ("不吃", "別", "少", "避免")
UNSHARED_NEGATIONS = tuple(c for c in RULE_NEGATIONS if c not in POLARITY_NEGATIONS)

#: Every surface a constraint rule can name, and the key each rule files it under.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_KEYS = tuple(k for k, _n, _v in CONSTRAINT_RULES)

#: the values BOTH vocabularies name - the only ones that can be filtered out and boosted
#: in the same turn. A constraint value meets a preference value where the preference rules
#: carry it or the cuisine terms key it.
PREFERENCE_VALUES = ({value for _k, value, _t, _p in PREFERENCE_RULES}
                     | set(CUISINE_TERMS))


def _collision_values() -> tuple[str, ...]:
    return tuple(sorted({canon_constraint(v) for _k, _n, vs in CONSTRAINT_RULES
                         for v in vs} & PREFERENCE_VALUES))


#: the surfaces whose canon value is collision-capable - what the seam rows walk.
COLLISION_SURFACES = tuple(sorted({s.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs
                                   for s in [v]
                                   if canon_constraint(v.strip()) in _collision_values()}))


def _class_members(pattern: str) -> tuple[str, ...]:
    """The characters a table's bracket class declares, escapes read, so a new member of
    `_LOCAL_FILLER` or `_CLAUSE_BOUNDARY` joins this door by itself (D477)."""
    body = pattern[pattern.index("[") + 1:pattern.index("]")]
    out: list[str] = []
    for token in re.findall(r"\\.|.", body):
        ch = {"\\s": " ", "\\n": "\n", "\\t": "\t"}.get(token, token)
        if ch and ch not in out:
            out.append(ch)
    return tuple(out)


#: gaps that end the refusal's clause: a coordinator, a clause boundary, and gaps too long
#: to be filler and not a single verb from the bridge.
SEPARATING = (tuple(f" {c} " for c in P._CLAUSE_CONJUNCTIONS)
              + tuple(f" {ch} " for ch in _class_members(P._CLAUSE_BOUNDARY.pattern))
              + (" want to eat ", " much of the ", " so very "))

#: gaps inside it: nothing, a space, a word too short to be a clause of its own, one verb
#: from the bridge, one sentence particle from the filler class, one degree adverb from
#: the table D544 added (a degree word modifies the value; it opens no clause).
ATTACHING = ("", " ", " the ") + tuple(
    f" {v} " for v in P._VERB_BRIDGE) + tuple(
    f" {d} " for d in P._DEGREE_ADVERBS) + tuple(
    f" {ch} " for ch in _class_members(P._LOCAL_FILLER.pattern) if ch not in " \t")

SHAPES = ATTACHING + SEPARATING

#: the door's rows: one sentence per gap shape, twice, with the negation and the value
#: walking their own tables so every one of the three axes is exercised.
ROWS = [(shape, SHARED_NEGATIONS[(i + stride * 7) % len(SHARED_NEGATIONS)],
         VALUES[(i + stride * 13) % len(VALUES)])
        for stride in (0, 1) for i, shape in enumerate(SHAPES)]


def _phrase(negation: str, shape: str, value: str) -> str:
    """The three parts as a user writes them. An English negation needs its space, a
    Chinese one does not, and the gap goes between the cue and the thing it may refuse."""
    return f"{negation}{shape} {value}" if negation.isascii() else f"{negation}{shape}{value}"


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


def _boosted(ex) -> set[str]:
    """The values the ranking lane is told to like, straight off the intent."""
    return {p["value"] for p in ex.preferences if int(p.get("polarity", 1) or 1) > 0}


def _refused(ex) -> set[str]:
    return {value for _k, value in _written(ex)}


@pytest.mark.parametrize("shape", SHAPES, ids=[repr(s) for s in SHAPES])
def test_a_shapes_own_class_is_read_off_the_prepared_text(shape: str):
    """Every gap shape means what this door says it means - on the text the reader gets.

    Derived membership, not an assumption: a shape in ATTACHING must read as one clause and
    a shape in SEPARATING as two, both judged after normalisation and canonicalisation. When
    the normalizer changes what a comma becomes, the premise moves by itself and this row is
    the one that says so.

    The shape is read BETWEEN two words, because a shape that is nothing but a boundary
    normalises to the empty string on its own - and an empty gap is the most attached gap
    there is, so a boundary read alone would look like the filler it is not.
    """
    attached = P.clause_attached(_prepare(f"a{shape}b")[1:-1])
    if shape in ATTACHING:
        assert attached, (
            f"{shape!r} is in the attaching list but the prepared text reads it as a "
            f"different clause - the door's rows no longer test an in-clause gap")
    else:
        assert not attached, (
            f"{shape!r} is in the separating list but the prepared text joins it to the "
            f"clause - a gap the reader joined cannot witness the direction this door holds "
            f"closed (a boundary the input path deletes is a rule nothing can arm)")


@pytest.mark.parametrize("shape,negation,value", ROWS,
                         ids=[f"{s!r}+{c}" for s, c, _v in ROWS])
def test_a_refusal_and_a_dislike_are_the_same_relation(shape: str, negation: str,
                                                       value: str) -> None:
    """Whatever one lane calls a refusal the other calls a dislike - and neither the reverse."""
    sentence = _prepare(_phrase(negation, shape, value))
    keys = {c["value"]: c["key"] for c in extract_intent(sentence).constraints}
    low = sentence.lower()
    # D545: a surface nested inside a longer one ("煙" inside "二手煙") sits further
    # from the cue than the clause's reach, so the constraint lane refuses the longer
    # form and the polarity lane reads the shorter one ungoverned. That is the reach
    # residue, not a contradiction - and it is the SEAM walk below that can contradict,
    # because that one walks only the values both vocabularies name (no nested surface
    # is one of them).
    found = [s for s in VALUES if cue_in(s, sentence, low)]
    readings = [(s, keys.get(canon_constraint(s), ""), P.polarity_for(sentence, s))
                for s in found if not any(o != s and s in o for o in found)]
    assert readings, (
        f"{_phrase(negation, shape, value)!r} carries no value the matcher can find - the "
        f"row would agree by reading nothing")
    for surface, key, sign in readings:
        if key:
            assert sign == -1, (
                f"{sentence!r}: the {key} lane refused {surface!r} so the search plan's avoid "
                f"list carries it, and the polarity lane read it {sign:+d} - the product "
                f"filters for what it also boosts")
        else:
            assert sign != -1, (
                f"{sentence!r}: the polarity lane read {surface!r} as a dislike that no rule "
                f"refuses - a reach this unit retired, and the widening it must not re-open")


#: Every value the two vocabularies share is walked with every negation both lanes read,
#: under an attaching gap and under a separating one: the seam answer must not change with
#: the shape, and must never be "filtered for it AND boosted it".
SEAM_ROWS = [(negation, shape, surface) for negation in SHARED_NEGATIONS
             for shape in ("", " ", "食") for surface in COLLISION_SURFACES]


@pytest.mark.parametrize("negation,shape,surface", SEAM_ROWS,
                         ids=[f"{c}+{s!r}+{v}" for c, s, v in SEAM_ROWS])
def test_the_product_answers_a_refusal_with_one_voice(negation: str, shape: str,
                                                      surface: str) -> None:
    """No value the search plan refuses is also a preference the ranking boosts."""
    sentence = _prepare(_phrase(negation, shape, surface))
    ex = extract_intent(sentence)
    both = _refused(ex) & _boosted(ex)
    assert not both, (
        f"{sentence!r}: the plan's avoid list carries {sorted(both)} and the intent asks the "
        f"ranking to boost the same value - the user gets a result set without the thing they "
        f"refused, ordered as if they wanted it")


def test_the_seam_walk_reaches_a_refusal_of_every_shared_value():
    """A collision door that never wrote a refusal agrees vacuously."""
    reached: set[str] = set()
    for negation, shape, surface in SEAM_ROWS:
        ex = extract_intent(_prepare(_phrase(negation, shape, surface)))
        reached |= _refused(ex)
    missing = sorted(set(_collision_values()) - reached)
    assert not missing, (
        f"the seam rows wrote no refusal for {missing} - those values are named by both "
        f"vocabularies and this door never tested the contradiction for them")


def test_the_two_vocabularies_do_share_values_to_contradict_over():
    """The subject of the seam rows exists.

    Derived, not assumed: if a value ever stops being named by both tables the walk above
    empties and its green means nothing, so the population gets its own floor.
    """
    assert _collision_values(), (
        "no constraint value is also a preference value - then a refusal can never be "
        "boosted and this file's seam rows are dead; say which vocabulary shrank")


def test_the_agreement_rows_reach_every_rule_key():
    """Each of the five refusal keys must be written by at least one row."""
    keys: set[str] = set()
    for shape, negation, value in ROWS:
        sentence = _prepare(_phrase(negation, shape, value))
        keys |= {k for k, _v in _written(extract_intent(sentence))}
    missing = sorted(set(RULE_KEYS) - keys)
    assert not missing, (
        f"the agreement rows wrote no refusal for {missing} - every row was vacuous for that "
        f"key and its green proves nothing")


#: the contradictions D538 was written for: the sentence, the surface the user typed, and
#: the constraint it must write. Each of these read +1 in the polarity lane before it.
MEASURED = (
    ("without 海鮮", "海鮮", "diet_avoid", "seafood"),
    ("without any 奶", "奶", "diet_avoid", "dairy"),
    ("avoid 二手煙", "煙", "smoking_avoid", "smoking"),
)


@pytest.mark.parametrize("phrase,surface,key,value", MEASURED,
                         ids=[p for p, _s, _k, _v in MEASURED])
def test_the_measured_contradictions_are_closed(phrase: str, surface: str, key: str,
                                                value: str) -> None:
    """The bilingual refusal the product answered with two hands now answers with one."""
    sentence = _prepare(phrase)
    got = _written(extract_intent(sentence))
    assert (key, value) in got, f"{sentence!r} wrote {sorted(got) or 'nothing'} - not {key}:{value}"
    sign = P.polarity_for(sentence, surface)
    assert sign == -1, (
        f"{sentence!r}: the refusal of {value!r} is written into the plan and the polarity "
        f"lane reads {sign:+d} - the ranking boosted what the filter had just excluded")


def test_a_latin_negation_inside_a_word_reaches_nothing():
    """The locator's half: where the ONE matcher finds no cue, neither lane may act on one."""
    sentence = _prepare("notebook 海鮮")
    got = _written(extract_intent(sentence))
    assert got == set(), (
        f"{sentence!r} wrote {sorted(got)} - 'no' inside 'notebook' is not a refusal")
    assert P.polarity_for(sentence, "海鮮") == 1, (
        f"{sentence!r}: the polarity lane found a negation the matcher does not")


@pytest.mark.parametrize("negation", UNSHARED_NEGATIONS, ids=list(UNSHARED_NEGATIONS))
def test_a_negation_the_polarity_lane_lacks_still_refuses_and_still_boosts(negation: str):
    """The debt is armed, not merely named: each pinned word must still bite.

    The constraint lane reads these negations and the polarity lane does not, so the
    product still writes the refusal and still boosts the value it refused. This row is the
    measurement that keeps the pin honest - a word added to the pin that does NOT produce
    the contradiction is a hiding place, and a word removed from the tables to make the pin
    shrink is caught by the first clause instead.
    """
    assert negation in RULE_NEGATIONS, (
        f"{negation!r} is pinned as a debt but no constraint rule reads it - the hole was "
        f"closed by deleting the negation, not by teaching the polarity lane to read it")
    bites = []
    for surface in COLLISION_SURFACES:
        sentence = _prepare(_phrase(negation, "", surface))
        ex = extract_intent(sentence)
        if _refused(ex) & _boosted(ex):
            bites.append(sentence)
    assert bites, (
        f"the polarity lane still lacks {negation!r} but no refusal written with it is "
        f"boosted any more - re-measure the debt: the contradiction has moved")


def test_the_debt_pin_is_only_the_words_the_polarity_lane_lacks():
    """The list of negations may shrink as the vocabulary is unified; it may not grow."""
    grown = sorted(set(UNSHARED_NEGATIONS) - set(NEGATIONS_THE_POLARITY_LANE_LACKS))
    assert not grown, (
        f"the constraint rules read {grown} and the polarity table does not - a new negation "
        f"taught to one lane only. Either add it to NEGATION_CUES, or explain in PLAN why "
        f"the ranking must keep reading the value as wanted")
