"""D540 - a verb after the comma opens the next clause.

D538 read the separator directly under a cue as the cue's own punctuation, so a comma
could never come between a refusal and its object: "唔好，辣" refuses the 辣. That is
right when the cue's OBJECT follows the comma - and wrong when a VERB does. Measured at
HEAD, three sentences the product answers with read the refusal onto the thing the next
clause asks for:

    唔好，要辣        ->  辣 -1, cuisine_avoid:spicy    (the user asked for the 辣)
    辣嘅唔好，要咖喱   ->  咖喱 -1, cuisine_avoid:curry   (ditto)
    咖喱唔好，想食辣   ->  cuisine_avoid:spicy, on top of the curry

The search filtered for the very thing the user asked for and the ranking demoted it -
the D522 shape, from one character of punctuation. The signal that tells the two apart
is the verb: a bare noun after the comma is the refusal's own object (the pause), and a
verb opens a new clause's request. `forward_gap` therefore keeps the separator in the
gap when one was stripped and what follows opens with a verb, and `clause_attached`
reads the boundary it has spelled since D535.

The control is the other half of the same rule, and it is why this is not simply "a
comma always ends the clause": with NO comma there is no separator to read, and the
verb is the clause's own bridge - "唔好食辣" and "don't want spicy" refuse the 辣 and
the spicy exactly as they did before. Only a STRIPPED separator arms the new reading,
and only against a verb.

The population is derived from the module's own tables: the verbs are `_VERB_BRIDGE`,
the values are the constraint rules' surfaces, and the punctuation is the lexicon's
`CLAUSE_PUNCTUATION` (plus the line break, which the normalizer also turns into a
separator). A verb or a punctuation added to the tables is walked by this door by
itself, and every row charges BOTH lanes: the polarity reading and the constraint the
search plan would filter on.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import polarity as P
from nexus_ai.nlu.canonical import canonical
from nexus_ai.nlu.lexicon import (
    CLAUSE_PUNCTUATION,
    CONSTRAINT_RULES,
    canon_constraint,
    normalize_query)
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: Every verb that may bridge a refusal and its object INSIDE one clause (D535). After a
#: separator, the same word opens the next clause instead.
VERBS = tuple(P._VERB_BRIDGE)

#: Every surface a constraint rule can name, and the rule that carries it.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_OF = {v.strip(): k for k, _n, vs in CONSTRAINT_RULES for v in vs}


def _prepare(text: str) -> str:
    """The text both lanes are handed in production - normalised, then canonical."""
    return canonical(normalize_query(text))


def _written(ex) -> set[tuple[str, str]]:
    return {(c["key"], c["value"]) for c in ex.constraints}


def _cue_and_gap(verb: str) -> tuple[str, str]:
    """The refusal and the separator, in the script the verb is written in.

    A Latin cue is a word and needs its space; a Chinese one is the characters.
    """
    return ("唔好", "，") if not verb.isascii() else ("no", ",")


def _asks(verb: str, value: str) -> str:
    """The next clause asking for the value: a separator, the verb, the value."""
    cue, comma = _cue_and_gap(verb)
    return f"{cue}{comma}{verb} {value}" if verb.isascii() else f"{cue}{comma}{verb}{value}"


def _refuses(verb: str, value: str) -> str:
    """The one clause: the cue, the bridging verb, the value - no separator anywhere."""
    cue, _comma = _cue_and_gap(verb)
    return f"{cue} {verb} {value}" if verb.isascii() else f"{cue}{verb}{value}"


def _pauses(value: str) -> str:
    """The pause: the separator, then the refusal's own object."""
    return f"唔好，{value}" if not value.isascii() else f"no, {value}"


#: the census: every verb the bridge table names, over every surface the rules name,
#: with a separator between the cue and the verb.
ROWS = [(verb, value) for verb in VERBS for value in VALUES]


@pytest.mark.parametrize("verb,value", ROWS, ids=[f"{v}+{s}" for v, s in ROWS])
def test_a_verb_after_the_separator_asks_for_the_value(verb: str, value: str) -> None:
    """The next clause asks for the value; the refusal in the one before it does not reach it."""
    sentence = _prepare(_asks(verb, value))
    ex = extract_intent(sentence)
    written = _written(ex)
    assert (RULE_OF[value], canon_constraint(value)) not in written, (
        f"{_asks(verb, value)!r} wrote {sorted(written) or 'nothing'} - the comma ended the "
        f"cue's clause and {verb!r} opens the next one, which asks for {value!r}")

    low = sentence.lower()
    for surface in VALUES:
        if cue_in(surface, sentence, low):
            sign = P.polarity_for(sentence, surface)
            assert sign == 1, (
                f"{sentence!r}: the polarity lane read {surface!r} {sign:+d} - the next clause "
                f"asks for it and the refusal sits in the one before")


@pytest.mark.parametrize("verb,value", ROWS, ids=[f"{v}+{s}" for v, s in ROWS])
def test_the_same_verb_inside_one_clause_still_refuses(verb: str, value: str) -> None:
    """No separator, no boundary: the verb bridges inside the clause (D535), as before."""
    sentence = _prepare(_refuses(verb, value))
    ex = extract_intent(sentence)
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(ex), (
        f"{_refuses(verb, value)!r} wrote {sorted(_written(ex)) or 'nothing'} - the verb "
        f"bridges the cue to {value!r} inside the one clause")

    # The row's own value only. A surface that sits INSIDE another one ("煙" inside
    # "二手煙") can be further from the cue than the clause's reach, and then it reads
    # +1 while the longer form is refused - the two lanes still agree about it (no
    # constraint is written for it either), so it is the reader's reach, not this door.
    assert P.polarity_for(sentence, value) == -1, (
        f"{sentence!r}: the polarity lane read {value!r} as a LIKE - the cue governs it "
        f"through the verb")


#: the pause census: a bare noun after the separator is still the refusal's own object.
PAUSES = [(value,) for value in VALUES]


@pytest.mark.parametrize("value,", PAUSES, ids=[v for v, in PAUSES])
def test_a_noun_after_the_separator_is_still_the_cues_object(value: str) -> None:
    """D538's pause reading, held: the comma did not become a boundary here."""
    sentence = _prepare(_pauses(value))
    ex = extract_intent(sentence)
    want = (RULE_OF[value], canon_constraint(value))
    assert want in _written(ex), (
        f"{_pauses(value)!r} wrote {sorted(_written(ex)) or 'nothing'} - the separator under "
        f"the cue is the cue's own punctuation and {value!r} is its object")
    assert P.polarity_for(sentence, value) == -1, (
        f"{sentence!r}: the polarity lane read {value!r} as a LIKE - the pause reading "
        f"moved")


#: every punctuation the normalizer rewrites into the separator, with the verb shape.
PUNCTUATED = [(ch,) for ch in sorted(CLAUSE_PUNCTUATION)]


@pytest.mark.parametrize("ch,", PUNCTUATED, ids=[repr(c) for c, in PUNCTUATED])
def test_every_clause_punctuation_opens_the_next_clause_before_a_verb(ch: str) -> None:
    """The reading does not hang on the comma: whatever the normalizer rewrites, reads."""
    sentence = _prepare(f"唔好{ch}要辣")
    assert P.polarity_for(sentence, "辣") == 1, (
        f"{ch!r} did not open the next clause - 辣 reads "
        f"{P.polarity_for(sentence, '辣'):+d} and the next clause asks for it")
    assert not _written(extract_intent(sentence)), (
        f"{ch!r} left a constraint behind: "
        f"{sorted(_written(extract_intent(sentence)))} - the refusal governs nothing in "
        f"the next clause")


def test_a_line_break_opens_the_next_clause():
    """The normalizer turns a line break into the separator too (D538)."""
    sentence = _prepare("唔好\n要食辣")
    assert P.polarity_for(sentence, "辣") == 1
    assert not _written(extract_intent(sentence))


#: the three measured defects, with everything the product answered for them.
MEASURED = (
    ("唔好，要辣", {"辣": 1}, set()),
    ("辣嘅唔好，要咖喱", {"辣": -1, "咖喱": 1}, {("cuisine_avoid", "spicy")}),
    ("咖喱唔好，想食辣", {"咖喱": -1, "辣": 1}, {("cuisine_avoid", "curry")}),
)


@pytest.mark.parametrize("text,polarities,want", MEASURED,
                         ids=[t for t, _p, _w in MEASURED])
def test_the_measured_defects_are_closed(text, polarities, want):
    """What the product answered with two hands before this unit, it answers with one."""
    sentence = _prepare(text)
    ex = extract_intent(sentence)
    assert _written(ex) == set(want), (
        f"{text!r} wrote {sorted(_written(ex)) or 'nothing'} - the lane writes "
        f"{sorted(want) or 'nothing'}")
    for token, sign in polarities.items():
        assert P.polarity_for(sentence, token) == sign, (
            f"{text!r}: {token!r} reads {P.polarity_for(sentence, token):+d}, it reads "
            f"{sign:+d} now")


#: the minimal pair, and the whitespace that goes with the punctuation.
PAIRS = (
    ("唔好，辣", "辣", -1),
    ("唔好，要辣", "辣", 1),
    ("唔好， 要辣", "辣", 1),
    ("唔好，想食辣", "辣", 1),
    ("唔好食辣", "辣", -1),
    ("no, spicy", "spicy", -1),
    ("no, want spicy", "spicy", 1),
    ("don't want spicy", "spicy", -1),
)


@pytest.mark.parametrize("text,token,want", PAIRS, ids=[t for t, _k, _w in PAIRS])
def test_the_pause_and_the_boundary_are_told_apart(text, token, want):
    """One comma, one verb: the difference between a pause and a clause edge."""
    assert P.polarity_for(_prepare(text), token) == want, (
        f"{text!r} reads {token!r} {P.polarity_for(_prepare(text), token):+d}, it reads "
        f"{want:+d}")


def test_the_census_population_is_real():
    """A door that walks nothing agrees vacuously."""
    assert VERBS and VALUES and CLAUSE_PUNCTUATION, (
        "the bridge table, the rules' surfaces or the clause punctuation is empty - the "
        "rows above are empty and their green means nothing")

