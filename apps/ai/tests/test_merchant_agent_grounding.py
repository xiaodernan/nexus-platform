"""D405 - the merchant agent answers when the merchant's KB holds the answer, and hands
off when it does not.

The grounding test was `bool(chunks) and score >= 0.35`, and no corpus could reach 0.35: the
best retrieval score measured on the seeded plane is **0.0865** for a good English match and
**0.0000** for a Chinese one (`ts_rank` over a long chunk is small, and the tsvector cannot
segment CJK - D403). So EVERY question received the same three frames - `status`, `summary`
("I could not find that, here is a human to ask"), `done` - with `"citations":[]`, for
merchants whose knowledge base plainly holds the answer.

The floor is now the CONTAINMENT: a chunk grounds the answer when it MENTIONS what was asked.
The similarity number cannot decide it - a real Chinese match scores 0.0063 and a nonsense
query scores 0.0093 (the noise is HIGHER) - so it widens the candidate set and the text itself
decides.

Two arms, both on the live plane, because the defect was a behaviour and a behaviour is only
visible against a corpus that holds the thing being asked about:

  * the KB holds it  -> the agent answers, with citations, `degraded: false`;
  * the KB does not  -> the agent hands off, with no citations, `degraded: true`.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: The term the seeded merchant knowledge bases hold (the menu heading).
TERM = "\u5168\u65e5\u83dc\u55ae"

#: A term no knowledge base holds, and no trigram noise can fake.
NONSENSE = "zzqxwv"


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


async def _merchant_holding(term: str) -> tuple[str, str] | None:
    """The first merchant whose knowledge base holds `term`."""
    import asyncpg

    from nexus_ai.search.service import DEFAULT_TENANT_ID

    conn = await asyncpg.connect(DB_URL)
    try:
        row = await conn.fetchrow(
            """
            select m.id::text as id, m.slug
              from chunks c
              join merchants m on m.id = c.merchant_id
             where c.text ilike '%' || $1 || '%'
               and m.tenant_id = $2
             order by m.slug
             limit 1
            """, term, str(DEFAULT_TENANT_ID))
    finally:
        await conn.close()
    return (row["id"], row["slug"]) if row else None


def _chat(client, merchant_id: str, message: str) -> dict:
    """The chat's own frames, parsed out of the SSE body."""
    import json

    with client.stream("POST", "/ai/v1/merchant-agent/chat",
                       json={"merchant_id": merchant_id, "message": message,
                             "conversation_id": str(uuid.uuid4())}) as resp:
        assert resp.status_code == 200, resp.status_code
        frames = [ln for ln in resp.iter_lines() if ln.startswith("data:")]

    out: dict = {}
    for line in frames:
        payload = json.loads(line[len("data:"):].strip())
        if "text" in payload and "citations" in payload:
            out["summary"] = payload
        if "degraded" in payload:
            out["done"] = payload
    return out


# --------------------------------------------------------------------------- the live plane
@pytest.mark.integration
def test_the_agent_answers_when_the_kb_holds_the_answer(live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    found = asyncio.run(_merchant_holding(TERM))
    assert found is not None, "the seeded corpus holds a merchant whose KB has the menu"
    merchant_id, slug = found

    with TestClient(create_app(_settings())) as c:
        frames = _chat(c, merchant_id, TERM)

    assert frames.get("summary"), f"no summary frame for {slug}: {frames}"
    assert frames["summary"]["citations"], (
        f"{slug} holds {TERM} in its KB and the agent cited nothing")
    assert frames["done"]["degraded"] is False, frames


@pytest.mark.integration
def test_the_agent_hands_off_when_the_kb_does_not_hold_it(live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    found = asyncio.run(_merchant_holding(TERM))
    assert found is not None, "the seeded corpus holds a merchant whose KB has the menu"
    merchant_id, slug = found

    with TestClient(create_app(_settings())) as c:
        frames = _chat(c, merchant_id, NONSENSE)

    assert frames.get("summary"), f"no summary frame for {slug}: {frames}"
    assert frames["summary"]["citations"] == [], (
        f"{slug} does not hold {NONSENSE} and the agent cited something anyway")
    assert frames["done"]["degraded"] is True, frames
