"""D402 - the RAG retrieval can find a Chinese chunk.

`to_tsvector('simple', ...)` cannot SEGMENT Chinese: a CJK run with no spaces becomes ONE
token, so a Chinese word never matches one. The seeded corpus holds 79 chunks containing
咖啡 and not one of them matches `search_tsv @@ plainto_tsquery('simple','咖啡')`. The
vector lane cannot cover it either - the seeded chunks carry no embedding - so the
retrieval answered "nothing found" for a query the corpus plainly contains.

Two things were missing and both are fixed here:

1. the query had no trigram lane (`similarity()`, which DOES work on CJK where the `%`
   OPERATOR does not: it needs three-character trigrams and a two-character Chinese
   word has none);
2. the route's threshold read only `kw_score` and `vec_score`, so the chunks the trigram
   lane DID match were dropped as sub-threshold noise.
"""

from __future__ import annotations

import json
import os

import pytest

from nexus_ai.search import sql as SQL

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


# --------------------------------------------------------------------------- the query
def test_the_chunk_query_has_a_trigram_lane():
    q = SQL.build_chunk_query(tenant_id="t", merchant_id=None, text="咖啡",
                              embedding=None, top_k=5)
    assert "similarity(" in q.sql
    assert "trigram_score" in q.sql


def test_the_trigram_parameter_is_cast_so_its_type_is_known():
    # `similarity(text, $1)` leaves the parameter type ambiguous (pg_trgm has more than
    # one candidate signature) and Postgres answers
    # `could not determine data type of parameter $1` - a hard error, not a soft one.
    q = SQL.build_chunk_query(tenant_id="t", merchant_id=None, text="咖啡",
                              embedding=None, top_k=5)
    assert "::text)" in q.sql


def test_the_trigram_lane_is_in_the_filter_not_only_the_score():
    # A lane that only scores cannot widen the result set, and the seeded corpus has no
    # embeddings, so the filter is where the Chinese query has to get in.
    q = SQL.build_chunk_query(tenant_id="t", merchant_id=None, text="咖啡",
                              embedding=None, top_k=5)
    where = q.sql.split("WHERE")[1].split("ORDER BY")[0]
    assert "similarity(" in where


def test_the_chunk_query_still_carries_the_tsvector_lane():
    q = SQL.build_chunk_query(tenant_id="t", merchant_id=None, text="cafe",
                              embedding=None, top_k=5)
    assert "ts_rank(" in q.sql
    assert "plainto_tsquery" in q.sql


def test_the_empty_query_is_still_bounded():
    q = SQL.build_chunk_query(tenant_id="t", merchant_id=None, text="",
                              embedding=None, top_k=5)
    assert "LIMIT" in q.sql
    assert q.params[0] == ""


# --------------------------------------------------------------------------- the live plane
@pytest.mark.integration
def test_a_chinese_query_finds_a_chinese_chunk(live_settings=None):
    """The corpus contains 咖啡 and the retrieval used to answer "nothing found"."""
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/rag/retrieve", json={"query": "咖啡", "filters": {},
                                                 "top_k": 3})
        assert r.status_code == 200, r.text
        chunks = r.json().get("chunks") or []
        assert chunks, "the seeded corpus contains 咖啡 and the retrieval found nothing"
        for chunk in chunks:
            assert chunk.get("id")
            assert chunk.get("document_id")
