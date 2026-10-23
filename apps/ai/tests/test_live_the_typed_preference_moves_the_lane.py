"""The live-DB proof that a preference typed in THIS query moves the lane (D530).

`time_pref/open_late` is the one row in the lexicon's `PREFERENCE_RULES` whose attribute
is not spelled `{value}_{kind}` or `{kind}_{value}`. The intent path derived
`open_late_time_pref` and `time_pref_open_late`; the seed, the stored branch and the
corpus all spell it `opens_late`. Measured on this database before the fix:

    the corpus splits 266 merchants that open late / 204 that do not
    a typed late-night request changed 0 of 470 merchants' personalization

The user typed a preference, the corpus carried the fact, and the lane did not move -
with nothing on any surface saying so. This asks the live plane the same question the
offline gates ask, through the ranker itself. It needs the demo seed
(`NEXUS_TEST_DATABASE_URL`) and skips cleanly without it.

"""

from __future__ import annotations

import asyncio
import os

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: the query, taken from the lexicon's own row for `time_pref/open_late`
QUERY = "想搵夜宵"


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _run(live_settings, intent_prefs):
    """(the merchants the corpus calls late, the ones it does not), each with its score."""
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
                backend=Every(db), plan=plan, intent_preferences=intent_prefs)
            late, early = [], []
            for sc in scored:
                attrs = (sc.candidate.raw.get("row") or {}).get("attributes") or {}
                if attrs.get("opens_late") is True:
                    late.append(sc.candidate.personalization)
                elif attrs.get("opens_late") is False:
                    early.append(sc.candidate.personalization)
            return late, early
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_corpus_carries_the_attribute_on_both_sides(live_settings):
    """A gate measured over one side only proves nothing."""
    late, early = _run(live_settings, None)
    assert late and early, (
        f"the corpus split into {len(late)} merchants that open late and {len(early)} "
        f"that do not - one side is empty, so this database cannot measure the preference")


def test_a_typed_late_night_request_moves_the_lane(live_settings):
    """The measurement that names the unit: 0 of 470 merchants moved before the fix."""
    from nexus_ai.nlu.understand import extract_intent

    ex = extract_intent(QUERY, {"locale": "zh-HK"})
    prefs = [p if isinstance(p, dict) else p.model_dump() for p in ex.preferences]
    assert prefs, f"{QUERY!r} resolved no preference - the fixture is not what it claims"
    late, early = _run(live_settings, prefs)
    assert late and early, "the corpus does not split on the attribute - see the other check"
    assert all(v == 1.0 for v in late), (
        f"the {len(late)} merchants the corpus calls late scored {sorted(set(late))} - a "
        f"user who typed {QUERY!r} was not served the merchants that stay open")
    assert all(v == 0.0 for v in early), (
        f"the {len(early)} merchants that close early scored {sorted(set(early))} - the "
        f"refusal half of the preference never reached them")


def test_the_lane_is_not_flat(live_settings):
    """Before the fix every merchant on this corpus answered None: one value, no order."""
    from nexus_ai.nlu.understand import extract_intent

    ex = extract_intent(QUERY, {"locale": "zh-HK"})
    prefs = [p if isinstance(p, dict) else p.model_dump() for p in ex.preferences]
    late, early = _run(live_settings, prefs)
    assert late and early, "the corpus does not split on the attribute - see the other check"
    assert sorted(set(late)) != sorted(set(early)), (
        f"both halves scored {sorted(set(late))} - the lane is flat, so it contributes "
        f"nothing to the order the user is served in")
