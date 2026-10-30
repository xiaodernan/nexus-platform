"""The district that named the geo filter was also a search term, on the rows it had selected.

Measured 2026-10-30 (`tmp/d637_before.txt`), on the building plane:

    旺角嘅餐廳    5 rows    relevance 1.00, 1.00, 0.269, 0.189, 0.123   (score .767 .731 .487 .482 .418)
    觀塘嘅餐廳    7 rows    relevance 1.00 x6, 0.166
    銅鑼灣嘅餐廳  6 rows    relevance 1.00, 1.00, 0.339, 0.231, 0.165, 0.055

The plan already places a geo filter at the district's own coordinates, so a row is in the pool
because it is IN that district. The word cannot narrow it further; it only divides the pool's
relevance, and relevance is the largest weight in the score (§632). Seven of the 470 published rows
carry 旺角 in name, description, tags or attributes (eleven 觀塘, seven 銅鑼灣, twelve 尖沙咀), so
the page opened on whichever rows happened to write the word.

`lexicon.district_surfaces()` returns the spellings the sentence writes for the district the plan is
about to filter on - the district lane's own reading, and nothing when it reads a different one - and
`plan_from_intent` adds them to the same `strip_surfaces` the category lane uses (D635).

Measured after (`tmp/d637_after.txt`): all four pages carry relevance 0.0 on every card and open on
the pool's own score order, 深水埗嘅餐廳 (no rows inside its radius) still answers nothing, and a
content word survives - 「旺角新開嘅餐廳」 reaches the lane as 新開 and nothing else.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.lexicon import district_surfaces, match_district
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,district,spellings", [
    ("旺角嘅餐廳", "Mong Kok", ("旺角",)),
    ("Mong Kok 嘅餐廳", "Mong Kok", ("Mong Kok",)),
    ("旺角餐廳", "Mong Kok", ("旺角",)),
    ("觀塘嘅餐廳", "Kwun Tong", ("觀塘",)),
    ("銅鑼灣嘅餐廳", "Causeway Bay", ("銅鑼灣",)),
    ("尖沙咀嘅咖啡店", "Tsim Sha Tsui", ("尖沙咀",)),
])
def test_the_district_lane_and_the_strip_read_the_same_word(text, district, spellings):
    assert match_district(text)[0] == district, text
    assert district_surfaces(text, district) == spellings, district_surfaces(text, district)


@pytest.mark.parametrize("text", ["旺角嘅餐廳", "銅鑼灣嘅餐廳"])
def test_a_district_the_plan_is_not_about_keeps_its_word(text):
    """The strip may only remove the word the FILTER answers. A caller who overrides the district
    (`filters.district`) must not lose a word the plan never resolved."""
    assert district_surfaces(text, "Central") == (), district_surfaces(text, "Central")


@pytest.mark.parametrize("text,left,why", [
    ("旺角嘅餐廳", "", "the district word and the category word both leave with their filters"),
    ("旺角", "", "a district is a filter by itself"),
    ("Mong Kok 嘅餐廳", "", "the alias leaves too"),
    ("旺角新開嘅餐廳", "新開", "a content word survives"),
    ("旺角嘅拉麵", "", "D638: the leaf word leaves with its own filter too (§635)"),
    ("附近嘅餐廳", "附近", "no district was named, so no district filter answers the word"),
])
def test_the_plan_strips_only_the_word_its_filter_answers(text, left, why):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == left, (text, why, plan.match_text)


def test_the_geo_filter_is_still_there_after_the_strip():
    """The word leaves BECAUSE the filter answers it - if the geo were dropped too, the page would
    be the whole catalogue and this unit would have made the search worse."""
    plan = plan_from_intent(validate_intent(extract_intent_dict("旺角嘅餐廳")),
                            query="旺角嘅餐廳", limit=TOP_K)
    assert plan.geo == (22.3193, 114.1694), plan.geo


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    queries = ("旺角嘅餐廳", "Mong Kok 嘅餐廳", "觀塘嘅餐廳", "銅鑼灣嘅餐廳", "深水埗嘅餐廳")
    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = await db.fetch("select display_name, display_name_zh, description, tags, "
                                  "attributes from public.merchants where status='published'")
            out = {"rows": len(rows), "carrying": {}}
            for d in ("旺角", "觀塘", "銅鑼灣"):
                out["carrying"][d] = sum(1 for r in rows if d in " ".join([
                    str(r["display_name"] or ""), str(r["display_name_zh"] or ""),
                    str(r["description"] or ""), " ".join(r["tags"] or []),
                    str(r["attributes"] or "")]))
            pages = {}
            for q in queries:
                pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                        query=q, limit=TOP_K)
                pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
            out["pages"] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text", ["旺角嘅餐廳", "觀塘嘅餐廳", "銅鑼灣嘅餐廳"])
def test_no_card_on_a_district_page_claims_a_word_match(plane, text):
    rel = plane["pages"][text]["rel"]
    assert rel and all(r == 0.0 for r in rel), (
        f"「{text}」 still scores {rel} - the district word is dividing a pool its own filter chose "
        f"(the rows that write it start at 1.00; {plane['carrying']} of {plane['rows']} carry one)")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_two_spellings_of_one_district_answer_the_same_page(plane):
    assert plane["pages"]["旺角嘅餐廳"]["ids"] == plane["pages"]["Mong Kok 嘅餐廳"]["ids"], (
        "the CJK and Latin spellings of one district answer different pages")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_filter_still_bites_after_the_word_leaves(plane):
    """The strip is only safe while the geo filter is the thing that answers the word: a district
    with rows answers a small pool, and 深水埗 (no rows inside its radius) answers none - if the
    filter had been dropped, both would be the 470-row catalogue."""
    pages = plane["pages"]
    for text in ("旺角嘅餐廳", "觀塘嘅餐廳", "銅鑼灣嘅餐廳"):
        assert 0 < len(pages[text]["ids"]) < plane["rows"] // 10, (text, len(pages[text]["ids"]))
    assert pages["深水埗嘅餐廳"]["ids"] == [], pages["深水埗嘅餐廳"]["ids"]
