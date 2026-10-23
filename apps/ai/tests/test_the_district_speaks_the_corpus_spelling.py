"""D519 - the district reader speaks the spelling the corpus writes its districts in.

A district has three spellings in this product, and until now the reader knew two of them:

  * the DISPLAY NAME - "Sha Tin", which `locations.district` holds and the SQL compares;
  * the SPACED form - "sha tin", which the lexin's alias table carries;
  * the SLUG - `sha-tin`, which the seed writes as a TAG on every merchant in the district.

`match_district` compares its aliases LITERALLY through `cue_in`, and the alias table only
had the spaced form, so the corpus's own spelling resolved to nothing. Measured on the live
corpus: of the 15 district tags the seed writes, 14 resolved to no district at all, and

    filters={"district": "sha-tin"}  -> 0 items
    filters={"district": "Sha Tin"}  -> 50 items (the limit)

the D505/D508/D516 lesson in the district lane: one fact (where this merchant is), three
readers, and the one the corpus writes with was the one that could not be read.

This gate holds the reader to every spelling:
  * the hyphenated form is IN the alias table, folded by the product's ONE separator rule
    (`categories.canonical_tag`, the same rule that folds a category bucket and a tag);
  * every corpus district tag resolves to the district the corpus says it is;
  * and the filter path resolves it too, because D508 made `filters.district` go through
    this reader.

It was **proved to fail**: removing the fold reddens these checks (the probe was put back).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.lexicon import DISTRICTS, match_district
from nexus_ai.search.categories import canonical_tag
from nexus_ai.search.service import plan_from_intent

#: the district tags the seed writes (`data/seed/seed_pools.py`'s DISTRICTS slugs), measured
#: against the live corpus on 2026-10-23 - `select distinct unnest(tags) from merchants`.
#: Four of the corpus's fifteen districts are absent from the lexin's table altogether; they
#: are pinned in their own unit, not pretended away here.
CORPUS_TAGS = [
    ("Sha Tin", "sha-tin"), ("Tai Wai", "tai-wai"), ("Ma On Shan", "ma-on-shan"),
    ("Tsim Sha Tsui", "tsim-sha-tsui"), ("Mong Kok", "mong-kok"),
    ("Causeway Bay", "causeway-bay"), ("Kwun Tong", "kwun-tong"),
    ("Central", "central"), ("Tai Po", "tai-po"), ("Tsuen Wan", "tsuen-wan"),
    ("Wan Chai", "wan-chai"), ("Sheung Shui", "sheung-shui"), ("Tuen Mun", "tuen-mun"),
    ("Stanley", "stanley"), ("Kowloon Bay", "kowloon-bay"),
]


@pytest.mark.parametrize("canonical,tag", CORPUS_TAGS, ids=[t for _, t in CORPUS_TAGS])
def test_the_corpus_district_tag_resolves(canonical, tag):
    assert match_district(tag) is not None, (
        f"the corpus writes the district {tag!r} and the district reader does not know it")
    assert match_district(tag)[0] == canonical


@pytest.mark.parametrize("canonical,tag", CORPUS_TAGS, ids=[t for _, t in CORPUS_TAGS])
def test_the_corpus_district_tag_filters(canonical, tag):
    """D508 made `filters.district` go through this reader; it has to resolve the corpus's
    own spelling, not only the display name."""
    plan = plan_from_intent(None, query="", filters={"district": tag})
    assert (plan.filters or {}).get("district") == canonical


@pytest.mark.parametrize("canonical", sorted(DISTRICTS))
def test_every_latin_spelling_of_a_district_resolves(canonical):
    """One district, one set of spellings: the name, the spaced alias, the hyphenated slug."""
    spec = DISTRICTS[canonical]
    for form in [canonical, *(a for a in spec.get("aliases", []) if a.isascii())]:
        assert match_district(form) is not None, (
            f"the district {canonical!r} is written {form!r} in its own table and the "
            f"reader does not resolve it")
        assert match_district(form)[0] == canonical


@pytest.mark.parametrize("canonical", sorted(DISTRICTS))
def test_the_hyphenated_spelling_is_in_the_table(canonical):
    """The coupling, pinned: the fold lives in the table, so a new district gets it too."""
    spec = DISTRICTS[canonical]
    aliases = list(spec.get("aliases") or [])
    for form in [canonical, *aliases]:
        folded = canonical_tag(form)
        if folded and folded != form:
            assert folded in aliases, (
                f"the district {canonical!r} is written {form!r} but its hyphenated "
                f"spelling {folded!r} is not in the alias table - the reader cannot see "
                f"the spelling the corpus writes")


def test_the_display_name_and_the_spaced_form_still_resolve():
    """The fold must add spellings, never replace the ones that already worked."""
    for canonical, spec in DISTRICTS.items():
        assert match_district(canonical)[0] == canonical
        for alias in spec.get("aliases", []):
            if not alias.isascii() or alias == canonical_tag(alias):
                continue
            assert match_district(alias) is not None, (
                f"the alias {alias!r} of {canonical!r} stopped resolving")
