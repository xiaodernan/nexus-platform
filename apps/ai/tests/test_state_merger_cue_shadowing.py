"""D476 - a cue must reach its OWN table's branch, in every language the table holds.

The state merger checks its cue pairs in order - `if NEARER_CUES ... elif FARTHER_CUES` -
and the match was a plain substring test, so `NEARER_CUES`'s "far" sat inside
`FARTHER_CUES`'s "farther" and the English "farther" took the NEAR branch: the radius was
**tightened** where the user asked to **widen** it. The CJK half of the same table was
never affected, because no CJK cue is a substring of another CJK cue - which is exactly
why the drift hid: the Chinese said "widen" and the English said "narrow".

The same shape hides elsewhere: `PRICIER_CUES`'s "expensive" sits inside
`CHEAPER_CUES`'s "too expensive" ✓, and `OPEN_NOW_CUES`'s "now" sits inside its own "open
now" ✓.

This gate asks the MERGE, so it tests the behaviour and not the matcher: every cue of a
table must produce that table's effect ✓ - the budget down, the radius up, the ambience
lively, the urgency flexible ✓ - in every language the table is written in ✓.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import state_merger as M

#: the cue tables the merge checks, and the order it checks them in
PAIRS = [
    ("CHEAPER_CUES", "PRICIER_CUES"),
    ("NEARER_CUES", "FARTHER_CUES"),
    ("QUIET_CUES", "LOUDP_CUES"),
    ("OPEN_NOW_CUES", "ANYTIME_CUES"),
]


def _state() -> dict:
    return {
        "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
        "budget": {"min": None, "max": 200, "currency": "HKD", "per": "party"},
        "party_size": 2, "preferences": [], "constraints": [],
        "sort_preference": "relevance",
        "location": {"type": "district", "value": "Sha Tin", "radius_m": 2000},
        "time": {}, "confidence": {}, "unknowns": [],
    }


def _tables() -> dict[str, tuple[str, ...]]:
    return {name: table for name, table in vars(M).items()
            if name.endswith("_CUES") and isinstance(table, tuple)}


def test_the_cue_tables_are_readable():
    tables = _tables()
    for expected in ("CHEAPER_CUES", "PRICIER_CUES", "NEARER_CUES", "FARTHER_CUES",
                     "QUIET_CUES", "LOUDP_CUES", "RESET_CUES", "ALT_CUES",
                     "COMPARE_TOP_CUES", "OPEN_NOW_CUES", "ANYTIME_CUES"):
        assert expected in tables, (
            f"the state merger has no {expected} - the gate reads the tables out of the "
            f"module, so a renamed table changes what the gate can see: {sorted(tables)}")


def _effect(result: M.MergeResult) -> str:
    """Which branch the merge took, read from the intent it produced."""
    intent = result.intent
    radius = (intent.get("location") or {}).get("radius_m")
    if radius is not None and radius != 2000:
        return "farther" if radius > 2000 else "nearer"
    budget = (intent.get("budget") or {}).get("max")
    if budget is not None and budget != 200:
        return "cheaper" if budget < 200 else "pricier"
    ambience = {p.get("key"): p.get("value") for p in (intent.get("preferences") or [])}
    if ambience.get("ambience"):
        return ambience["ambience"]
    if intent.get("urgency") in ("now", "flexible"):
        return str(intent["urgency"])
    return "none"


@pytest.mark.parametrize("first,second", PAIRS)
def test_a_cue_reaches_its_own_tables_branch(first: str, second: str):
    """Every cue of the SECOND table must produce the second table's effect.

    The first table is checked first, so a cue of the second table that the first table
    also matches is shadowed by it - and the user gets the opposite of what they asked.
    """
    expected = {
        "CHEAPER_CUES": "cheaper", "PRICIER_CUES": "pricier",
        "NEARER_CUES": "nearer", "FARTHER_CUES": "farther",
        "QUIET_CUES": "quiet", "LOUDP_CUES": "lively",
        "OPEN_NOW_CUES": "now", "ANYTIME_CUES": "flexible",
    }[second]
    for cue in getattr(M, second):
        result = M.merge_turn(_state(), cue)
        effect = _effect(result)
        assert effect == expected, (
            f"{second}'s cue {cue.encode('unicode_escape').decode()!r} produced "
            f"{effect!r} instead of {expected!r} - {first} is checked first and shadowed it")


def test_the_english_farther_widens_the_radius():
    """The end-to-end proof: the English 'farther' must widen, like the Chinese."""
    result = M.merge_turn(_state(), "farther")
    radius = (result.intent.get("location") or {}).get("radius_m")
    assert radius and radius > 2000, (
        f"the English 'farther' left the radius at {radius!r} - the user asked to widen it "
        f"and the search tightened it")


def test_the_two_languages_widen_the_same_way():
    english = M.merge_turn(_state(), "farther")
    chinese = M.merge_turn(_state(), M.FARTHER_CUES[0])
    english_radius = (english.intent.get("location") or {}).get("radius_m")
    chinese_radius = (chinese.intent.get("location") or {}).get("radius_m")
    assert english_radius == chinese_radius, (
        f"the English and the Chinese widened differently: {english_radius!r} and "
        f"{chinese_radius!r} - the same request must get the same answer")


def test_no_cue_sits_in_two_tables_that_mean_opposite_things():
    """The same word in both tables of a pair is unreachable in one of them.

    D476: `貴啲` ("a bit pricier") sat in CHEAPER_CUES *and* in PRICIER_CUES. The two
    tables mean opposite things and the cheaper one is checked first, so the word always
    tightened the budget: the user asked for a pricier search and got a cheaper one.
    """
    for first, second in PAIRS:
        a = set(getattr(M, first))
        b = set(getattr(M, second))
        shared = a & b
        assert not shared, (
            f"{first} and {second} share the cue(s) "
            f"{[c.encode('unicode_escape').decode() for c in sorted(shared)]} - the two "
            f"tables mean opposite things, so the one checked first always wins and the "
            f"other is unreachable")


def test_the_longest_cue_wins():
    """A cue that contains another cue must reach the longer one's branch."""
    from nexus_ai.nlu.matching import longest_cue

    assert longest_cue("farther", "farther", M.FARTHER_CUES) == "farther", (
        "the longest matching cue must win - otherwise 'farther' is read as 'far'")
    assert longest_cue("too expensive", "too expensive", M.CHEAPER_CUES) == "too expensive"
    assert longest_cue("open now", "open now", M.OPEN_NOW_CUES) == "open now"


def test_a_latin_cue_matches_on_a_word_boundary():
    """'far' is not the word 'far' in 'farther'."""
    from nexus_ai.nlu.matching import cue_in

    assert not cue_in("far", "farther", "farther"), (
        "'far' matched inside 'farther' - a Latin cue must match on a word boundary")
    assert cue_in("far", "far away", "far away")
    assert cue_in("far", "far, please", "far, please")
