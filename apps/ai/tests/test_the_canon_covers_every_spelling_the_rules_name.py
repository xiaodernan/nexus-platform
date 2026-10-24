"""D545 - the canon names every spelling the rules carry, and one refusal is one value.

The canon table is what turns a refusal into a value the rest of the product can use: the
Intent's constraints carry it, the search plan's avoid list is built from it, and the SQL
avoid clause compares it with the corpus's own tags. A surface the table does not name
falls back to ITSELF (`canon_constraint`'s last resort), and a Chinese value is a word no
other part of the product speaks. Measured at HEAD:

    "唔好嘈"      ->  noise_avoid:嘈      while  "no noise"  ->  noise_avoid:noise
    "no 長龍"     ->  feature_avoid:長龍   while  "no queue"  ->  feature_avoid:queue
    "不要薑"      ->  diet_avoid:薑       while  "no ginger" ->  diet_avoid:ginger

One refusal, two values, depending on the language the user typed - and the dedup that
should have collapsed them compared two different strings: "no 二手煙" wrote BOTH
(`smoking_avoid:smoking` from the 煙 inside the word and `smoking_avoid:二手煙` from the
longer form), so the plan's avoid list carried the same refusal twice under two names.

The Simplified spelling was worse than uncanonicalised - it was unreadable: 姜 sat in no
table at all, so "不要姜" wrote nothing, the one value the D416/D417 rule (every term
answers to both spellings) never reached.

The fix: the canon names every surface the rules carry, every value it names is a word the
corpus's tags can carry (the corpus writes its tags in English - the leaf names
`avoid_terms` expands - so a value that is not ASCII is a value no SQL leg can match), and
姜 joins the diet rule beside 薑. The door derives its population from the tables - every
surface, every canon value, every nested pair of spellings - so a surface added to a rule
without a canon entry reddens it the moment it exists.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import CONSTRAINT_CANON, CONSTRAINT_RULES, canon_constraint
from nexus_ai.nlu.understand import extract_intent

#: Every surface a constraint rule can name, the rule that carries it, and the canon value.
VALUES = tuple(sorted({v.strip() for _k, _n, vs in CONSTRAINT_RULES for v in vs}))
RULE_OF = {v.strip(): k for k, _n, vs in CONSTRAINT_RULES for v in vs}
RULE_KEYS = tuple(k for k, _n, _v in CONSTRAINT_RULES)

#: the two cues a refusal is read under - the Cantonese spelling and the English one.
CUES = ("唔好", "no ")


def got_constraints(ex) -> set[tuple[str, str]]:
    """The (key, value) pairs the lane wrote, as one comparable set."""
    return {(c["key"], c["value"]) for c in ex.constraints}


@pytest.mark.parametrize("surface", VALUES, ids=list(VALUES))
def test_every_surface_the_rules_name_is_a_key_in_the_canon(surface: str) -> None:
    """No surface falls back to itself: the canon names it, or the rule does not carry it.

    The fallback is silent - a Chinese value reads as the word the user typed, and nothing
    downstream can compare it with the corpus's tags.
    """
    assert surface in CONSTRAINT_CANON, (
        f"the rule {RULE_OF[surface]!r} carries {surface!r} and CONSTRAINT_CANON does not "
        f"name it - a refusal of it writes {canon_constraint(surface)!r}, a value no other "
        f"part of the product reads")


def test_every_canon_value_is_a_word_the_corpus_can_carry():
    """Every canon value is ASCII: the corpus writes its tags in English.

    `avoid_terms` expands the plan's avoid value against the taxonomy's leaves and the
    offering names, and those are English slugs ("seafood-grill", "quiet-hours"). A
    canon value in another script is a value the avoid clause can never match.
    """
    foreign = sorted({v for v in CONSTRAINT_CANON.values() if not v.isascii()})
    assert not foreign, (
        f"CONSTRAINT_CANON names values no corpus tag can carry: {foreign} - spell each "
        f"one as the English word the tags use")


#: the nested spellings: a surface that sits INSIDE another surface of the same rule.
#: Derived, so a longer spelling added to a rule joins the door by itself.
def _nested_pairs() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for long in VALUES:
        for short in VALUES:
            if long != short and short in long and RULE_OF[long] == RULE_OF[short]:
                out.append((long, short))
    return sorted(out)


NESTED = _nested_pairs()


@pytest.mark.parametrize("long,short", NESTED, ids=[f"{a}<{b}" for a, b in NESTED])
def test_a_nested_spelling_writes_one_refusal_not_two(long: str, short: str) -> None:
    """The refusal of the longer form is ONE constraint, spelled the shorter form's way.

    Both surfaces fire - the shorter one sits inside the longer one - and the canon is
    what collapses them. When the two spelled apart, the plan's avoid list carried the
    same refusal twice under two names.
    """
    for cue in CUES:
        sentence = f"{cue}{long}"
        got = got_constraints(extract_intent(sentence))
        want = {(RULE_OF[long], canon_constraint(long))}
        assert got == want, (
            f"{sentence!r} wrote {sorted(got) or 'nothing'} - the lane reads {sorted(want)}")


#: the measured holes, held closed: the Cantonese spelling and the Simplified one read the
#: same English value the English spelling always wrote.
MEASURED = (
    ("唔好嘈", ("noise_avoid", "noise")),
    ("唔好吵鬧", ("noise_avoid", "noise")),
    ("不要薑", ("diet_avoid", "ginger")),
    ("不要姜", ("diet_avoid", "ginger")),
    ("no 長龍", ("feature_avoid", "queue")),
    ("唔好長龍", ("feature_avoid", "queue")),
    ("no 二手煙", ("smoking_avoid", "smoking")),
    ("no want 二手煙", ("smoking_avoid", "smoking")),
)


@pytest.mark.parametrize("text,want", MEASURED, ids=[t for t, _w in MEASURED])
def test_the_measured_holes_read_the_shared_value(text: str, want) -> None:
    """One refusal, one value - whichever script the user typed it in."""
    got = got_constraints(extract_intent(text))
    assert got == {want}, (
        f"{text!r} wrote {sorted(got) or 'nothing'} - the lane reads {want}")


@pytest.mark.parametrize("surface", VALUES, ids=list(VALUES))
def test_no_refusal_writes_a_value_the_product_cannot_read(surface: str) -> None:
    """Every surface, refused under both cues, writes its rule's canon - and nothing else.

    The second half is the point: a sentence that also carries a nested spelling must not
    leave the un-canonicalised surface behind in the constraint list.
    """
    for cue in CUES:
        got = got_constraints(extract_intent(f"{cue}{surface}"))
        assert (RULE_OF[surface], canon_constraint(surface)) in got, (
            f"{cue + surface!r} wrote {sorted(got) or 'nothing'} - the rule "
            f"{RULE_OF[surface]!r} reads the surface as "
            f"{canon_constraint(surface)!r}")
        for key, value in got:
            assert value.isascii(), (
                f"{cue + surface!r} wrote {key}:{value} - a value the corpus's tags "
                f"cannot carry")


def test_the_door_walks_a_real_population():
    """A door that walks nothing agrees vacuously."""
    assert VALUES and CONSTRAINT_CANON, (
        "the rules carry no surface, or the canon is empty - the rows above agree by "
        "reading nothing")
    assert NESTED, (
        "no surface sits inside another surface of its rule - the dedup rows above are "
        "empty and their green proves nothing")
    keys = {RULE_OF[v] for v in VALUES}
    assert not set(RULE_KEYS) - keys, (
        f"the door walks no value for {sorted(set(RULE_KEYS) - keys)} - that rule's "
        "canon coverage is untested")
