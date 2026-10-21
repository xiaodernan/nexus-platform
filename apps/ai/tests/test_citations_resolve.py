"""D465 - a citation has to resolve, and a fact link the corpus cannot carry has to stay empty.

The contract's §7 row gives every RAG chunk a `fact_ids` ✓, and RAG.md's pipeline table
says the pack carries them "for citation" ✓. The service has always sent an **empty
list** ✓, and the measurement says why ✓:

  * the `chunks` table has no column for a fact link ✓;
  * the chunk's `metadata` carries none ✓ (a note, the sections, the embedding, the origin,
    the overlap) ✓;
  * **0** of the corpus's 1228 facts have a `source_uri` that matches a document's ✓ - the
    facts' URIs are per fact (`demo://seed/price/<slug>`) and the documents' are per
    document (`demo://seed/menu/<slug>.txt`) ✓, so there is nothing to join on ✓.

So the corpus cannot fill the field ✓, and the honest answer is the empty list ✓ - a
non-empty one would be a citation that does not resolve ✓.

The gate says both halves: a chunk's `fact_ids` is **empty or every id resolves to a fact
row** ✓ (so the field can be filled the moment the corpus can carry it ✓, and never with an
invention ✓), and the chat's **citations resolve to chunks** ✓ - a citation the client
cannot open is a dead source ✓.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.nlu import lexicon as L

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

RAMEN = L.CUISINE_TERMS["japanese"][5]
MERCHANT = "06f59af6-f7b7-59e0-b63e-4909f8632998"  # a seeded merchant with a knowledge base
CONVERSATION = str(uuid.UUID(int=8))


def _client():
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    return TestClient(create_app(settings))


def _fetch(sql: str, *args):
    async def _read():
        import asyncpg

        conn = await asyncpg.connect(DB_URL)
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()

    return asyncio.run(_read())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_chunk_fact_id_resolves_to_a_fact_row():
    with _client() as c:
        r = c.post("/ai/v1/rag/retrieve",
                   json={"query": RAMEN, "filters": {}, "top_k": 5})
        assert r.status_code == 200, r.text
        chunks = r.json()["chunks"]
    assert chunks, "the retrieval returned no chunk - the corpus is not reachable"

    for chunk in chunks:
        fact_ids = chunk.get("fact_ids") or []
        if not fact_ids:
            # the corpus carries no chunk->fact link, so the empty list is the honest answer
            # (D465: the schema has no column, the metadata carries none, and 0 of the
            # corpus's facts have a source_uri that matches a document's)
            continue
        rows = _fetch("SELECT id FROM facts WHERE id::text = ANY($1::text[])",
                      [str(f) for f in fact_ids])
        missing = set(str(f) for f in fact_ids) - set(str(r["id"]) for r in rows)
        assert not missing, (
            f"the chunk {chunk['id']} cites facts that do not exist: {sorted(missing)} - a "
            f"citation that does not resolve is a dead source")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_chats_citations_resolve_to_chunks():
    from nexus_ai.api.sse import parse_frames

    with _client() as c:
        with c.stream("POST", "/ai/v1/merchant-agent/chat", json={
                "merchant_id": MERCHANT, "message": "full menu",
                "conversation_id": CONVERSATION}) as resp:
            assert resp.status_code == 200, resp.status_code
            raw = "".join(resp.iter_text())

    frames = parse_frames(raw)
    summaries = [data for name, data in frames if name == "summary"]
    assert summaries, f"the chat emitted no summary frame: {[n for n, _ in frames]}"
    citations = [str(c) for c in (summaries[-1].get("citations") or [])]
    assert citations, (
        "the chat answered with no citation at all - a grounded answer that cites nothing "
        "cannot be checked by anyone")
    rows = _fetch("SELECT id FROM chunks WHERE id::text = ANY($1::text[])", citations)
    missing = set(citations) - set(str(r["id"]) for r in rows)
    assert not missing, (
        f"the chat cited chunks that do not exist: {sorted(missing)} - a citation the client "
        f"cannot open is a dead source")
