"""The word that named the CATEGORY was also a search term, on the rows the category already chose.

Measured 2026-10-30 (`tmp/d634_zero_rel.txt`, `tmp/d634_cards.txt`). 「7點嘅餐廳」 filters to 11
restaurants open at 07:00 on a Saturday, and then matches 餐廳 as TEXT against them: two rows score
1.00, one 0.069, eight 0.00. relevance carries 0.34 of the organic score - the largest weight in
`infra/config/ranking_weights.yaml` - so the page opened with the two rows whose description happens
to say 餐廳 (0.66) and put a 4.1-star restaurant with 443 reviews third (0.353). The structure is the
one §625-§631 closed three times: a word a LANE has answered exactly is not a keyword.

「咖啡店」 shows the same thing without a time: all 79 cafes score 0.333-0.389, none of them a match -
`word_similarity` against a word almost none of them writes - so the page was ordered by that noise.

The strip is the category lane's OWN answer (`lexicon.category_surfaces`), which returns the
spellings of the bucket the sentence is ABOUT and nothing for a bucket that lost: the 寵物 in
「有冇寵物友善嘅咖啡店」 is a preference (the head is 咖啡店), so it stays content, and an INFERRED
category (`幫我搵個適合約會嘅地方` reads restaurant and writes no category word) strips nothing.

When nothing is left, nothing is searched: `plan.match_text` is empty, the keyword lane gets no text
and the vector lane is not asked to embed a sentence whose words were all consumed - a page with no
term does not claim one, so no card prints 符合「…」 for a score the row cannot ground.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.canonical import CANONICAL_FORMS
from nexus_ai.nlu.lexicon import CATEGORY_SYNONYMS, category_surfaces, match_category
from nexus_ai.nlu.understand import extract_intent_dict, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

#: Every (bucket, spelling) pair the category table holds, taken from the table (§D477).
SURFACES = [(category, term) for category, terms in CATEGORY_SYNONYMS.items() for term in terms]


@pytest.mark.parametrize("category,term", SURFACES)
def test_the_strip_and_the_filter_read_one_vocabulary(category, term):
    """For every spelling in the table, the strip must be talking about the bucket the filter chose."""
    read = match_category(term)
    assert read is not None and read[0] == category, (term, read)
    got = category_surfaces(term)
    assert got is not None and got[0] == category, (term, got)
    assert term in got[1], (term, got)


@pytest.mark.parametrize("text,core", [
    ("餐廳", ""),
    ("旺角餐廳", "旺角"),
    ("安靜嘅咖啡店", "安靜"),
    ("下午茶", ""),
])
def test_the_bucket_word_leaves_and_the_content_stays(text, core):
    surfaces = category_surfaces(text)[1]
    assert match_core(text, strip_surfaces=surfaces) == core


def test_a_time_and_a_bucket_leave_the_lane_nothing_to_search():
    text = "7點嘅餐廳"
    surfaces = category_surfaces(text)[1]
    assert match_core(text, strip_time=True, strip_surfaces=surfaces) == ""


def test_the_word_of_a_bucket_that_lost_stays_content():
    """寵物 names a category - a pet groomer - and it is not the one this sentence is about."""
    bucket, surfaces = category_surfaces("有冇寵物友善嘅咖啡店")
    assert bucket == "cafe"
    assert "寵物" not in surfaces, surfaces
    assert match_core("有冇寵物友善嘅咖啡店", strip_surfaces=surfaces) == "有冇寵物友善"


def test_the_users_own_spelling_is_what_gets_blanked():
    """餐廳 and 餐厅 are one word (D418); the span is read off the canonical text and blanked here."""
    bucket, surfaces = category_surfaces("銅鑼湾的餐厅")
    assert bucket == "restaurant"
    assert match_core("銅鑼湾的餐厅", strip_surfaces=surfaces) == "銅鑼湾"


def test_the_canonical_form_keeps_the_length():
    """The span strip leans on this: a position found in the canonical text is that position here."""
    differing = {k: v for k, v in CANONICAL_FORMS.items() if len(k) != len(v)}
    assert not differing, f"a canonical mapping changed the length: {differing}"


@pytest.mark.parametrize("query,core", [
    ("7點嘅餐廳", ""),
    ("旺角餐廳", "旺"),
    ("點心餐廳", "點心"),
])
def test_the_plan_hands_the_lane_what_no_filter_answered(query, core):
    """旺角 is a district and 點心 a leaf: both are still counted (filed, PLAN), so the plan keeps
    their first character - what this leg pins is that the bucket word is what left."""
    plan = plan_from_intent(validate_intent(extract_intent_dict(query)), query=query, limit=TOP_K)
    assert plan.match_text.startswith(core) if core else plan.match_text == "", plan.match_text
    assert plan.query_text == query, "the card still shows the user's own words"


def test_an_inferred_category_strips_nothing():
    q = "幫我搵個適合約會嘅地方"
    intent = validate_intent(extract_intent_dict(q))
    assert intent.category, "this leg needs the inference to fire"
    plan = plan_from_intent(intent, query=q, limit=TOP_K)
    assert plan.match_text == q, (
        f"a category nobody wrote took words out of the match text: {plan.match_text!r}")


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        await db_pool.connect(st, force_new=True)
        try:
            out = {}
            for q in ("餐廳", "7點嘅餐廳", "咖啡店", "點心餐廳"):
                intent = validate_intent(extract_intent_dict(q))
                pack = await run_search(Deps(st), intent, query=q, limit=TOP_K)
                out[q] = dict(
                    total=getattr(pack.response, "total_estimate", None),
                    core=pack.plan.match_text,
                    rel=[s.candidate.relevance for s in pack.scored[:TOP_K]],
                    claims=[any(r.label == "matches_query" for r in card.ai_match.reasons)
                            for card in pack.cards[:TOP_K]],
                    scores=[s.score for s in pack.scored[:TOP_K]])
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("query,total", [("餐廳", 184), ("7點嘅餐廳", 11), ("咖啡店", 79)])
def test_a_page_answered_by_its_filters_claims_no_term(plane, query, total):
    """Measured before: 1.00 / 0.069 / 0.00 on the eleven, and 0.333-0.389 on the seventy-nine."""
    page = plane[query]
    assert page["core"] == "", f"{query!r} still searches {page['core']!r}"
    assert page["total"] == total, (page["total"], total)
    assert set(page["rel"]) == {0.0}, f"a term no filter consumed is still dividing the page: {page['rel']}"
    assert not any(page["claims"]), (
        "a card prints 符合「…」 on a page with no search term - the claim is ungrounded")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_page_is_ordered_by_the_organic_score_and_nothing_else(plane):
    """The eleven were ordered by text noise; they are ordered by the score now, to the last row."""
    scores = plane["7點嘅餐廳"]["scores"]
    assert scores == sorted(scores, reverse=True), scores


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_word_no_filter_answered_still_carries_its_page(plane):
    """The control: 點心 names a dish, not the bucket, so it stays a term and still finds its rows."""
    page = plane["點心餐廳"]
    assert page["core"] == "點心", page["core"]
    assert page["rel"][0] >= 0.9, page["rel"]
    assert page["claims"][0], "the row that carries 點心 no longer says so"
