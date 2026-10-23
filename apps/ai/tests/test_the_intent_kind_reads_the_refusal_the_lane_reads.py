"""D541 - the intent kind answers its question with the ONE reader.

The module asks two questions about a refusal: what does the search plan filter for
(`_fill_constraints`), and is this turn a discovery at all (`_has_constraint`). D536
moved the first question to the clause rule and left the second on D536's
eight-character window - so the two answers about one sentence could disagree:

    no cilantro    ->  constraint diet_avoid:coriander    intent unknown
    no coriander   ->  constraint diet_avoid:coriander    intent unknown
    peanut hate    ->  constraint diet_avoid:peanut       intent unknown

The constraint was read and the answer was "I do not know what you are looking for".
The window was also a substring test, so a cue inside a word counted as a refusal
("no" in "snow peanut"), which is the D480 shape - the ONE matcher reads a cue as a
word. Both questions are now answered by `constraint_hits`, the reader the lane
itself reads through, so they cannot part company again.

The population is derived from the rules' own tables: the cues are the negations BOTH
tables carry (the four the constraint table alone reads are the D493 debt), and the
values are the rules' own surfaces, in both orders a user writes them.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.canonical import canonical, canonical_node
from nexus_ai.nlu.lexicon import CONSTRAINT_RULES, canon_constraint, normalize_query
from nexus_ai.nlu.understand import _has_constraint, constraint_hits, extract_intent

#: Every negation, as the ONE matcher wants it - stripped of the trailing space a Latin
#: entry carries (D538), and canonicalised the way both tables are at import.
RULE_NEGATIONS = canonical_node(tuple(dict.fromkeys(
    n.strip() for _k, negs, _v in CONSTRAINT_RULES for n in negs)))
POLARITY_NEGATIONS = canonical_node(tuple(c.strip() for c in P.NEGATION_CUES))
SHARED_NEGATIONS = tuple(c for c in RULE_NEGATIONS if c in POLARITY_NEGATIONS)

#: Every surface a constraint rule can name, and the rule that carries it.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_OF = {v.strip(): k for k, _n, vs in CONSTRAINT_RULES for v in vs}


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


def _forward(value: str, cue: str) -> str:
    """The English order: the cue, then the value.

    A Latin cue needs its space; a Chinese one does not.
    """
    return f"{cue} {value}" if cue.isascii() else f"{cue}{value}"


def _backward(value: str, cue: str) -> str:
    """The Cantonese order: the value, then the cue (D539)."""
    return f"{value} {cue}" if cue.isascii() else f"{value}{cue}"


#: the census: every surface the rules name, under every negation both tables read.
ROWS = [(value, cue) for value in VALUES for cue in SHARED_NEGATIONS]


@pytest.mark.parametrize("value,cue", ROWS, ids=[f"{v}|{c}" for v, c in ROWS])
def test_the_intent_kind_reads_the_refusal_the_lane_reads(value: str, cue: str) -> None:
    """A refusal the lane writes is a discovery: the intent kind never answers 'unknown'."""
    sentence = _prepare(_forward(value, cue))
    ex = extract_intent(sentence)
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(ex), (
        f"{_forward(value, cue)!r} wrote {sorted(_written(ex)) or 'nothing'} - the lane no "
        f"longer reads its own refusal")
    assert ex.intent == "discover_merchant", (
        f"{_forward(value, cue)!r} came back with the intent {ex.intent!r} - the constraint "
        f"is written and the answer is \"I do not know what you are looking for\"")


#: the same walk in the Cantonese order.
BACKWARD = [(value, SHARED_NEGATIONS[i % len(SHARED_NEGATIONS)])
            for i, value in enumerate(VALUES)]


@pytest.mark.parametrize("value,cue", BACKWARD, ids=[f"{v}|{c}|bw" for v, c in BACKWARD])
def test_the_intent_kind_reads_the_backward_refusal_too(value: str, cue: str) -> None:
    """The Cantonese order is a refusal too, and the intent kind answers the same way."""
    sentence = _prepare(_backward(value, cue))
    ex = extract_intent(sentence)
    assert ex.intent == "discover_merchant", (
        f"{_backward(value, cue)!r} came back with the intent {ex.intent!r} - the value "
        f"sits before the cue and the intent kind read nothing")


#: the measured holes, each with the intent it must answer with now.
MEASURED = (
    ("no cilantro", "discover_merchant", ("diet_avoid", "coriander")),
    ("no coriander", "discover_merchant", ("diet_avoid", "coriander")),
    ("peanut hate", "discover_merchant", ("diet_avoid", "peanut")),
    ("I want no cilantro", "discover_merchant", ("diet_avoid", "coriander")),
    ("no cilantro please", "discover_merchant", ("diet_avoid", "coriander")),
    ("唔要咖喱", "discover_merchant", ("cuisine_avoid", "curry")),
    ("咖喱唔要", "discover_merchant", ("cuisine_avoid", "curry")),
)


@pytest.mark.parametrize("text,want_intent,want", MEASURED,
                         ids=[t for t, _i, _w in MEASURED])
def test_the_measured_holes_are_closed(text, want_intent, want):
    """The sentence that wrote a constraint and answered 'unknown' now answers discovery."""
    ex = extract_intent(_prepare(text))
    assert ex.intent == want_intent, (
        f"{text!r} answers the intent {ex.intent!r}, it answers {want_intent!r}")
    assert want in _written(ex), (
        f"{text!r} wrote {sorted(_written(ex)) or 'nothing'} - the lane reads {want}")


#: a cue inside a word is not a cue (D480), and the window used to read it as one.
NOT_REFUSALS = (
    ("snow peanut", set()),
    ("notebook spicy", set()),
    ("know beef", set()),
)


@pytest.mark.parametrize("text,want", NOT_REFUSALS, ids=[t for t, _w in NOT_REFUSALS])
def test_a_cue_inside_a_word_is_not_a_refusal(text, want):
    """The ONE matcher reads a cue as a word, and the intent kind reads it the same way.

    The intent itself is not the claim: "notebook spicy" is a discovery because the
    cuisine vocabulary names the spicy (D394), not because anything was refused. What
    the window got wrong is the CONSTRAINT - and the intent kind's own answer, which
    is what `_has_constraint` is for.
    """
    sentence = _prepare(text)
    ex = extract_intent(sentence)
    assert _written(ex) == set(want), (
        f"{text!r} wrote {sorted(_written(ex)) or 'nothing'} - a cue inside a word is not "
        f"a refusal")
    assert not _has_constraint(sentence), (
        f"{text!r}: the intent kind answers that the text carries a refusal - the cue is "
        f"inside a word and the ONE matcher does not read it")


def test_the_two_questions_are_answered_by_one_reader():
    """The intent kind's answer is the lane's answer, by construction and not by luck."""
    for text in ("no cilantro", "咖喱唔要", "snow peanut", "有冇咖喱", "no rush want spicy",
                 "我想食日本菜"):
        sentence = _prepare(text)
        assert _has_constraint(sentence) == bool(constraint_hits(sentence)), (
            f"{text!r}: the intent kind answers {_has_constraint(sentence)} and the lane "
            f"answers {bool(constraint_hits(sentence))} - two readers again")


def test_the_census_population_is_real():
    """A door that walks nothing agrees vacuously."""
    assert VALUES and SHARED_NEGATIONS, (
        "the rules carry no surface, or no negation both tables read - the rows above "
        "are empty and their green means nothing")

