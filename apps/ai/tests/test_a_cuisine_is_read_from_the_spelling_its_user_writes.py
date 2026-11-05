"""A cuisine is read from the spelling the user writes for it.

「想食日本嘢」 read the food bucket and NO cuisine: 日本嘢, 日式 and 日本 were in no row of
`CUISINE_TERMS`, and the page was the whole 184-restaurant plane ordered by rating. 「想食越南嘢」 and
「越南菜」 were the same, and 越南菜 answered no category at all - 470 of 470 published merchants, the
whole plane including every bar and gym (`tmp/d704_census.py`, `tmp/d704_ctl2.py`, 11:00 HKT Thursday).
The taxonomy has a `vietnamese` leaf (13 published merchants) and a japanese bridge
(sushi / ramen / izakaya, 54 merchants); the vocabulary had no word for either.

The comparison that names the defect is the control this table already carries: 「想食韓國嘢」 put
THREE Korean shops at the top of its page and 「想食泰國嘢」 FOUR Thai ones, because 韓國 and 泰國 are
spellings the table holds - while 日本嘢 put none of the 54 japanese shops in its top ten.

Measured after the rows were written (`tmp/d704_census.py`, `tmp/d704_ctl2.py`):

    request        cuisine read   category     pool            japanese in an 8-row page
    想食日本嘢     -              restaurant   184            0
                   japanese       restaurant   184            Ramen 1st, Sushi 7th
    想食日式       -              restaurant   184            0
                   japanese       restaurant   184            Ramen 1st, Sushi 7th
    越南菜         -              (none)       470             -
                   vietnamese     restaurant   184             -

The page numbers are read with the vector lane OFF, because the offline hashing embedder's cosine is
noise on a query whose words match no row: with it ON, 「想食日本嘢」 answers Italian steakhouses and
no japanese shop at all, whatever the cuisine preference says - measured, and FILED rather than fixed
here (the vector score is the next unit).

A cuisine is a SOFT preference by design (D394: `cuisine_like` ranks, it does not filter), so the pool
stays the restaurant plane and the preference moves the ORDER. This unit only makes the word reach the
preference.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest

from nexus_ai.nlu.lexicon import CUISINE_TERMS
from nexus_ai.nlu.understand import extract_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday


@pytest.mark.parametrize("word", ["日本嘢", "日式", "日本"])
def test_the_table_carries_the_japanese_spelling(word):
    assert word in CUISINE_TERMS["japanese"], (word, CUISINE_TERMS["japanese"])


@pytest.mark.parametrize("word", ["越南", "越南菜", "越南嘢", "越式"])
def test_the_table_has_a_vietnamese_row_and_carries_the_spelling(word):
    assert "vietnamese" in CUISINE_TERMS, list(CUISINE_TERMS)[:5]
    assert word in CUISINE_TERMS["vietnamese"], (word, CUISINE_TERMS["vietnamese"])


@pytest.mark.parametrize("sentence,cuisine", [("想食日本嘢", "japanese"),
                                            ("想食日式", "japanese"),
                                            ("日式料理", "japanese"),
                                            ("越南菜", "vietnamese"),
                                            ("想食越南嘢", "vietnamese")])
def test_the_sentence_reads_the_cuisine(sentence, cuisine):
    ex = extract_intent(sentence, {"now": NOW})
    values = [str(c.get("value")) for c in ex.preferences if c.get("key") == "cuisine"]
    assert cuisine in values, (sentence, values)
    likes = [str(c.get("value")) for c in ex.preferences if c.get("key") == "cuisine_like"]
    assert any(cuisine in like for like in likes), (sentence, likes)


def test_a_simplified_spelling_reads_the_same_cuisine():
    ex = extract_intent("越南菜", {"locale": "zh-CN"})
    values = [str(c.get("value")) for c in ex.preferences if c.get("key") == "cuisine"]
    assert "vietnamese" in values, values


def test_the_cuisine_is_still_soft():
    # the design this unit must not break: a cuisine ranks, it does not filter. The plan's
    # category is the bucket the cuisine lives in, never the leaf itself.
    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("想食日本嘢", {"now": NOW}),
                              query="想食日本嘢", now=NOW)
    assert plan.filters.get("category") == "restaurant", plan.filters


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    import nexus_ai.search.service as S
    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    JP = {"Sushi & Sashimi", "Ramen & Noodles", "Izakaya"}

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            deps = Deps(st)
            live = deps.backend()
            out = {}
            for sentence in ("想食日本嘢", "越南菜", "想食韓國嘢"):
                ex = extract_intent(sentence, {"now": NOW})
                plan = S.plan_from_intent(ex, query=sentence, now=NOW, limit=8)
                prefs = ex.to_dict().get("preferences") or []
                # the text/relevance lane only: the offline embedder's cosine is noise here and
                # is filed as its own unit
                _c, resp, _b, scored = await S.search(backend=live, plan=plan,
                                                      intent_preferences=prefs, locale="zh-HK")
                out[sentence] = {
                    "total": getattr(resp, "total_estimate", None),
                    "japanese": sum(1 for s in scored if s.candidate.category in JP),
                    "first": scored[0].candidate.category if scored else None,
                }
            everything = await db.fetchval(
                "select count(*) from merchants where status = 'published'")
            plane_total = await db.fetchval("""
                select count(*) from merchants where status = 'published'
                  and (category_primary = 'Restaurants' or category_primary = 'Restaurant')""")
            return {"out": out, "everything": int(everything), "plane": int(plane_total or 0)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_japanese_page_carries_japanese_shops(plane):
    got = plane["out"]["想食日本嘢"]
    assert got["japanese"] >= 1, plane
    assert got["first"] in {"Sushi & Sashimi", "Ramen & Noodles", "Izakaya"}, plane


def test_vietnamese_is_no_longer_the_whole_plane(plane):
    got = plane["out"]["越南菜"]
    assert got["total"] is not None and got["total"] < plane["everything"], plane


def test_the_control_cuisine_did_not_move(plane):
    assert plane["out"]["想食韓國嘢"]["japanese"] == 0, plane
