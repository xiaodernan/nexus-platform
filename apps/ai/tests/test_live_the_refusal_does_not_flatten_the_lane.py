"""The live-DB proof that a refusal typed in this query no longer flattens the lane (D529).

The transient path answered a cuisine preference it could not match with the side of
neutral the user was NOT on: a LIKE got 0.5 and a DISLIKE got 1.0, the maximum. Because
the aggregation across preferences is a maximum (D397), one typed refusal erased every
other preference the user had - measured on this corpus, a declared `quiet` at 0.9 plus
a typed refusal of Japanese left all 442 non-Japanese merchants at 1.0, the 188 quiet ones
and the 282 loud ones alike. The personalization lane carried one value, so it could not
order anything.

This reads the real published rows out of the database, splits them the way the corpus
actually writes them, and runs the ranker over each half with a declared preference and
the refusal the user typed. It needs the demo seed (`NEXUS_TEST_DATABASE_URL`) and skips
cleanly without it."""

from __future__ import annotations

import asyncio
import json
import os
import statistics

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: what the user declared, at the seed's own strength for `style/ambience`.
STORED = [{"user_id": "u1", "kind": "style", "key": "ambience",
           "value": json.dumps({"value": "quiet"}), "weight": 0.9,
           "source": "declared", "scope": "long_term"}]

#: the cuisine the user refuses in THIS turn. The value is the NLU's own key, not a word
#: typed here (D409).
REFUSED_CUISINE = "japanese"


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _halves(live_settings) -> tuple[list[dict], list[dict]]:
    """(the published merchants the corpus calls quiet, the ones it calls loud)."""
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class Every(S.PostgresBackend):
        async def merchant_candidates(self, **kw):
            return await self.db.readonly(
                "select * from merchants where status = 'published' order by slug")

        async def user_preferences(self, user_id, kinds=None):
            return [dict(p) for p in STORED]

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


def _mean(live_settings, rows, intent_prefs) -> float:
    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class Fixed(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

        async def user_preferences(self, user_id, kinds=None):
            return [dict(p) for p in STORED]

    async def _go():
        await db_pool.connect(live_settings, force_new=True)
        try:
            plan = S.SearchPlan(query_text="", limit=1000)
            _cards, _resp, _bundle, scored = await S.search(
                backend=Fixed(merchants=rows), plan=plan, user_id="u1",
                intent_preferences=intent_prefs)
            values = [sc.candidate.personalization for sc in scored
                      if sc.candidate.personalization is not None]
            return statistics.mean(values) if values else float("nan")
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_corpus_splits_on_both_sides(live_settings):
    """A gate measured over one side only proves nothing."""
    quiet, loud = _halves(live_settings)
    assert quiet and loud, (
        f"the corpus split into {len(quiet)} quiet and {len(loud)} loud merchants - one "
        f"side is empty, so this database cannot measure the preference")


def test_a_refusal_does_not_lift_the_half_the_user_did_not_name(live_settings):
    """The measurement that names the unit."""
    quiet, loud = _halves(live_settings)
    assert quiet and loud, "the corpus does not split on the attribute - see the other check"
    refusal = [{"key": "cuisine", "value": REFUSED_CUISINE, "polarity": -1}]
    quiet_mean = _mean(live_settings, quiet, refusal)
    loud_mean = _mean(live_settings, loud, refusal)
    assert quiet_mean > loud_mean, (
        f"a refusal of {REFUSED_CUISINE} scores the {len(quiet)} quiet merchants at "
        f"{quiet_mean:.4f} and the {len(loud)} loud ones at {loud_mean:.4f} - the refusal "
        f"has become evidence FOR everything else at full strength and the lane is flat")


def test_a_refusal_does_not_lift_the_half_above_what_the_user_declared(live_settings):
    """The declared preference still answers for the half it names."""
    quiet, loud = _halves(live_settings)
    assert quiet and loud, "the corpus does not split on the attribute - see the other check"
    refusal = [{"key": "cuisine", "value": REFUSED_CUISINE, "polarity": -1}]
    q = _mean(live_settings, quiet, refusal)
    assert q == 0.9, (
        f"the user declared quiet at 0.9 and the turn left the quiet merchants at "
        f"{q:.4f} - the typed refusal overwrote what they declared")


def test_the_lane_is_not_flat(live_settings):
    """A lane that carries one value cannot order anything."""
    quiet, loud = _halves(live_settings)
    assert quiet and loud, "the corpus does not split on the attribute - see the other check"
    refusal = [{"key": "cuisine", "value": REFUSED_CUISINE, "polarity": -1}]
    values = {round(_mean(live_settings, rows, refusal), 6) for rows in (quiet, loud)}
    assert len(values) > 1, (
        f"every merchant on this corpus answers {values} - the personalization lane is "
        f"flat, so it contributes nothing to the order the user is served in")
