"""The live-DB proof that a STORED dislike demotes what it refuses (D526).

D522 fixed the transient half of the cuisine preference - the one the user typed in THIS
query. This is the stored half: the row in `user_preferences` the seed writes for the demo
consumer, `food/cuisine_dislike = {"values": ["spicy"]}`.

The reader resolved "spicy" through the cuisine bridge, found no leaf of that name, fell
back to the identity, and matched nothing - so the dislike answered the same number for
every merchant. Measured on this database before the fix, over all 470 published
merchants read as the demo user:

    the 54 merchants the corpus calls spicy  -> mean 0.7403
    the other 416                             -> mean 0.6591

A declared dislike that leaves the refused merchants 0.0812 ABOVE the rest is the D522
inversion again, one plane over. After the fix the same measurement reads 0.5532 against
0.6591: the dislike demotes.

These tests need the demo seed (`NEXUS_TEST_DATABASE_URL` pointed at the seeded `nexus`
database) and skip cleanly without it.
"""

from __future__ import annotations

import asyncio
import os
import statistics

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

DEMO_USER = "00000000-0000-0000-0000-00000000d001"
SPICY_LEAVES = ("hotpot", "korean", "thai", "indian", "singmal")


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _personalization_by_leaf(live_settings) -> tuple[list[float], list[float]]:
    """(the personalization of the merchants the corpus calls spicy, of all the others).

    Read straight through the ranking service rather than through the API, so the number
    is the one the ranker used and not a rounded copy of it on a card.
    """
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class EveryMerchant(S.PostgresBackend):
        """The full published corpus: the dislike must be measured over all of it, not over
        whatever a text query happened to surface."""

        async def merchant_candidates(self, **kw):
            return await self.db.readonly(
                "select * from merchants where status = 'published' order by slug")

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            plan = S.SearchPlan(query_text="", limit=1000)
            _cards, _resp, _bundle, scored = await S.search(
                backend=EveryMerchant(db), plan=plan, user_id=DEMO_USER)
            spicy: list[float] = []
            other: list[float] = []
            for sc in scored:
                row = sc.candidate.raw.get("row", {}) or {}
                tags = set(row.get("tags") or [])
                (spicy if tags & set(SPICY_LEAVES) else other).append(
                    sc.candidate.personalization)
            return spicy, other
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_demo_user_really_declares_the_dislike(live_settings):
    """A gate about a row nobody writes would pass forever."""
    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            rows = await db.readonly(
                "select value from user_preferences where user_id = $1::uuid "
                "and kind = 'food' and key = 'cuisine_dislike'", DEMO_USER)
            return rows
        finally:
            await db_pool.dispose()

    rows = asyncio.run(_go())
    assert rows, (
        "this database carries no food/cuisine_dislike row for the demo user - the "
        "dislike this gate measures is not on this plane")
    payload = rows[0]["value"]
    values = payload.get("values") if isinstance(payload, dict) else payload
    assert "spicy" in (values or []), (
        f"the demo user's dislike row is {payload!r}, not the flavour this gate "
        f"measures - re-aim the gate")


def test_the_corpus_carries_the_leaves_the_dislike_names(live_settings):
    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            rows = await db.readonly(
                "select slug from merchants where status = 'published' and tags && $1::text[]",
                list(SPICY_LEAVES))
            return {r["slug"] for r in rows}
        finally:
            await db_pool.dispose()

    tagged = asyncio.run(_go())
    assert tagged, (
        "no published merchant carries any of the leaves the dislike names, so this "
        "database cannot measure whether the dislike fires")


def test_the_stored_dislike_demotes_the_merchants_it_refuses(live_settings):
    """The whole point of storing a dislike: it must move the refused merchants DOWN."""
    spicy, other = _personalization_by_leaf(live_settings)
    assert spicy and other, (
        f"the corpus split into {len(spicy)} spicy and {len(other)} other merchants - "
        f"one side is empty, so there is nothing to compare")
    assert statistics.mean(spicy) < statistics.mean(other), (
        f"the stored dislike of the word spicy scores the {len(spicy)} merchants the "
        f"corpus calls spicy at {statistics.mean(spicy):.4f} and the other {len(other)} at "
        f"{statistics.mean(other):.4f} - the refusal is not reaching the ranker")
