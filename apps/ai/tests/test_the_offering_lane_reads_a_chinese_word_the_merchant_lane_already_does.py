"""D583 - the OFFERING lane reads a Chinese word the way the merchant lane already does.

D407 gave the merchant lane a containment leg and measured why: `to_tsvector` cannot segment
Chinese, a two-character word has no trigram, so a Chinese query ranked the pool by rating and
answered with whatever came first. The offering lane was left with the same three legs and none
of them works on Chinese, and nothing said so, because every door the lane carried asked about
English offerings or about the merchant page. Measured on the plane the service reads (5534
offerings, 4706 active on published merchants: 3572 product, 822 service, 313 experience):

    word    offerings whose own text holds it | the page BEFORE, of 10 | the page AFTER
    咖啡    80  (all of them products)        |  1 mentions it         | 10 mention it
    拉麵    43                                |  8                     | 10
    甜品    39                                |  6                     | 10

and the page's own `kw_score` was the SAME number for every row (0.3333 for 咖啡, from
`word_similarity` alone), which is what an ordering by rating looks like. The offering text
cannot be matched by the tsvector either: `to_tsvector('simple', '位上甜品') @@
plainto_tsquery('simple', '甜品')` answers False, and so does the english config.

The fix is D407's leg aimed at the offering's OWN four text columns - not the merchant's - so
the two lanes answer one Chinese word with one order (D449: two readers of one fact). The
promise is the ORDER and the RECALL, not a filter: the lane is a score, so a corpus that holds
the word in no offering of the asked kind still answers with the best it has (measured: 甜品 in
0 service and 0 experience offerings, and the page mentions it 0 times before AND after - which
is why the control rows below ask for no more than that).
"""

from __future__ import annotations

import asyncio
import os

import pytest

from nexus_ai.search import sql as SQL
from nexus_ai.search.tokens import cjk_keywords

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TENANT = "00000000-0000-0000-0000-000000000001"

KAFFE = "\u5496\u5561"
RAMEN = "\u62c9\u9eb5"
DESSERT = "\u751c\u54c1"

#: The offering's own text, the same concatenation the leg reads.
_OFFERING_TEXT = ("coalesce(o.name,'') || ' ' || coalesce(o.name_zh,'') || ' ' ||"
                  " coalesce(o.description,'') || ' ' || coalesce(o.description_zh,'')")


# ------------------------------------------------------------------- the query shape
def test_the_offering_query_carries_a_containment_lane():
    q = SQL.build_offering_query(tenant_id=TENANT, text=KAFFE, limit=10)
    assert "strpos(" in q.sql, "the containment lane is missing from the offering query"
    assert "unnest(" in q.sql


def test_the_containment_lane_is_off_for_an_english_query():
    # No Chinese words, no lane: the English path's SQL must not change.
    q = SQL.build_offering_query(tenant_id=TENANT, text="coffee", limit=10)
    assert "strpos(" not in q.sql
    assert "unnest(" not in q.sql


def test_the_lane_binds_its_words_as_a_parameter():
    # Nothing is inlined: the words are bound, so a quote in a query cannot become SQL.
    q = SQL.build_offering_query(tenant_id=TENANT, text=KAFFE, limit=10)
    assert any(v == [KAFFE] for v in q.params), q.params
    assert KAFFE not in q.sql


def test_the_leg_reads_the_offerings_own_text_not_the_merchants():
    # The merchant lane reads m.display_name_zh / m.description / m.tags; this one is about
    # the offering, and a leg that reached for the merchant's text would answer the merchant
    # page twice and the offering page never.
    q = SQL.build_offering_query(tenant_id=TENANT, text=KAFFE, limit=10)
    leg = q.sql[q.sql.index("strpos("):q.sql.index("strpos(") + 400]
    for column in ("o.name", "o.name_zh", "o.description", "o.description_zh"):
        assert column in leg, f"{column} is not part of the containment target"
    assert "m.display_name" not in leg


def test_both_lanes_read_the_same_word_with_the_same_leg():
    # One fact, two readers (D449): the word list each lane binds is the same list, so the
    # lanes cannot drift into two different ideas of what a Chinese word is.
    words = SQL.build_merchant_query(tenant_id=TENANT, text=KAFFE, embedding=None, limit=10)
    offerings = SQL.build_offering_query(tenant_id=TENANT, text=KAFFE, limit=10)
    assert "strpos(" in words.sql and "strpos(" in offerings.sql
    assert cjk_keywords(KAFFE) in [v for v in words.params if isinstance(v, list)]
    assert cjk_keywords(KAFFE) in [v for v in offerings.params if isinstance(v, list)]


def test_a_browse_request_claims_no_text_match():
    # No query text: every row the filters allow is returned, and none of them claims a
    # match - the ranking floor reads that flag to decide whether a query exists at all.
    q = SQL.build_offering_query(tenant_id=TENANT, text=None, limit=10)
    assert "false AS text_matched" in q.sql
    assert "strpos(" not in q.sql


# ------------------------------------------------------------------- the live plane
async def _fetch(sql: str, *params) -> list[dict]:
    import asyncpg

    conn = await asyncpg.connect(DB_URL)
    try:
        return [dict(r) for r in await conn.fetch(sql, *params)]
    finally:
        await conn.close()


async def _corpus_count(word: str) -> int:
    import asyncpg

    conn = await asyncpg.connect(DB_URL)
    try:
        return int(await conn.fetchval(
            "select count(*) from offerings o join merchants m on m.id = o.merchant_id "
            "where o.tenant_id = $1::uuid and o.status = 'active' "
            f"and m.status = 'published' and lower({_OFFERING_TEXT}) like '%' || $2 || '%'",
            TENANT, word.lower()))
    finally:
        await conn.close()


def _blob(row: dict) -> str:
    """The offering row's own text, lower-cased - what a mention is measured against."""
    return " ".join(str(row.get(k) or "") for k in
                    ("name", "name_zh", "description", "description_zh")).lower()


@pytest.mark.integration
@pytest.mark.parametrize("word", [KAFFE, RAMEN, DESSERT])
def test_the_page_the_offering_lane_returns_is_ordered_by_mention(word):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    held = asyncio.run(_corpus_count(word))
    if not held:
        pytest.skip(f"this corpus holds no offering whose text says {word}")

    rows = asyncio.run(_fetch(*_page(word, 60)))
    ids = [str(r["id"]) for r in rows]
    mentioning = [i for i, r in enumerate(rows) if word.lower() in _blob(r)]
    if not mentioning:
        pytest.skip(f"no offering in the page mentions {word}")

    # The promise D422 reframed for the merchant lane: the lane is a SCORE, so the order is
    # what a user is owed, not a filter.
    worst_mentioning = max(mentioning)
    others = [i for i in range(len(rows)) if i not in mentioning]
    best_other = min(others) if others else len(rows)
    assert worst_mentioning < best_other, (
        f"the offerings that mention {word} are not ranked above the ones that do not: {ids}")

    # And the recall the leg exists for: when the corpus holds fewer mentioning offerings than
    # the page, EVERY one of them is in the page. Measured before the leg: 咖啡 held 80 and the
    # 60-row page carried 24 of them; 拉麵 held 43 and the page carried 39.
    if held <= len(rows):
        assert len(mentioning) == held, (
            f"the corpus holds {held} offerings that say {word} and the page of "
            f"{len(rows)} carries {len(mentioning)} of them")


def _page(word: str, limit: int) -> tuple:
    q = SQL.build_offering_query(tenant_id=TENANT, text=word, limit=limit)
    return (q.sql, *q.params)


@pytest.mark.integration
def test_an_english_offering_query_is_still_answered_and_still_ordered():
    # The control: the leg is for Chinese, and the English path was already working. Its SQL
    # is the one this unit did not change, so the row asserts the ANSWER.
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    rows = asyncio.run(_fetch(*_page("coffee", 20)))
    assert rows, "the corpus holds offerings named in English and the lane answered with none"
    mentioning = [i for i, r in enumerate(rows) if "coffee" in _blob(r)]
    if not mentioning:
        pytest.skip("this corpus carries no offering whose text mentions coffee")
    others = [i for i in range(len(rows)) if i not in mentioning]
    assert max(mentioning) < (min(others) if others else len(rows)), (
        f"the English path's own order moved: the offerings that mention coffee are not "
        f"ranked above the ones that do not: {[str(r['id']) for r in rows]}")
