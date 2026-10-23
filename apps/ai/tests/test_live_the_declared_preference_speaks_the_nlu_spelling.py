"""The live-DB proof that a preference saved in the NLU's own spelling is readable (D531).

The lexicon emits `ambience/quiet` and `ambience/lively` - the words a user actually
types - and the seed's own comment names them. The stored-preference chain had a branch
only for `style/ambience`, whose value is the STRING "quiet", so a preference saved the
way the product spells it answered `personalization = None` for every merchant on this
corpus while the very same fact typed into the query box was read correctly.

This reads the real published rows, splits them on the attribute the corpus actually
writes, and runs the ranker over each half with the preference in the NLU's spelling. It
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

KIND, KEY, WEIGHT = "ambience", "quiet", 0.9


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _halves(live_settings) -> tuple[list[dict], list[dict]]:
    """(the published merchants the corpus calls quiet, the ones it does not)."""
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class Every(S.PostgresBackend):
        async def merchant_candidates(self, **kw):
            return await self.db.readonly(
                "select * from merchants where status = 'published' order by slug")

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            plan = S.SearchPlan(query_text="", limit=1000)
            _cards, _resp, _bundle, scored = await S.search(
                backend=Every(db), plan=plan, user_id="u1")
            quiet, loud = [], []
            for sc in scored:
                attrs = (sc.candidate.raw.get("row") or {}).get("attributes") or {}
                if attrs.get("quiet_ambience") is True:
                    quiet.append(sc.candidate.raw.get("row"))
                elif attrs.get("quiet_ambience") is False:
                    loud.append(sc.candidate.raw.get("row"))
            return quiet, loud
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _mean(live_settings, rows) -> float:
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class Fixed(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

        async def user_preferences(self, user_id, kinds=None):
            return [{"user_id": "u1", "kind": KIND, "key": KEY,
                     "value": json.dumps({"value": True}), "weight": WEIGHT,
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
    quiet, loud = _halves(live_settings)
    assert quiet and loud, (
        f"the corpus split into {len(quiet)} quiet and {len(loud)} loud merchants - one "
        f"side is empty, so this database cannot measure the preference")


def test_a_preference_in_the_nlus_own_spelling_is_read(live_settings):
    """The measurement that names the unit: 0 of 470 merchants answered before the fix."""
    quiet, loud = _halves(live_settings)
    assert quiet and loud, "the corpus does not split on the attribute - see the other check"
    q = _mean(live_settings, quiet)
    loud_mean = _mean(live_settings, loud)
    assert q == WEIGHT, (
        f"a preference stored as ({KIND!r}, {KEY!r}) - the spelling the NLU itself emits - "
        f"left the {len(quiet)} quiet merchants at {q:.4f} on this corpus: the ranker has "
        f"no branch for it and every merchant answers None")
    assert loud_mean < q, (
        f"the {len(loud)} loud merchants scored {loud_mean:.4f} against {q:.4f} for the "
        f"quiet ones - the preference cannot order the two halves")


def test_the_lane_is_not_flat(live_settings):
    """A lane that carries one value cannot order anything."""
    quiet, loud = _halves(live_settings)
    assert quiet and loud, "the corpus does not split on the attribute - see the other check"
    values = {round(_mean(live_settings, rows), 6) for rows in (quiet, loud)}
    assert len(values) > 1, (
        f"every merchant on this corpus answers {values} - the personalization lane is "
        f"flat, so it contributes nothing to the order the user is served in")
