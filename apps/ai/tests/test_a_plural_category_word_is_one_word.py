"""An English plural category word reached the lane as its own plural marker.

`CATEGORY_SYNONYMS` writes the singular - `restaurant`, `cafe`, `bar`, `hotel`, `shop` - and D635's
strip blanks exactly the span a surface occupies. A plural sentence therefore kept the marker:
`restaurants` became `s`.

Measured 2026-11-02 (`tmp/d644_before.txt`):

    restaurants              filter restaurant   match text "s"
    at most 1000 restaurants filter restaurant   match text "s"
    cafes                    filter cafe         match text "s"
    bars                     filter bar          match text "s"
    hotels                   filter hotel        match text "s"
    shops                    filter retail       match text "s"

No published row carries a lone `s`, so the term could only divide the page: every English page
tied at relevance 0.5 and its order was the ranker's tie-break.

The repair absorbs a plural marker that follows a span the strip just removed, and only after a
span whose own last character is LATIN - `咖啡店` has no plural and its mark stays untouched. A
losing bucket's spelling is deliberately NOT absorbed away: `coffee shops` is the cafe filter and
`shops` is RETAIL's word, which D635 measured and ruled stays content.

Measured after (`tmp/d644_after.txt`, `tmp/d644_pairs.txt`): all five plurals reach the lane as
nothing, and each answers the SAME ten ids, relevance 0.0 on every card, as its singular -
restaurant/restaurants, cafe/cafes, bar/bars, hotel/hotels, shop/shops. Content survives: `quiet
restaurants` reaches the lane as `quiet`, `romantic cafes` as `romantic`.

Not claimed: `bakeries` and `steakhouses` name no bucket at all (`category=None`, whole text kept)
- the marker rule cannot help a word the category lane does not know; that is the vocabulary's
item, not the strip's. And `restaurants in 旺角` reaches the lane as `in`, which is the FILTER
word's residue filed under the filler item, not a plural.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,category", [
    ("restaurants", "restaurant"),
    ("cafes", "cafe"),
    ("bars", "bar"),
    ("hotels", "hotel"),
    ("shops", "retail"),
])
def test_a_plural_category_word_leaves_the_match_text(text, category):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.filters.get("category") == category, (text, plan.filters)
    assert plan.match_text == "", (text, plan.match_text)


def test_a_budget_and_a_plural_together_leave_nothing():
    text = "at most 1000 restaurants"
    intent = extract_intent_dict(text)
    plan = plan_from_intent(validate_intent(intent), query=text, limit=TOP_K)
    assert (intent.get("budget") or {}).get("max") == 1000.0, intent.get("budget")
    assert plan.filters.get("category") == "restaurant", plan.filters
    assert plan.match_text == "", plan.match_text


@pytest.mark.parametrize("text,left", [
    ("quiet restaurants", "quiet"),
    ("restaurants quiet", "quiet"),
    ("romantic cafes", "romantic"),
])
def test_a_content_word_beside_the_plural_survives(text, left):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == left, (text, plan.match_text)


@pytest.mark.parametrize("text,left", [
    ("coffee shops", "shops"),
    ("dessert shops", "shops"),
])
def test_a_losing_bucket_s_spelling_stays_content(text, left):
    """D635's ruling, re-pinned here: only the bucket the sentence is ABOUT is stripped."""
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == left, (text, plan.match_text)


def test_a_cjk_word_keeps_its_own_mark():
    plan = plan_from_intent(validate_intent(extract_intent_dict("咖啡店")), query="咖啡店", limit=TOP_K)
    assert plan.match_text == "", plan.match_text


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    pairs = (("restaurant", "restaurants"), ("cafe", "cafes"), ("bar", "bars"),
             ("hotel", "hotels"), ("shop", "shops"))
    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            out = {}
            for single, plural in pairs:
                pages = {}
                for q in (single, plural):
                    pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                            query=q, limit=TOP_K)
                    pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                    rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
                out[(single, plural)] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("single,plural", [("restaurant", "restaurants"), ("cafe", "cafes"),
                                           ("bar", "bars"), ("hotel", "hotels"), ("shop", "shops")])
def test_a_plural_answers_the_page_its_singular_answers(plane, single, plural):
    pages = plane[(single, plural)]
    assert pages[plural]["ids"] == pages[single]["ids"], (
        f"{plural} answers {pages[plural]['ids'][:3]} and {single} answers {pages[single]['ids'][:3]}")
    assert pages[plural]["rel"] == pages[single]["rel"], (plural, pages[plural]["rel"], pages[single]["rel"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_card_on_a_plural_page_carries_the_marker_as_a_term(plane):
    """The marker alone was the only term left, and 0 of the 470 published rows carry `s` as a word."""
    for _single, plural in (("restaurant", "restaurants"), ("cafe", "cafes"), ("bar", "bars"),
                            ("hotel", "hotels"), ("shop", "shops")):
        rel = plane[(_single, plural)][plural]["rel"]
        assert rel and all(r == 0.0 for r in rel), (plural, rel)
