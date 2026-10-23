# -*- coding: utf-8 -*-
"""D538 - the clause boundary survives the normalizer.

Every reader in this package reads governance through the clause: a refusal governs the
value in its own clause, and one verb may bridge the two (D535, D536). The clause had one
problem no reader could fix - by the time a query reached them, the clause comma was a
space. `normalize_query` folded every clause boundary into the same whitespace the words
were separated by, so two clauses arrived as one string:

    想食辣，咖喱唔好   ->  "想食辣 咖喱唔好"   the boundary is gone
    想食辣 咖喱唔好    ->  "想食辣 咖喱唔好"   the same string

The first sentence asks for spicy and refuses the curry; the second is one clause and the
refusal governs the 咖喱 too. Measured before this unit, on the live rule path, the reader
answered -1 for the 咖喱 on the first sentence as well - a refusal of the very thing the
clause before it asked for, which the ranking lane then demoted (the D522 shape). The
D533 gate filed this as the normalizer's residue; this unit spends it.

The normalizer now writes the ideographic space (CLAUSE_SEPARATOR) where the clause
punctuation was. It is whitespace, so every `\s*` in the field rules still reads across it
and no field loses a value to the change; and it is not ASCII whitespace, so the fold that
collapses runs of spaces cannot flatten it back into one. Three readers then read it: the
clause boundary, the filler (a gap holding one is two clauses, not particles), and the
clause-final tail (the cue's own clause ends there, not the turn).

The one place the separator is NOT a boundary is directly under a cue: "唔好，辣" refuses
the 辣, and the comma is a pause after the refusal rather than a boundary between it and
its object. That is `forward_gap`, and it is the forward direction only - a cue that
governs a token BEFORE it keeps every separator in its gap, because there the comma really
did end the token's clause.

The gate holds four things: the separator is what the normalizer says it is, every
punctuation it rewrites is a boundary the readers can see, the sentences the comma used to
smear now read as the clauses the user wrote, and nothing the clause rule already read has
moved.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.canonical import canonical
from nexus_ai.nlu.lexicon import CLAUSE_PUNCTUATION, normalize_query
from nexus_ai.nlu.polarity import (
    CLAUSE_SEPARATOR,
    _CLAUSE_BOUNDARY,
    polarity_for,
)
from nexus_ai.nlu.understand import extract_intent


def read(query: str) -> str:
    """The text the lanes actually receive: normalised, then canonicalised."""
    return canonical(normalize_query(query))


def constraints(query: str) -> set[tuple[str, str]]:
    """The (key, value) pairs the constraint lane writes for `query`."""
    return {(c["key"], c["value"]) for c in extract_intent(query).constraints}


# ------------------------------------------------------------------ the separator
def test_the_separator_is_whitespace_the_fold_cannot_flatten():
    """Whitespace the field rules read across, and not the whitespace they fold away."""
    assert CLAUSE_SEPARATOR.isspace(), (
        "the separator must be whitespace, or every `\\s*` in the field rules stops "
        "reading across it and a clause comma starts costing values")
    assert CLAUSE_SEPARATOR not in " \\t\\r\\n", (
        "the separator must not be ASCII whitespace, or the fold that collapses runs of "
        "spaces flattens it back into one and the boundary is gone again")


@pytest.mark.parametrize("ch", sorted(CLAUSE_PUNCTUATION), ids=sorted(CLAUSE_PUNCTUATION))
def test_every_clause_punctuation_becomes_the_separator(ch):
    """A character the normalizer rewrites must become the separator, and nothing else."""
    assert normalize_query(f"a{ch}b") == "a" + CLAUSE_SEPARATOR + "b", (
        f"{ch!r} did not become the clause separator - the boundary it stands for is "
        f"invisible to every reader downstream")


def test_the_separator_itself_is_a_boundary():
    """The one character the normalizer writes must be a boundary the readers can see."""
    assert _CLAUSE_BOUNDARY.search(CLAUSE_SEPARATOR), (
        "the separator is not a boundary - no clause edge survives normalisation")


@pytest.mark.parametrize("ch", sorted(CLAUSE_PUNCTUATION), ids=sorted(CLAUSE_PUNCTUATION))
def test_every_clause_punctuation_becomes_a_boundary_the_readers_see(ch):
    """The census the whole unit rests on: what the normalizer rewrites, the readers read.

    A punctuation character that survives normalisation as itself is a clause edge no
    reader can see, and the sentence reads exactly as it did before this unit. The
    normalizer owns the table (CLAUSE_PUNCTUATION), so punctuation added there is held to
    the boundary by construction rather than by memory.
    """
    text = canonical(normalize_query(f"辣{ch}唔好"))
    assert _CLAUSE_BOUNDARY.search(text), (
        f"the normalizer rewrote {ch!r} and no boundary is left in {text!r} - the two "
        f"clauses are one string again and no reader can tell them apart")
    assert polarity_for(text, "辣") == 1, (
        f"{ch!r} did not separate the clauses - the refusal in the second one governed "
        f"the token in the first")


def test_the_colon_is_not_clause_punctuation():
    """A colon between digits is a clock time; the other one is a plain space."""
    assert normalize_query("7:30pm") == "7:30pm"
    assert normalize_query("價錢：餐廳") == "價錢 餐廳"
    assert ":" not in CLAUSE_PUNCTUATION and "：" not in CLAUSE_PUNCTUATION


def test_ascii_whitespace_still_folds_and_the_separator_does_not():
    """The fold survives, narrowed to the whitespace it was always meant for."""
    assert normalize_query("a   b") == "a b"
    assert normalize_query("a" + CLAUSE_SEPARATOR + "b") == "a" + CLAUSE_SEPARATOR + "b"


def test_the_whitespace_around_the_punctuation_goes_with_it():
    """The separator stands alone between the two clauses - one boundary, not three gaps."""
    assert normalize_query("辣 ， 唔好") == "辣" + CLAUSE_SEPARATOR + "唔好"


# ------------------------------------------------------------------ what it fixes
#: the sentences measured before this unit: the refusal sits in the clause AFTER the
#: token's, and the token must keep its LIKE.
SMEARED = (
    ("辣，唔好", "辣"),
    ("想食辣，咖喱唔好", "辣"),
    ("quiet, no noisy please", "quiet"),
    ("想找個安靜的咖啡店，唔好辣", "安靜"),
)


@pytest.mark.parametrize("text,token", SMEARED, ids=[t for t, _k in SMEARED])
def test_a_refusal_in_the_next_clause_does_not_reach_back(text, token):
    """The comma ends the token's clause; the refusal belongs to the one after it."""
    assert polarity_for(read(text), token) == 1, (
        f"{text!r} read {token!r} as a dislike - the refusal sits in the next clause and "
        f"the boundary between them is what says so")


#: the cue at the end of its OWN clause, with another clause after it. The reader that ran
#: to the end of the sentence answered +1 for these; the clause ends where the comma is.
GAINED = (
    ("安靜的不好，要嘈", "安靜"),
    ("想食辣，唔好嘈，要安靜", "嘈"),
    ("辣嘅唔好，要咖喱", "辣"),
)


@pytest.mark.parametrize("text,token", GAINED, ids=[t for t, _k in GAINED])
def test_a_cue_final_in_its_own_clause_governs_the_token_before_it(text, token):
    """The tail is the cue's clause, not the turn: nothing follows it IN ITS CLAUSE."""
    assert polarity_for(read(text), token) == -1, (
        f"{text!r} read {token!r} as a LIKE - the cue is final in its own clause, and the "
        f"words after the comma belong to the next one")


# ------------------------------------------------------------------ what must hold
#: the forward direction, the separator that sits under the cue, and the after-cases the
#: earlier units fixed. None of these may move.
UNMOVED = (
    ("no spicy", "spicy", -1),
    ("唔好食辣", "辣", -1),
    ("don't want spicy", "spicy", -1),
    ("I do not want spicy food", "spicy", -1),
    ("not too spicy", "spicy", -1),
    ("唔好，辣", "辣", -1),
    ("no, spicy", "spicy", -1),
    ("素食唔好", "素食", -1),
    ("安靜的不好", "安靜", -1),
    ("辣唔好呀", "辣", -1),
    ("cheap, no curry", "cheap", 1),
    ("cheap, no curry", "curry", -1),
    ("cheap and no curry", "cheap", 1),
    ("cheap and no curry", "curry", -1),
    ("I want spicy no cilantro", "spicy", 1),
)


@pytest.mark.parametrize("text,token,want", UNMOVED, ids=[t for t, _k, _w in UNMOVED])
def test_the_readings_the_clause_rule_already_had(text, token, want):
    """The separator is allowed to give the rule reach, never to take a reading away."""
    assert polarity_for(read(text), token) == want, (
        f"{text!r} moved: {token!r} now reads {polarity_for(read(text), token)}, it read "
        f"{want} before this unit")


# ------------------------------------------------------------------ the other lane
CONSTRAINT_READS = (
    ("no, spicy", {("cuisine_avoid", "spicy")}),
    ("唔好，辣", {("cuisine_avoid", "spicy")}),
    ("cheap, no curry", {("cuisine_avoid", "curry")}),
    ("唔好辣，想找個安靜的咖啡店", {("cuisine_avoid", "spicy")}),
    ("no rush, want spicy", set()),
    ("no rush want spicy", set()),
)


@pytest.mark.parametrize("text,want", CONSTRAINT_READS, ids=[t for t, _w in CONSTRAINT_READS])
def test_the_constraint_lane_reads_the_same_clauses(text, want):
    """The two lanes read one grammar: what one refuses, the other refuses."""
    assert constraints(text) == want, (
        f"{text!r} wrote {sorted(constraints(text)) or 'nothing'} - the lane reads "
        f"{sorted(want) or 'nothing'}")


def test_a_refusal_in_the_next_clause_writes_no_constraint():
    """The behavioural half of the smear: the search plan does not filter for it either."""
    assert constraints("想食辣，咖喱唔好") == set()


# ------------------------------------------------------------------ the field rules
def test_the_field_rules_still_read_across_the_separator():
    """The separator is whitespace: the field regexes keep every value they used to read.

    The query is the evaluation's own comma'd discovery turn - district, budget, two
    preferences and a time window on the far side of three clause commas.
    """
    ex = extract_intent("帮我找沙田适合情侣约会的餐厅，预算500港币，安静一点，周六晚上")
    assert ex.intent == "discover_merchant"
    assert ex.category == "restaurant"
    assert ex.budget and ex.budget["max"] == 500.0
    assert {(p["key"], p["value"]) for p in ex.preferences} >= {
        ("ambience", "quiet"), ("occasion", "date")}


def test_a_cue_the_user_punctuated_still_reads():
    """A space inside a cue reads as any whitespace: "make a, table" is still a booking."""
    ex = extract_intent("make a, table for 2")
    assert ex.intent == "reserve"
    assert ex.party_size == 2
