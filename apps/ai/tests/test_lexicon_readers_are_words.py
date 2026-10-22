"""D481 - the lexin's OWN readers read their names as WORDS.

D480 gave the first turn's readers the ONE matcher. The lexin's own readers - the
category names, the district names, the cuisine terms - still tested their tables with
`in low`, so:

  * "spaghetti dinner in sha tin" -> the category was BEAUTY (the category "spa" inside
    "spaghetti"), and the live search answered with **beauty salons** - two of them,
    where the same query answered with nine cafés;
  * "barbecue in sha tin"          -> the category was BAR (the category "bar" inside
    "barbecue").

This gate takes its parameters from the tables themselves, so the tables grow and the gate
grows with them: every Latin name must match as a word and must not match inside a word,
and the readers must still do their work.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.matching import cue_in


def _names() -> list[tuple[str, str]]:
    """Every Latin name the lexin's readers look for."""
    out: list[tuple[str, str]] = []
    for cat, terms in L.CATEGORY_SYNONYMS.items():
        out.extend((f"CATEGORY_SYNONYMS[{cat}]", term) for term in terms
                   if term.isascii())
    for name, spec in L.DISTRICTS.items():
        out.append(("DISTRICTS", name))
        out.extend((f"DISTRICTS[{name}]", alias) for alias in spec.get("aliases", [])
                   if alias.isascii())
    for cuisine, terms in L.CUISINE_TERMS.items():
        out.extend((f"CUISINE_TERMS[{cuisine}]", term) for term in terms
                   if term.isascii())
    return out


@pytest.mark.parametrize("table,name", _names())
def test_a_latin_name_is_not_read_out_of_the_middle_of_a_word(table: str, name: str):
    """A letter glued to the name's left must take the name out of the text."""
    glued = "x" + name
    assert not cue_in(name, glued, glued.lower()), (
        f"{table}'s name {name!r} was read out of the middle of a word - \"spa\" inside "
        f"\"spaghetti\" gave the query a beauty salon")
    assert cue_in(name, name, name.lower()), (
        f"{table}'s name {name!r} does not match itself - a table's entry is a promise")


def test_a_spaghetti_query_is_not_a_spa():
    """The measured instance - and the worst of the series: a wrong VERTICAL."""
    assert L.match_category("spaghetti dinner in sha tin") is None, (
        "'spaghetti' was read as the category 'spa' - the search answered with beauty "
        "salons")


def test_a_barbecue_is_not_a_bar():
    assert L.match_category("barbecue in sha tin") is None, (
        "'barbecue' was read as the category 'bar'")


def test_the_category_reader_still_works():
    assert L.match_category("spa day in mong kok")[0] == "beauty", (
        "'spa' is no longer read as a spa")
    assert L.match_category("coffee in sha tin")[0] == "cafe"
    assert L.match_category("bar in mong kok")[0] == "bar"


def test_the_cuisine_reader_still_works():
    assert "italian" in L.match_cuisines("italian pasta in sha tin")
    assert "japanese" in L.match_cuisines("ramen in sha tin")
    assert "korean" in L.match_cuisines("BBQ in sha tin")


def test_the_district_reader_still_works():
    name, _ = L.match_district("coffee in sha tin")
    assert name, "the district reader stopped working - 'sha tin' is a district"
