"""D508 - the search's `filters.district` speaks the product's OWN district vocabulary.

The intent's district goes through the lexin's ONE reader (`match_district`), so the query
with "中環" becomes the canonical "Central" and the search finds it. The CALLER's
`filters.district` used to pass the raw string through — so the same word was two different
filters, and one of them matched NOTHING.

Measured against the live corpus:
    filters {"district": "中環"}    -> 0 items
    filters {"district": "Central"} -> 1 item
    the query with location "中環"   -> the district "Central" -> 1 item

So a caller who wrote a filter in the product's own vocabulary got an empty page — the
D488/D505 lesson in a new place: the same fact (what a district is called) had two readers,
and one of them was the raw string.

This gate holds the two to the same vocabulary:
  * every alias the lexin's district table names, read as a FILTER, becomes the SAME
    district the QUERY would give — one word, one answer;
  * and a word the product does not know is left alone.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import DISTRICTS, match_district
from nexus_ai.search.service import plan_from_intent

#: every alias the product's district table names (canonical + all aliases)
ALIASES = []
for canonical, spec in DISTRICTS.items():
    ALIASES.append((canonical, canonical))
    for alias in spec.get("aliases", []):
        ALIASES.append((canonical, alias))


@pytest.mark.parametrize("canonical,alias", ALIASES,
                         ids=[f"{c}:{a.encode('unicode_escape').decode()}" for c, a in ALIASES])
def test_the_filter_speaks_the_products_district_vocabulary(canonical: str, alias: str):
    """The same word, as a filter and as a query, gives the same district."""
    plan = plan_from_intent(None, query="", filters={"district": alias})
    filtered = (plan.filters or {}).get("district")
    assert filtered == canonical, (
        f"the word {alias.encode('unicode_escape').decode()!r} gave the filter the district "
        f"{filtered!r} but the product's district table says {canonical!r}")


def test_an_unknown_district_is_left_alone():
    """The reader does not resolve a word the product does not know into one it does."""
    plan = plan_from_intent(None, query="", filters={"district": "unknown_district_xyz"})
    assert (plan.filters or {}).get("district") == "unknown_district_xyz", (
        "an unknown district was resolved into a known one - the reader must not invent a "
        "district the caller did not ask for")


def test_the_readers_agree():
    """The reader the filter uses is the reader the query uses."""
    for canonical, spec in DISTRICTS.items():
        for alias in [canonical, *spec.get("aliases", [])]:
            matched = match_district(alias)
            assert matched is not None, (
                f"the product's own alias {alias.encode('unicode_escape').decode()!r} is not "
                f"read by the district reader")
            assert matched[0] == canonical