"""D549 - the fixture lane answers the same avoid question the live lane answers.

`_filter_static` is the fixture backend's WHERE clause, and it read `category`, `district`
and `max_price` - and never `avoid`. The live SQL lane has excluded on `avoid` since D517, so
the two backends answered DIFFERENT QUESTIONS about the same hard filter: measured at HEAD on
the live plane, `avoid=["seafood"]` dropped 30 of the 470 published merchants in the live lane
and **0** in the fixture lane; `avoid=["gluten"]` dropped 269 live and 0 in a fixture; peanut
22 live and 0 in a fixture. A test that asked the fixture backend whether a refusal filtered
anything was answered "no" for every word the corpus carries.

The live clause is four legs, and the lane only decides where the last two of them look:

    AND NOT (m.tags && terms
             OR m.category_primary = ANY(terms)
             OR <the merchant's offerings match>      -- merchant lane
             OR <the offering's own name/allergens>)  -- offering lane

The terms are the live lane's OWN expansion (`sql._avoid_terms` ->
`categories.avoid_terms`), not a second copy: `avoid=["seafood"]` has to reach the merchants
tagged `seafood-grill`, which is what D517 fixed on the live side and what this unit brings
across.

The gate holds one test per leg, and then measures the predicate against the live SQL on the
live corpus - both lanes, twenty words - so "the fixture lane agrees" is a measurement rather
than a restatement of the code.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.contract import ConstraintItem, Intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: the words the corpus carries a fact for. Twenty, so a leg that stops reading one spelling
#: of the fact is caught by a neighbour rather than by luck.
WORDS = ("seafood", "peanut", "gluten", "dairy", "spicy", "egg", "soy", "shellfish", "fish",
         "nuts", "sesame", "garlic", "onion", "ginger", "meat", "pork", "beef", "vegetarian",
         "noise", "coriander")

#: a merchant the corpus TAGS with the avoided word's leaf: the `m.tags && terms` leg.
TAGGED = {"id": "m-tagged", "slug": "tagged-seafood-grill", "display_name": "Tagged Grill",
          "display_name_zh": "", "district": "Central", "category_primary": "restaurant",
          "tags": ["seafood-grill", "restaurant"], "avg_price_hkd": 300, "attributes": {}}

#: a merchant whose CATEGORY is the avoided word itself: the `category_primary = ANY` leg.
CATEGORISED = {"id": "m-cat", "slug": "categorised-seafood", "display_name": "Categorised",
              "display_name_zh": "", "district": "Central", "category_primary": "seafood",
              "tags": ["restaurant"], "avg_price_hkd": 300, "attributes": {}}

#: a merchant whose own words say nothing the user refused, but which SELLS it: the merchant
#: lane's EXISTS leg, name half.
SELLING = {"id": "m-selling", "slug": "selling-peanut", "display_name": "The Usual Place",
           "display_name_zh": "", "district": "Central", "category_primary": "restaurant",
           "tags": [], "avg_price_hkd": 120, "attributes": {}}

#: the same leg's OTHER half: the offering's name says nothing the user refused and its
#: `attributes.allergens` does. A separate merchant, so one half going quiet cannot hide
#: behind the other.
ALLERGEN = {"id": "m-allergen", "slug": "allergen-peanut", "display_name": "Broth House",
            "display_name_zh": "", "district": "Central", "category_primary": "restaurant",
            "tags": [], "avg_price_hkd": 120, "attributes": {}}

#: the merchant that owns the offering the OFFERING lane is tested on, so the control below
#: stays free of any word the sentences use.
FISHY = {"id": "m-fishy", "slug": "fishy-soup-house", "display_name": "Soup House",
         "display_name_zh": "", "district": "Central", "category_primary": "restaurant",
         "tags": ["soup"], "avg_price_hkd": 90, "attributes": {}}

#: the control: carries none of the words above and must survive all of them.
PLAIN = {"id": "m-plain", "slug": "plain-cafe", "display_name": "Plain Cafe",
         "display_name_zh": "", "district": "Central", "category_primary": "cafe",
         "tags": ["cafe"], "avg_price_hkd": 90, "attributes": {}}

MERCHANTS = (TAGGED, CATEGORISED, SELLING, ALLERGEN, FISHY, PLAIN)

OFFERINGS = (
    # the merchant lane reads the merchant's OWN offerings, so each row belongs to the
    # merchant the sentence under test is about.
    {"id": "o-name", "merchant_id": "m-selling", "slug": "peanut-butter-toast",
     "name": "Peanut Butter Toast", "name_zh": "", "description": "crunchy",
     "attributes": {}},
    {"id": "o-allergen", "merchant_id": "m-allergen", "slug": "mystery-broth",
     "name": "Mystery Broth", "name_zh": "", "description": "of the day",
     "attributes": {"allergens": ["peanut"]}},
    # the offering lane's own row: its name and its allergens, no merchant involved.
    {"id": "o-fish", "merchant_id": "m-fishy", "slug": "fish-soup", "name": "Fish Soup",
     "name_zh": "", "description": "daily", "attributes": {}},
    {"id": "o-plain", "merchant_id": "m-plain", "slug": "filter-coffee",
     "name": "Filter Coffee", "name_zh": "", "description": "black", "attributes": {}},
)


async def _search_slugs(avoid: list[str], lane: str = "merchant") -> list[str]:
    """The slugs the pipeline keeps for this `avoid`, through the caller's own intent."""
    intent = Intent(raw_query="", intent="discover_merchant",
                    constraints=[ConstraintItem(key="avoid", value=a) for a in avoid])
    plan = S.plan_from_intent(intent, query="")
    if lane == "offering":
        plan = S.SearchPlan(query_text="", limit=100, filters=dict(plan.filters),
                            subject_types=("offering",))
    backend = S.StaticBackend(merchants=[dict(m) for m in MERCHANTS],
                              offerings=[dict(o) for o in OFFERINGS])
    cards, _resp, _bundle, _scored = await S.search(backend=backend, plan=plan, user_id=None)
    return [c.slug for c in cards]


# ------------------------------------------------------------------ the four legs
def test_the_tag_leg_excludes_the_merchant_the_corpus_tags():
    slugs = asyncio.run(_search_slugs(["seafood"]))
    assert "tagged-seafood-grill" not in slugs, (
        "the merchant tagged `seafood-grill` survived avoid=[seafood] - the `m.tags && terms` "
        "leg of the live clause is not read by the fixture lane")


def test_the_category_leg_excludes_the_merchant_whose_category_is_the_word():
    slugs = asyncio.run(_search_slugs(["seafood"]))
    assert "categorised-seafood" not in slugs, (
        "the merchant whose category_primary IS the avoided word survived it - the "
        "`category_primary = ANY(terms)` leg is not read by the fixture lane")


def test_the_offering_name_leg_excludes_the_merchant_that_sells_it():
    slugs = asyncio.run(_search_slugs(["peanut"]))
    assert "selling-peanut" not in slugs, (
        "the merchant that SELLS \'Peanut Butter Toast\' survived avoid=[peanut] - the "
        "merchant lane's EXISTS leg reads the merchant's own offerings, and the fixture lane "
        "never looked at them")


def test_the_allergen_leg_excludes_the_merchant_that_serves_it():
    slugs = asyncio.run(_search_slugs(["peanut"]))
    assert "allergen-peanut" not in slugs, (
        "the merchant whose offering declares the allergen survived avoid=[peanut] - the "
        "`attributes->\'allergens\' ?| terms` leg is not read by the fixture lane")
    assert "selling-peanut" not in slugs


def test_the_offering_lane_excludes_on_the_offerings_own_words():
    slugs = asyncio.run(_search_slugs(["fish"], lane="offering"))
    assert "fish-soup" not in slugs, (
        "the offering whose own name is the avoided word survived it - the offering lane's "
        "ILIKE leg is not read by the fixture lane")
    assert "filter-coffee" in slugs


def test_the_merchant_that_carries_none_of_the_words_is_kept():
    """The control: a filter that drops everything is not a filter, it is a bug."""
    for word in ("seafood", "peanut", "fish", "gluten", "dairy"):
        slugs = asyncio.run(_search_slugs([word]))
        assert "plain-cafe" in slugs, (
            f"avoid=[{word}] dropped the merchant that carries none of it - the fixture lane "
            f"over-excludes")


def test_a_word_no_row_carries_excludes_nothing():
    slugs = asyncio.run(_search_slugs(["coriander"]))
    assert set(slugs) == {"tagged-seafood-grill", "categorised-seafood", "selling-peanut",
                          "allergen-peanut", "fishy-soup-house", "plain-cafe"}, (
        f"avoid=[coriander] kept {sorted(slugs)} - none of the rows above carries it, so the "
        f"filter must drop nothing at all")


def test_an_empty_avoid_list_changes_nothing():
    slugs = asyncio.run(_search_slugs([]))
    assert set(slugs) == {"tagged-seafood-grill", "categorised-seafood", "selling-peanut",
                          "allergen-peanut", "fishy-soup-house", "plain-cafe"}


# ------------------------------------------------------------------ the live corpus
@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


async def _live_lanes(live_settings):
    """(kept slugs per word, kept offering ids per word, both unfiltered pools, all offerings).

    One connection reads the whole comparison: the pool each lane would rank with no filter,
    and what each lane actually returns once `avoid` is on the request, for every word above.
    """
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    common = dict(tenant_id=S.DEFAULT_TENANT_ID, text=None, geo=None, radius_m=None,
                  limit=100000, embedding=None)

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            merchants = await backend.merchant_candidates(**common)
            offerings = await backend.offering_candidates(
                **{k: v for k, v in common.items() if k != "embedding"})
            # the merchant lane's EXISTS leg carries no status filter, so neither does this pool
            every_offering = await db.readonly(
                "select id, merchant_id, name, name_zh, description, attributes "
                "from offerings", schema=live_settings.db_search_path)
            kept_merchants: dict[str, set[str]] = {}
            kept_offerings: dict[str, set[str]] = {}
            for word in WORDS:
                kept_merchants[word] = {
                    r["slug"] for r in await backend.merchant_candidates(
                        **dict(common, filters={"avoid": [word]}))}
                kept_offerings[word] = {
                    str(r["id"]) for r in await backend.offering_candidates(
                        **{k: v for k, v in dict(common, filters={"avoid": [word]}).items()
                           if k != "embedding"})}
            return kept_merchants, kept_offerings, merchants, offerings, every_offering
        finally:
            await db_pool.dispose()

    return await _go()


def test_the_fixture_prediction_matches_the_live_merchant_lane(live_settings):
    kept, _ko, merchants, _offerings, every_offering = asyncio.run(_live_lanes(live_settings))
    assert merchants, "the live plane returned no published merchants"
    for word in WORDS:
        live = kept[word]
        predicted = {r["slug"] for r in merchants
                     if not S._static_avoids(r, [word], every_offering)}
        assert live == predicted, (
            f"avoid=[{word}]: the live lane kept {len(live)} merchants and the fixture "
            f"predicate kept {len(predicted)} - "
            f"live-only {sorted(live - predicted)[:3]}, "
            f"predicate-only {sorted(predicted - live)[:3]}")


def test_the_fixture_prediction_matches_the_live_offering_lane(live_settings):
    _kept, kept_offerings, _merchants, offerings, _every = asyncio.run(
        _live_lanes(live_settings))
    assert offerings, "the live plane returned no active offerings"
    for word in WORDS:
        live = kept_offerings[word]
        predicted = {str(r["id"]) for r in offerings if not S._static_avoids(r, [word])}
        assert live == predicted, (
            f"avoid=[{word}]: the live lane kept {len(live)} offerings and the fixture "
            f"predicate kept {len(predicted)}")
