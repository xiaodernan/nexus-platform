"""D487 - the urgency is ONE vocabulary, and the merge and the first turn read it alike.

The first turn read the urgency from the lexin's URGENCY_NOW / URGENCY_FLEXIBLE; the merge
read it from two tables of its own - and the copies were **subsets** that differed in BOTH
directions (D486's lesson: a copy that is a subset answers less):

    the first turn              the merge
    asap                -> now           None
    next week           -> flexible      None
    the end of the month-> flexible      None
    free time           -> flexible      None
    still open          -> normal        now

So a follow-up that says "next week" (or "asap", or "I am free", or "at the end of the
month") was answered with NO urgency in the merge, while the first turn read it.

This gate holds the two readers to the same vocabulary: every word the first turn reads as
an urgency, the merge reads the same way.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import state_merger as M
from nexus_ai.nlu.understand import extract_intent

BASE = {
    "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
    "budget": None, "party_size": None, "preferences": [], "constraints": [],
    "sort_preference": "relevance",
    "location": {"type": "district", "value": "Sha Tin"},
    "time": {}, "confidence": {}, "unknowns": [],
}

#: the urgency's words, from the tables the two readers share
URGENCY_WORDS = tuple(L.URGENCY_NOW) + tuple(L.URGENCY_FLEXIBLE)


def test_the_merge_holds_no_urgency_copy():
    """One vocabulary, one place."""
    for gone in ("OPEN_NOW_CUES", "ANYTIME_CUES"):
        assert gone not in vars(M), (
            f"the state merger holds {gone} - the urgency's vocabulary is the lexin's tables, "
            f"and a second copy is a copy that answers less (D486)")


@pytest.mark.parametrize("word", URGENCY_WORDS,
                         ids=[w.encode("unicode_escape").decode() for w in URGENCY_WORDS])
def test_the_merge_reads_the_same_urgency_as_the_first_turn(word: str):
    """The same turn, read two ways, must give the same urgency."""
    first = extract_intent(word, {}).urgency
    merged = M.merge_turn(dict(BASE), word).intent.get("urgency")
    assert merged == first, (
        f"the word {word.encode('unicode_escape').decode()!r} gave the first turn "
        f"{first!r} and the merge {merged!r} - the two readers must read one vocabulary")


def test_the_measured_words_are_read_by_both():
    """The measured instances."""
    for word, expected in (("asap", "now"), ("next week", "flexible"),
                           ("anytime", "flexible"), ("still open", "now")):
        assert extract_intent(word, {}).urgency == expected, (
            f"the first turn did not read {word!r} as {expected!r}")
        assert M.merge_turn(dict(BASE), word).intent.get("urgency") == expected, (
            f"the merge did not read {word!r} as {expected!r}")
