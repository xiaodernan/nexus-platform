"""D505 - the search's `filters.category` speaks the product's OWN category vocabulary.

The intent's category goes through the lexin's ONE reader (`match_category`), so the query
"escape room" becomes the bucket `escape_room` ✓. The CALLER's `filters.category` used to
pass the raw string through ✓ ✗ — so the same word was two different filters ✓ ✗, and one
of them matched NOTHING:

    filters {"category": "escape room"}   -> 0 items   (the live corpus)
    filters {"category": "escape_room"}   -> 1 item
    the query  "escape room"              -> the category "escape_room" -> 1 item

So a caller who wrote a filter in the product's own vocabulary got an empty page ✓ ✓ — the
D488 lesson in a new place: the same fact (what a category is called) had two readers ✓ ✗,
and one of them was the raw string ✓ ✗.

This gate holds the two to the same vocabulary:
  * every synonym the lexin's category table names ✓ ✓, read as a FILTER ✓ ✓, becomes the
    SAME category the QUERY would give ✓ ✓ — one word, one answer ✓ ✓;
  * and a word the product does not know is left alone ✓ ✓ (it is not resolved into
    something the caller did not ask for ✓ ✓).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import CATEGORY_SYNONYMS, match_category
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

#: every synonym the product's category table names
SYNONYMS = [(category, term) for category, terms in CATEGORY_SYNONYMS.items()
             for term in terms]


@pytest.mark.parametrize("category,term", SYNONYMS,
                         ids=[f"{c}:{t.encode('unicode_escape').decode()}"
                              for c, t in SYNONYMS])
def test_the_filter_speaks_the_products_own_vocabulary(category: str, term: str):
    """The same word, as a filter and as a query, gives the same category."""
    plan = plan_from_intent(None, query=term, filters={"category": term})
    filtered = (plan.filters or {}).get("category")
    queried = extract_intent_dict(term, {}).get("category")
    assert filtered == queried, (
        f"the word {term.encode('unicode_escape').decode()!r} gave the filter the category "
        f"{filtered!r} and the query {queried!r} - the same word is two different filters, and "
        f"one of them matches nothing")
    assert filtered == category, (
        f"the word {term.encode('unicode_escape').decode()!r} resolved to {filtered!r} and "
        f"the product's category table says {category!r}")


def test_an_unknown_word_is_left_alone():
    """The reader does not resolve a word the product does not know into one it does."""
    plan = plan_from_intent(None, query="", filters={"category": "banana"})
    assert (plan.filters or {}).get("category") == "banana", (
        "an unknown category was resolved into a known one - the reader must not invent a "
        "category the caller did not ask for")


def test_the_readers_agree():
    """The reader the filter uses is the reader the query uses."""
    for category, terms in CATEGORY_SYNONYMS.items():
        for term in terms:
            matched = match_category(term)
            assert matched is not None, (
                f"the product's own synonym {term.encode('unicode_escape').decode()!r} is not "
                f"read by the category reader")
            assert matched[0] == category
