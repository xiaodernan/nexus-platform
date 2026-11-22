"""A shared character is not a word, and the keyword lane was saying it was.

D705 ruled that a score which cannot say what it MEANS may not claim a match, and capped the
vector cosine by the keyword score on a non-semantic space. One witness of the same shape was
still voting alone: the keyword score is a GREATEST of ts_rank, trigram `similarity` on the name,
and `word_similarity` over name+description+tags. pg_trgm's trigrams are CHARACTER triples, so a
two-character query shares one with a two-character name whose other character differs - and that
fraction sat above the `%` operator's own 0.3 threshold, so the flag agreed with the score.

Measured on the published plane (470 merchants, 5,538 offerings, `tmp/d709_page.py`, 11:00 HKT
Thursday): 「海景」 - a word no row writes - answered 海薈, a hot-pot house, at `kw_score` 0.3333 and
LED the live page. 「泰式餐廳」 read 4 of 泰國's rows the same way (§684). Both are one character
away from the word and nothing else.

The corpus either mentions the word or it does not, and that is exactly what the containment leg
counts (D407, D583): `strpos` over the query's Chinese words in name/description/tags, as a fraction
of the query's words. So on a CJK query the similarity arms are now capped by that fraction - they
may REFINE a mention, never create one - and `text_matched` reads only the witnesses that can say
what they mean: the tsvector's own tokens and the containment count. A Latin query keeps the
uncapped arms, because `%` needs three-character trigrams and is the arm that reads an English
word at all.

    request          before                        after
    海景 (0 rows)    kw 0.3333 on 海薈, flagged     kw 0 on every row, flagged on none
    素食             kw 1.0 on its mentioning rows  unchanged (a real mention still witnesses)

Filed, not claimed: the two lanes still order a page differently (the fixture lane counts exact
substring hits and the live lane keeps a rating-ordered candidate cut, D708). This unit makes the
live score HONEST; it does not pretend the lanes are the same function.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from nexus_ai.search.sql import build_merchant_query, build_offering_query

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TENANT = "00000000-0000-0000-0000-000000000001"


# ------------------------------------------------------------------ the SQL shape
def _merchant_sql(text):
    return build_merchant_query(tenant_id=TENANT, text=text, embedding=None,
                                filters={}, limit=60).sql


def _offering_sql(text):
    return build_offering_query(tenant_id=TENANT, text=text, filters={},
                                limit=60).sql


def test_a_chinese_request_caps_the_similarity_arms_by_the_containment_fraction():
    sql = _merchant_sql("海景")
    assert "LEAST(" in sql, sql
    # the `%` operator's verdict is not a witness for a CJK query: it fires on a shared character
    assert "m.display_name %" not in sql, sql


def test_the_offering_lane_reads_the_same_rule():
    sql = _offering_sql("海景")
    assert "LEAST(" in sql, sql
    assert "o.name %" not in sql, sql


def test_a_latin_request_keeps_the_arms_that_read_it():
    # `%` needs three-character trigrams, so it is the arm that reads an English word at all.
    sql = _merchant_sql("cafe")
    assert "LEAST(" not in sql, sql
    assert "m.display_name %" in sql, sql


def test_the_cap_is_the_containment_fraction_and_not_a_constant():
    sql = _merchant_sql("海景")
    assert "LEAST(GREATEST(" in sql, sql


# ------------------------------------------------------------------ the corpus
@pytest.fixture(scope="module")
def planes():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = Deps(st).backend()
            out = {}
            for word in ("海景", "素食", "咖啡"):
                merchants = await backend.merchant_candidates(
                    tenant_id=TENANT, text=word, embedding=None, filters={},
                    geo=None, radius_m=None, limit=60, with_total=True)
                offerings = await backend.offering_candidates(
                    tenant_id=TENANT, text=word, filters={}, geo=None,
                    radius_m=None, limit=60, with_total=True, party_size=None)
                out[word] = {
                    "kw": [float(r.get("kw_score") or 0) for r in merchants],
                    "flagged": [bool(r.get("text_matched")) for r in merchants],
                    "o_kw": [float(r.get("kw_score") or 0) for r in offerings],
                }
            census = {}
            for word in ("海景", "海鮮"):
                census[word] = {
                    "merchants": int(await db.fetchval(
                        "select count(*) from merchants where status = 'published' and ("
                        " display_name ilike '%'||$1||'%' or coalesce(display_name_zh,'')"
                        " ilike '%'||$1||'%' or coalesce(description,'') ilike '%'||$1||'%'"
                        " or tags::text ilike '%'||$1||'%')", word)),
                    "offerings": int(await db.fetchval(
                        "select count(*) from offerings where ("
                        " name ilike '%'||$1||'%' or coalesce(name_zh,'')"
                        " ilike '%'||$1||'%' or coalesce(description,'')"
                        " ilike '%'||$1||'%')", word)),
                }
            return {"kw": out, "census": census}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_word_no_row_writes_scores_nothing_on_either_lane(planes):
    got = planes["kw"]["海景"]
    assert max(got["kw"], default=0.0) == 0.0, got["kw"]
    assert max(got["o_kw"], default=0.0) == 0.0, got["o_kw"]
    assert not any(got["flagged"]), "a shared character still claims a match"


def test_a_real_mention_still_witnesses(planes):
    # the control: the cap must not silence the word the corpus DOES write.
    assert max(planes["kw"]["素食"]["kw"], default=0.0) > 0.0, planes["kw"]["素食"]["kw"]
    assert max(planes["kw"]["咖啡"]["kw"], default=0.0) > 0.0, planes["kw"]["咖啡"]["kw"]
    assert max(planes["kw"]["咖啡"]["o_kw"], default=0.0) > 0.0, planes["kw"]["咖啡"]["o_kw"]
    assert any(planes["kw"]["咖啡"]["flagged"]), planes["kw"]["咖啡"]["flagged"]


def test_the_corpus_writes_the_word_nowhere(planes):
    assert planes["census"]["海景"] == {"merchants": 0, "offerings": 0}, planes["census"]
