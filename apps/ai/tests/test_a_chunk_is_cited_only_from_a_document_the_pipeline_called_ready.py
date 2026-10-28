"""D586 - a chunk is cited only from a document the pipeline called ready.

The write plane has a state for "this merchant's text has changed and the indexed copy is
not the current one". `MerchantKnowledgeRepository.markForReindex` moves the row with
`update documents d set status = 'pending', error = null` and its own comment says what that
leaves behind: "this method does not touch `chunks`". So in the window between a merchant
saving new knowledge and the reindex running, the OLD chunk text is still in `chunks`, the
document says `pending`, and the shipped retrieval -

    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.tenant_id = $2::uuid AND (...)

- reads it and cites it. Measured at HEAD the read never mentions `d.status`, so an answer
can quote a merchant's superseded opening hours or a policy they just rewrote, with a
`source_uri` pointing at the document that is marked as being rebuilt. D585's shape one
table over: the reader not looking at the column the writer writes.

This plane cannot show it either: all 1,040 documents are `indexed` (censused below), so no
live row is in the window. The gate therefore shadows ONLY the `documents` side of the join
with a CTE derived from the real table and one column overridden - the query text stays the
shipped one, `chunks` stays the real table, and nothing is written anywhere.

Proved to fail: the `pending` shadow returns the top-5 unchanged while this file's gate
demands none (both halves of the red); deleting the `d.status` predicate reddens the column
gate; a predicate of `d.status <> 'failed'` reddens the `processing` shadow while leaving
the `indexed` census green, so the gate is not satisfied by any filter that keeps a
not-ready row.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.sql as SQL
from nexus_ai.search.service import DEFAULT_TENANT_ID

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: the states the pipeline's own column admits (V1__init.sql:505) other than the ready one.
NOT_READY = ("pending", "processing", "failed")

#: any text that the corpus's chunks answer - the words are not what the gate is about.
_TEXT = "海景"

live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="0" * 8)


def _run(live_settings, query: str, params) -> list[dict]:
    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            return await db.readonly(query, *params)
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _chunk_read(live_settings, status_override: str | None = None,
                *, merchant_id: str | None = None, top_k: int = 5) -> list[dict]:
    """Run the shipped chunk read; with `status_override`, against a `documents` CTE that
    reports every real document as that status.

    A non-recursive CTE is not in scope inside its own body, so `from documents` there is
    still the real table: the shadow is the live corpus with one column rewritten.
    """
    cq = SQL.build_chunk_query(tenant_id=str(DEFAULT_TENANT_ID), merchant_id=merchant_id,
                               text=_TEXT, embedding=None, top_k=top_k)
    query = cq.sql
    if status_override is not None:
        query = (f"WITH documents AS (select id, source_uri, {status_override!r}::text "
                 f"as status from documents)\n{cq.sql}")
    return _run(live_settings, query, cq.params)


def _ids(rows) -> list[str]:
    return [r["id"] for r in rows]


# ------------------------------------------------------------------ the window
@live_only
@pytest.mark.parametrize("status", NOT_READY, ids=list(NOT_READY))
def test_a_document_the_pipeline_has_not_finished_is_not_cited(live_settings, status):
    """Every not-ready state, run against the real chunks: the read must come back with
    nothing to cite rather than with superseded text."""
    got = _chunk_read(live_settings, status_override=status)
    assert not got, (
        f"with every document reported as {status!r}, the chunk read still returned "
        f"{len(got)} rows ({_ids(got)[:3]}...) - citing text whose document the write plane "
        f"has marked as not the current one")


@live_only
def test_an_indexed_document_is_cited_exactly_as_it_is_today(live_settings):
    """The predicate must not change the answer on a plane where everything is ready."""
    real = _ids(_chunk_read(live_settings))
    shadow = _ids(_chunk_read(live_settings, status_override="indexed"))
    assert real, f"the shipped read returns nothing for {_TEXT!r} - the check would be vacuous"
    assert shadow == real, (
        f"reporting every document as indexed changed the top-5 from {len(real)} to "
        f"{len(shadow)} rows - the readiness filter is not the no-op it claims")


@live_only
def test_the_read_names_the_column_the_writer_moves():
    sql_only = SQL.build_chunk_query(tenant_id=str(DEFAULT_TENANT_ID), merchant_id=None,
                                     text=_TEXT, embedding=None, top_k=5).sql
    assert "d.status" in sql_only, (
        f"the chunk read carries no document-readiness predicate:\n{sql_only}")


@live_only
def test_the_merchant_scoped_read_honours_it_too(live_settings):
    """The same WHERE is built for a merchant-scoped retrieval; the readiness predicate must
    not belong only to the tenant-wide branch.

    The merchant is taken from what the tenant-wide read actually cites, so the scoped read
    is known to have something to withhold.
    """
    cited = _chunk_read(live_settings)
    merchant = next((r["merchant_id"] for r in cited if r.get("merchant_id")), None)
    if merchant is None:
        pytest.skip("the chunks this plane cites carry no merchant_id")
    assert _chunk_read(live_settings, merchant_id=merchant), (
        f"the scoped read for {merchant} cites nothing even ready - the branch is not "
        f"exercised, so the check below would prove nothing")
    assert not _chunk_read(live_settings, status_override="pending", merchant_id=merchant), (
        "the merchant-scoped read cited a pending document's chunks")


# ------------------------------------------------------------------ the plane it runs on
@live_only
def test_the_plane_censused_is_the_one_the_predicate_cannot_see(live_settings):
    """Recording WHY the shadow is needed: today every document is indexed, so a live read
    would pass with or without the fix - the gap is real and this plane cannot show it."""
    census = _run(live_settings,
                  "select d.status, count(*) as documents, count(c.id) as chunks "
                  "from documents d left join chunks c on c.document_id = d.id "
                  "group by d.status order by d.status", ())
    assert census, "no documents on this plane - the retrieval has nothing to cite at all"
    assert {r["status"] for r in census} == {"indexed"}, (
        f"this plane now carries {census} - a live not-ready document would let the shadow "
        f"tests above be replaced by a real one")
