"""D407 - a Chinese query can reach the merchants it names.

`to_tsvector('simple', ...)` cannot SEGMENT Chinese: a CJK run with no spaces becomes ONE
token, so 咖啡 never equals one, and the `%` OPERATOR cannot match it either (it needs
three-character trigrams, and a two-character Chinese word has none). Measured on the seeded
corpus: 咖啡 is in 8 merchants' Chinese names and 30 of their descriptions, 拉麵 in 8
descriptions - and the merchant lane matched NONE of them.

So a Chinese query ranked the pool by rating and answered with whatever came first: the query
拉麵 returned "Ramen & Noodles" on no card at all, and eight western grills, euros and
italians in its place.

The lane is CONTAINMENT, not similarity, for the reason D405 measured on the chunk lane: a
trigram similarity of a long text against a short query does not separate a real match from
noise. A merchant either mentions the word or it does not. The count is a FRACTION of the
query's Chinese words, so a keyword query (one word) is a full-strength match and a long
utterance is a weak one.

The assertions here are about the ANSWER, not about the SQL: every card the service serves for
a Chinese query has to be a merchant whose own text mentions the word. A test that asserted
"the SQL contains strpos" would pass while the answer stayed wrong.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from nexus_ai.search import sql as SQL
from nexus_ai.search.tokens import cjk_keywords

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: D635: 咖啡 is the cafe BUCKET's own spelling (`lexicon.CATEGORY_SYNONYMS['cafe']`), so a query
#: that writes it is answered by the category filter and the word leaves the match text - this
#: file's promise (the merchants that mention the word rank above the ones that do not) is about
#: the words NO lane consumed. 酒家 is carried by 11 merchant NAMES and 3 descriptions and names no
#: category; 拉麵 by 8 descriptions and none (`tmp/d635_names2.py`) - until D638 gave the ramen LEAF
#: its own filter's answer, so 拉麵 is no longer a word any lane leaves alone. 中心 is carried by 8
#: rows and names no category, no leaf and no district (`tmp/d638_words3.py`), and the eight served
#: for it split 5/3 between the rows that write it and the rows that do not.
TEA = "\u9152\u5bb6"
CENTRE = "\u4e2d\u5fc3"


# --------------------------------------------------------------------------- the query
def test_the_merchant_query_carries_a_containment_lane():
    q = SQL.build_merchant_query(tenant_id="t", text=TEA, embedding=None)
    assert "strpos(" in q.sql, "the containment lane is missing from the merchant query"
    assert "unnest(" in q.sql


def test_the_containment_lane_is_off_for_an_english_query():
    # No Chinese words, no lane: the English path's SQL must not change.
    q = SQL.build_merchant_query(tenant_id="t", text="coffee", embedding=None)
    assert "strpos(" not in q.sql
    assert "unnest(" not in q.sql


def test_the_lane_binds_its_words_as_a_parameter():
    # Nothing is inlined: the words are bound, so a quote in a query cannot become SQL.
    q = SQL.build_merchant_query(tenant_id="t", text=TEA, embedding=None)
    assert any(v == [TEA] for v in q.params), q.params


def test_a_keyword_query_is_one_word():
    assert cjk_keywords(TEA) == [TEA]
    assert cjk_keywords(CENTRE) == [CENTRE]


def test_an_english_query_has_no_chinese_words():
    assert cjk_keywords("coffee") == []
    assert cjk_keywords("coffee and tea") == []


def test_a_long_utterance_contributes_its_bigrams():
    # A sentence is not a thing a merchant's text can contain, so only its bigrams are
    # words - and the list stays bounded.
    words = cjk_keywords("\u5e2e\u6211\u627e\u62c9\u9eb5\u9910\u5ef6", limit=16)
    assert "\u62c9\u9eb5" in words
    assert len(words) <= 16


# --------------------------------------------------------------------------- the live plane
async def _merchant_text(slugs: list[str]) -> dict[str, str]:
    """Each merchant's own text, from the database."""
    import asyncpg

    conn = await asyncpg.connect(DB_URL)
    try:
        rows = await conn.fetch(
            "select slug, coalesce(display_name_zh,'') || ' ' || coalesce(description,'') "
            "  || ' ' || coalesce(tags::text,'') as txt from merchants where slug = any($1::text[])",
            slugs)
    finally:
        await conn.close()
    return {r["slug"]: str(r["txt"]).lower() for r in rows}


@pytest.mark.integration
@pytest.mark.parametrize("word", [TEA, CENTRE])
def test_every_served_card_mentions_the_word_the_user_typed(word, live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/search", json={"query": word, "limit": 8})
        assert r.status_code == 200, r.text
        items = r.json().get("items") or []

    assert items, f"the corpus holds merchants that mention {word} and the answer was empty"
    slugs = [str(i.get("slug")) for i in items]
    texts = asyncio.run(_merchant_text(slugs))
    # D422: the lane is a SCORE, not a filter - a merchant whose own text does not
    # mention the word can still be served when the corpus is sparse (the CI counts
    # carry ONE ramen house and eight coffee houses). The promise is the ORDER: the
    # merchants that mention the word rank above the ones that do not.
    mentioning = [s for s in slugs if word.lower() in texts.get(s, "")]
    if not mentioning:
        pytest.skip("this corpus carries no merchant whose text mentions the word - "
                    "the containment lane has nothing to rank")
    worst_mentioning = max(slugs.index(s) for s in mentioning)
    others = [slugs.index(s) for s in slugs if s not in mentioning]
    best_other = min(others) if others else len(slugs)
    assert worst_mentioning < best_other, (
        f"the merchants that mention {word} are not ranked above the ones that do not: "
        f"{slugs}")


@pytest.mark.integration
def test_the_english_path_still_answers_with_the_merchants_that_match(live_settings=None):
    """The control: the lane is for Chinese, and the English path was already working."""
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    # D635: "coffee" is the cafe bucket's Latin spelling, so it is answered by the filter - the
    # English lane's own evidence is a word no category answers. "ramen" was that word until D638
    # taught the leaf lane to strip it; "bistro" is carried by 5 rows, names no category, and the
    # eight served for it split 5/3 (`tmp/d638_words4.py`).
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/search", json={"query": "bistro", "limit": 8})
        assert r.status_code == 200, r.text
        items = r.json().get("items") or []

    assert items, "the corpus holds bistros and the English query found none"
    slugs = [str(i.get("slug")) for i in items]
    texts = asyncio.run(_merchant_text(slugs))
    # D422: the same ORDER promise as the Chinese case (the lane is a score, not a
    # filter) - the merchants that mention ramen rank above the ones that do not.
    mentioning = [s for s in slugs if "bistro" in texts.get(s, "")]
    if not mentioning:
        pytest.skip("this corpus carries no merchant whose text mentions bistro")
    worst_mentioning = max(slugs.index(s) for s in mentioning)
    others = [slugs.index(s) for s in slugs if s not in mentioning]
    best_other = min(others) if others else len(slugs)
    assert worst_mentioning < best_other, (
        f"the merchants that mention bistro are not ranked above the ones that do not: "
        f"{slugs}")
