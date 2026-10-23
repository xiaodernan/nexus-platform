"""The live-DB proof that a weak preference keeps the user's side of neutral (D527).

The ranker's boolean matchers read a weight as `w if liked else 1 - w`, which inverts the
moment the weight drops below 0.5. The seed declares `access/accessible` at **0.4** - the
one row in the demo corpus below the midpoint - so this is not a hypothetical: measured on
the live corpus, a user who says step-free access matters a little was served the merchants
that have none at 0.6 and the merchants that have it at 0.4.

This reads the real published rows out of the database, splits them on the attribute the
corpus actually writes, and runs the ranker over each half with the seed's own weight. It
needs the demo seed (`NEXUS_TEST_DATABASE_URL`) and skips cleanly without it.
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

KIND, KEY, WEIGHT = "access", "accessible", 0.4


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _rows(live_settings) -> tuple[list[dict], list[dict]]:
    """(the published merchants the corpus calls accessible, the ones it does not)."""
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class EveryMerchant(S.PostgresBackend):
        async def merchant_candidates(self, **kw):
            return await self.db.readonly(
                "select * from merchants where status = 'published' order by slug")

        async def user_preferences(self, user_id, kinds=None):
            return [{"user_id": "u1", "kind": KIND, "key": KEY,
                     "value": json.dumps({"value": True}), "weight": WEIGHT,
                     "source": "declared", "scope": "long_term"}]

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            plan = S.SearchPlan(query_text="", limit=1000)
            _cards, _resp, _bundle, scored = await S.search(
                backend=EveryMerchant(db), plan=plan, user_id="u1")
            yes: list[dict] = []
            no: list[dict] = []
            for sc in scored:
                attrs = sc.candidate.raw.get("row", {}).get("attributes") or {}
                if attrs.get("accessible_access") is True or attrs.get("wheelchair_access") is True:
                    yes.append(sc.candidate.raw.get("row", {}))
                elif (attrs.get("accessible_access") is False
                      or attrs.get("wheelchair_access") is False):
                    no.append(sc.candidate.raw.get("row", {}))
            return yes, no
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _mean_personalization(live_settings, rows, kind, key, weight, value) -> float:
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class Fixed(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

        async def user_preferences(self, user_id, kinds=None):
            return [{"user_id": "u1", "kind": kind, "key": key,
                     "value": json.dumps({"value": value}), "weight": weight,
                     "source": "declared", "scope": "long_term"}]

    async def _go():
        await db_pool.connect(live_settings, force_new=True)
        try:
            plan = S.SearchPlan(query_text="", limit=1000)
            _cards, _resp, _bundle, scored = await S.search(
                backend=Fixed(merchants=rows), plan=plan, user_id="u1")
            values = [sc.candidate.personalization for sc in scored
                      if sc.candidate.personalization is not None]
            return statistics.mean(values) if values else float("nan")
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_corpus_carries_the_attribute_on_both_sides(live_settings):
    """A gate measured over one side only proves nothing."""
    yes, no = _rows(live_settings)
    assert yes and no, (
        f"the corpus split into {len(yes)} accessible and {len(no)} inaccessible merchants "
        f"- one side is empty, so this database cannot measure the preference")


def test_a_weak_preference_keeps_the_accessible_merchants_ahead(live_settings):
    """The seed's own weight, read against the corpus's own rows."""
    yes, no = _rows(live_settings)
    assert yes and no, "the corpus does not split on the attribute - see the other check"
    liked = _mean_personalization(live_settings, yes, KIND, KEY, WEIGHT, True)
    avoided = _mean_personalization(live_settings, no, KIND, KEY, WEIGHT, True)
    assert liked > avoided, (
        f"a weight-{WEIGHT} preference for accessible merchants scores the "
        f"{len(yes)} accessible ones at {liked:.4f} and the {len(no)} inaccessible ones at "
        f"{avoided:.4f} - the weak preference has become evidence against the thing the "
        f"user asked for")
