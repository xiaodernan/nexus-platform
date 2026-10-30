"""The leaf a query named is answered by its filter, and was also a search term on that filter's rows.

D601 refined the coarse bucket into the leaf the sentence names and wrote it into `filters.category`
(拉麵 -> `ramen`, 點心 -> `dimsum`). D635 then took the BUCKET word out of the match text, and the
leaf word stayed. Measured 2026-10-30 (`tmp/d638_before.txt`):

    拉麵        filter ramen        relevance 1.00 x8, then 0.145, 0.154
    點心        filter dimsum       relevance 1.00 x9, then 0.072
    壽司        filter sushi        relevance 1.00 x5, then 0.134-0.167
    珍珠奶茶    filter bubble-tea    relevance 0.19-0.24 on ALL TEN - no row writes 珍珠奶茶

So the page was again split by whether a row happened to write the word its own filter had selected,
and in the bubble-tea case every card carried a term no row could meet (a cosine against a phrase the
corpus never says). `lexicon.leaf_surfaces()` returns the sentence's own spelling of the leaf the plan
selected - and nothing for any other leaf - and `plan_from_intent` recomputes the match text once
`_apply_category_leaf` has decided, because the leaf is only known then.

Measured after (`tmp/d638_after.txt`): all four pages carry relevance 0.0 on every card, the two
spellings of one leaf answer the same ten (「拉麵」/`ramen`, 「珍珠奶茶」/`bubble tea`), the leaf still
steers the pool (each page opens on its own category), and a content word survives - 「平價拉麵」 reaches
the lane as 平價, 「拉麵 4個人」 as nothing.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.lexicon import leaf_surfaces, match_leaf
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,leaf,spellings", [
    ("拉麵", "ramen", ("拉麵",)),
    ("ramen noodles", "ramen", ("ramen",)),
    ("點心", "dimsum", ("點心",)),
    ("dim sum", "dimsum", ("dim sum",)),
    ("壽司", "sushi", ("壽司",)),
    ("珍珠奶茶", "bubble-tea", ("珍珠奶茶", "奶茶")),
    ("bubble tea", "bubble-tea", ("bubble tea",)),
])
def test_the_leaf_lane_and_the_strip_read_the_same_word(text, leaf, spellings):
    assert match_leaf(text) == leaf, (text, match_leaf(text))
    assert leaf_surfaces(text, leaf) == spellings, leaf_surfaces(text, leaf)


@pytest.mark.parametrize("text,leaf", [
    ("拉麵", "sushi"),
    ("點心", "ramen"),
])
def test_a_leaf_the_plan_did_not_select_keeps_its_word(text, leaf):
    """The strip may only remove the spelling of the leaf the FILTER answers."""
    assert leaf_surfaces(text, leaf) == (), leaf_surfaces(text, leaf)


@pytest.mark.parametrize("text,filter_,left,why", [
    ("拉麵", "ramen", "", "the leaf word leaves with its filter"),
    ("點心", "dimsum", "", "the same"),
    ("壽司", "sushi", "", "the same"),
    ("珍珠奶茶", "bubble-tea", "", "a term no row writes"),
    ("平價拉麵", "ramen", "平價", "a content word survives"),
    ("寧靜拉麵", "ramen", "寧靜", "the same"),
    ("拉麵 4個人", "ramen", "", "the party leaves with it"),
    ("拉麵同埋壽司", "sushi", "拉麵同埋", "only the leaf the plan CHOSE leaves"),
    ("泰式", "restaurant", "泰式", "no filter answers a cuisine word, so it stays content"),
])
def test_the_plan_strips_only_the_leaf_its_filter_answers(text, filter_, left, why):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.filters.get("category") == filter_, (text, plan.filters)
    assert plan.match_text == left, (text, why, plan.match_text)


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    queries = ("拉麵", "ramen", "點心", "壽司", "珍珠奶茶", "bubble tea")
    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            out = {"rows": len(await db.fetch("select id from public.merchants "
                                              "where status='published'"))}
            pages = {}
            for q in queries:
                pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                        query=q, limit=TOP_K)
                pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]],
                                cats=[s.candidate.category for s in pack.scored[:1]])
            out["pages"] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text", ["拉麵", "點心", "壽司", "珍珠奶茶"])
def test_no_card_on_a_leaf_page_claims_a_word_match(plane, text):
    rel = plane["pages"][text]["rel"]
    assert rel and all(r == 0.0 for r in rel), (
        f"「{text}」 still scores {rel} - the leaf word is dividing a pool its own filter chose")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("cjk,latin", [("拉麵", "ramen"), ("珍珠奶茶", "bubble tea")])
def test_the_two_spellings_of_one_leaf_answer_the_same_page(plane, cjk, latin):
    assert plane["pages"][cjk]["ids"] == plane["pages"][latin]["ids"], (
        f"「{cjk}」 and 「{latin}」 answer different pages")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text,category", [
    ("拉麵", "Ramen & Noodles"),
    ("點心", "Dim Sum"),
    ("壽司", "Sushi & Sashimi"),
    ("珍珠奶茶", "Bubble Tea"),
])
def test_the_leaf_still_steers_the_pool(plane, text, category):
    """The strip is only safe while the FILTER is what answered the word."""
    assert plane["pages"][text]["cats"] == [category], plane["pages"][text]["cats"]
    assert 0 < len(plane["pages"][text]["ids"]) < plane["rows"] // 10, len(plane["pages"][text]["ids"])
