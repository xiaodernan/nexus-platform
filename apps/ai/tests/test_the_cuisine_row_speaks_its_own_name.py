"""D520 - a cuisine row speaks its own name.

The lexicon has eleven cuisine rows, and ten of them carry the cuisine's OWN name in their
term list: a user who types "italian", "korean", "thai", "seafood" or "dim sum" gets the
cuisine. The eleventh - `japanese` - does not: its row is the Japanese words and the
transliterations, and never the word itself, so

    extract_intent("japanese")            -> intent "unknown", no category, no preference
    extract_intent("I want japanese")     -> intent "unknown"
    extract_intent("somewhere japanese")  -> intent "unknown"

while the same sentence with any other cuisine's name in it is answered. The user typed the
product's own vocabulary word and the reader did not know it.

This gate holds every row to the rule the other ten already follow: the cuisine's own name,
in the spelling a user types it (separators folded, since the row key is `dim_sum` and the
user writes "dim sum"), is a term of that row.

It was **proved to fail**: deleting "japanese" from the japanese row reddens every check
here (the probe was put back).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import CUISINE_TERMS, match_cuisines
from nexus_ai.nlu.understand import extract_intent


def _own_name(cuisine: str) -> str:
    """The cuisine's own name in the spelling a user types it."""
    return cuisine.replace("_", " ").replace("-", " ").strip().lower()


@pytest.mark.parametrize("cuisine", sorted(CUISINE_TERMS), ids=sorted(CUISINE_TERMS))
def test_a_row_reads_its_own_name(cuisine):
    name = _own_name(cuisine)
    terms = [t.replace("_", " ").replace("-", " ").strip().lower()
             for t in CUISINE_TERMS[cuisine]]
    assert name in terms, (
        f"CUISINE_TERMS[{cuisine!r}] does not contain its own name {name!r} - a user who "
        f"types the cuisine's name gets no cuisine at all")
    assert cuisine in match_cuisines(name), (
        f"typing {name!r} does not resolve to the cuisine {cuisine!r}")


def test_the_japanese_row_reads_japanese():
    """The measured instance - the one row of the eleven that could not."""
    assert "japanese" in match_cuisines("japanese")


@pytest.mark.parametrize("query", [
    "japanese",
    "i want japanese",
    "somewhere japanese in central",
    "japanese food near me",
])
def test_a_query_naming_the_cuisine_is_understood(query):
    ex = extract_intent(query).to_dict()
    assert ex["intent"] != "unknown", f"{query!r} was read as an unknown intent"
    assert ex["category"] == "restaurant", f"{query!r} named no category"
    assert [p for p in ex["preferences"] if p["key"] == "cuisine"], (
        f"{query!r} produced no cuisine preference")


def test_the_other_rows_still_read_their_names():
    """The gate must not have been passed by emptying the table."""
    assert len(CUISINE_TERMS) >= 11
    for cuisine in ("cantonese", "korean", "thai", "italian", "indian", "western",
                    "malaysian", "seafood", "vegetarian"):
        assert cuisine in match_cuisines(cuisine)
    assert "dim_sum" in match_cuisines("dim sum")
