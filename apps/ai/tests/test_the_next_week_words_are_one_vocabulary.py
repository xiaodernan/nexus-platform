"""D490 - the tables that mean the same thing must hold the same words.

The urgency's "flexible" vocabulary and the time parser's next-week vocabulary mean the same
thing - "next week" - and they are kept in two modules:

    the time parser's next-week words   下週, 下周, 來週, 来週, next week, 下星期, 下礼拜
    the urgency's flexible words        得閒, 得闲, 有空, 隨時, 随时, anytime, next week,
                                       下週, 下周, 来週, 月底, 無所謂

So "下星期" and "下礼拜" were next-week words the time parser knew and the urgency did not
- and a user who said "next week" in Cantonese got NO urgency.

This gate holds the two tables to each other: every next-week word must be a flexible word.
(The comparison is made in the CANONICAL spelling - both tables are canonicalised at import,
so a word written in either spelling is the same word.)
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import state_merger as M
from nexus_ai.nlu import timeparse as T
from nexus_ai.nlu.canonical import canonical
from nexus_ai.nlu.understand import extract_intent

BASE = {
    "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
    "budget": None, "party_size": None, "preferences": [], "constraints": [],
    "sort_preference": "relevance",
    "location": {"type": "district", "value": "Sha Tin"},
    "time": {}, "confidence": {}, "unknowns": [],
}


@pytest.mark.parametrize("word", T.NEXT_WEEK_TOKENS,
                         ids=[w.encode("unicode_escape").decode()
                              for w in T.NEXT_WEEK_TOKENS])
def test_every_next_week_word_is_a_flexible_word(word: str):
    """The time parser knows these words; the urgency must know them too."""
    flexible = {canonical(w) for w in L.URGENCY_FLEXIBLE}
    assert canonical(word) in flexible, (
        f"the time parser knows {word.encode('unicode_escape').decode()!r} as a next-week "
        f"word and the urgency does not - a user who says it gets no urgency")


def test_the_cantonese_next_week_words_are_read():
    """The measured instances."""
    for word in ("下星期", "下礼拜"):
        assert extract_intent(word, {}).urgency == "flexible", (
            f"the word {word.encode('unicode_escape').decode()!r} was read as "
            f"{extract_intent(word, {}).urgency!r} instead of 'flexible'")
        assert M.merge_turn(dict(BASE), word).intent.get("urgency") == "flexible", (
            f"the merge did not read {word.encode('unicode_escape').decode()!r} as flexible")


def test_the_urgency_and_the_time_parser_agree():
    """The same word, the same reading, from both tables."""
    for word in T.NEXT_WEEK_TOKENS:
        assert canonical(word) in {canonical(w) for w in L.URGENCY_FLEXIBLE}, (
            f"the two tables disagree about {word.encode('unicode_escape').decode()!r}")
