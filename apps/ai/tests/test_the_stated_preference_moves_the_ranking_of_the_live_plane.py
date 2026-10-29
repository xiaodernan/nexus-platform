"""Does a preference the user STATES in this query move the rows that carry it?

D600 measures whether the answer is the KIND of place named. This door measures the other half:
when the sentence says 安靜 / 有戶外座位 / 有停車場 / 近地鐵, are the rows that record that fact
lifted to the top? The metric is LIFT - the share of the top ten carrying the attribute divided by
the share of the whole filtered population carrying it. Lift 1.0 means the ranking did nothing;
below 1.0 means it did worse than a random page.

**This door used to answer a lane the request path never uses.** Its first version called
``S.search(backend=..., plan=plan)`` and never handed in ``intent_preferences`` - the parameter the
production pipeline fills from the query's Intent (``api/pipeline.py:192-197``). Measured on the
seeded plane 2026-10-30, the preference lane's own score was **0.5 (neutral) on every row of every
case**, so the numbers it published were the DEFAULT ordering's base-rate correlation with the fact,
not the effect of the preference the user stated. Three of its "findings" were therefore false:
that the access preferences do not lift (parking lifts to 2.89 in production), that outdoor is
anti-correlated (1.75), and that MTR barely moves (3.01). Every number below is read through
``api.pipeline.run_search`` - the function the routes call - so the preference is in the ranking by
construction, and the leg that looks for it reddens if it stops arriving.

Measured on the seeded plane 2026-10-30 (470 published merchants, 2,118 chunks embedded, strategy
`hybrid_v1+postgres+vector`):

    query               attribute            population   base   top10   lift
    安靜的咖啡店        quiet_ambience       79 cafes     0.43   1.00    2.32
    可以帶寵物的餐廳    pet_friendly_access  184 rest.    0.22   0.90    4.04
    適合情侶約會的地方  date_occasion        184 rest.    1.00   1.00    1.00  (vacuous)
    有戶外座位的餐廳    outdoor_seating      184 rest.    0.23   0.80    3.50
    有停車場的餐廳      parking_access       184 rest.    0.28   0.80    2.89
    近地鐵站的餐廳      mtr_near_access      184 rest.    0.30   0.90    3.01

The date case is still vacuous: every one of the 184 restaurants records ``date_occasion: true``,
so no ordering can demonstrate that preference - the row asserts the corpus constant instead of
claiming a win, and it will tell the next reader the day it stops being true.

The floors are set below the measured values rather than at them: a re-seed that moves a percentage
point must not redden a door that is here to notice a lane going silent, and the lanes below lift 2
have room to move without being called fixed.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

CASES = [
    ("安靜的咖啡店", "quiet_ambience"),
    ("可以帶寵物的餐廳", "pet_friendly_access"),
    ("適合情侶約會的地方", "date_occasion"),
    ("有戶外座位的餐廳", "outdoor_seating"),
    ("有停車場的餐廳", "parking_access"),
    ("近地鐵站的餐廳", "mtr_near_access"),
]

#: query -> the lift the production path must keep. Measured 2.32 / 4.04 / 3.50 / 2.89 / 3.01
#: (outdoor was 1.75 before D621 taught the reader both spellings of the fact).
WORKING = {
    "安靜的咖啡店": 1.8,
    "可以帶寵物的餐廳": 2.5,
    "有戶外座位的餐廳": 2.5,
    "有停車場的餐廳": 2.0,
    "近地鐵站的餐廳": 2.0,
}
VACUOUS = "適合情侶約會的地方"
TOP_K = 10
#: a row the preference fired on scores its liking side; the lane's neutral is 0.5 (ranking.py:147).
FIRED = 0.9


def _true(row, attr):
    return (row.get("attributes") or {}).get(attr) is True


def _fired(scored) -> float:
    """Share of the top ten whose personalization score left neutral - i.e. the preference fired."""
    rows = scored[:TOP_K]
    if not rows:
        return 0.0
    return sum(1 for s in rows if float(s.breakdown.get("personalization", 0.5)) >= FIRED) / len(rows)


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search, validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent_dict

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            deps = Deps(st)
            out = {}
            for query, attr in CASES:
                intent = validate_intent(extract_intent_dict(query))
                intent_prefs = [p.model_dump() for p in intent.preferences]
                plan = S.plan_from_intent(intent, query=query, limit=TOP_K)
                population = await backend.merchant_candidates(
                    tenant_id=S.DEFAULT_TENANT_ID, text=None, embedding=None,
                    filters=plan.filters, geo=None, radius_m=None, limit=100000)
                pack = await run_search(deps, intent, query=query, limit=TOP_K)
                rows = [s.candidate.raw["row"] for s in pack.scored[:TOP_K]]
                base = sum(1 for r in population if _true(r, attr)) / len(population)
                share = sum(1 for r in rows if _true(r, attr)) / len(rows)
                # The same plan through the call this door USED to make: no intent_preferences.
                _c, _r, _b, bare = await S.search(backend=backend, plan=plan)
                # The preference WITHOUT the vector lane - the pair this door compares so that a
                # lane which reorders against a stated preference has to say so here (D623).
                _c2, _r2, _b2, pref_only = await S.search(
                    backend=backend, plan=plan, intent_preferences=intent_prefs)
                share_pref = (sum(1 for s in pref_only[:TOP_K]
                                  if _true(s.candidate.raw["row"], attr)) / TOP_K)
                out[query] = {"base": base, "share": share, "share_pref": share_pref,
                              "lift": (share / base) if base else 0.0,
                              "population": len(population),
                              "filters": dict(plan.filters or {}),
                              "fired": _fired(pack.scored),
                              "bare_fired": _fired(bare),
                              "strategy": pack.response.strategy}
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("query", sorted(WORKING))
def test_the_preference_lifts_the_rows_that_carry_it(plane, query):
    got = plane[query]
    assert got["lift"] >= WORKING[query], (
        f"{query}: lift fell to {got['lift']:.2f} (top10 {got['share']:.2f} of a {got['base']:.2f} "
        f"population, filters {got['filters']}, strategy {got['strategy']}) - the stated "
        f"preference stopped moving the ranking, or the harness stopped handing it in")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("query", sorted(WORKING))
def test_the_preference_actually_reached_the_ranking(plane, query):
    """The witness that separates this harness from the one that published §599's table.

    ``run_search`` fills ``intent_preferences``; ``S.search`` called directly does not. The lane's
    neutral score is 0.5, so "no preference in the ranking" is a measurable state, not a suspicion.
    """
    got = plane[query]
    # Measured 2026-10-30, in the order of WORKING: 1.00 / 0.90 / 0.70 / 0.80 / 0.90 - outdoor's
    # three neutral rows are the merchants whose record states neither `outdoor_seating: true` nor
    # `: false`, and a fact the corpus does not state cannot be liked or disliked (`_sided` is not
    # reached). `tmp/d620_fired.txt` is the reading.
    assert got["fired"] >= 0.6, (
        f"{query}: only {got['fired']:.0%} of the top ten carry a fired preference score - the "
        f"preference never reached the ranking (strategy {got['strategy']})")
    assert got["bare_fired"] == 0.0, (
        f"{query}: {got['bare_fired']:.0%} of the preferenceless lane's top ten now carry a fired "
        "score - the two calls are no longer distinguishable, so this door's contrast (and the "
        "correction it records) needs re-reading")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_date_case_cannot_demonstrate_anything_on_this_corpus(plane):
    got = plane[VACUOUS]
    assert got["base"] == 1.0 and got["share"] == 1.0, (
        f"the corpus no longer records date_occasion on every restaurant (base {got['base']:.2f}, "
        f"top10 {got['share']:.2f}) - this case can now be a real test of the occasion "
        f"preference, and the door should say so")

@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("query", sorted(WORKING))
def test_the_vector_lane_does_not_outrank_the_stated_preference(plane, query):
    """D623: the same preference with and without the vector lane, one row of ten apart at most.

    Measured 2026-10-30 (`tmp/d623_pairs.txt`), preference-only against the production page:

        attribute            pref only   production   rows lost
        quiet_ambience        1.00        1.00         0
        pet_friendly_access   0.90        0.90         0
        date_occasion         1.00        1.00         0   (vacuous either way)
        outdoor_seating       0.80        0.80         0
        parking_access        0.90        0.80         1
        mtr_near_access       1.00        0.90         1

    The vector lane never helps a stated preference on this plane and costs one row of ten in two
    of six sentences. That is the honest size of the trade: `infra/config/ranking_weights.yaml`
    gives personalization 0.06 of the score and relevance 0.34, so a fired preference can swing a
    row by at most 0.03 while the fused keyword/vector term swings it by more than ten times that.
    A lane that can reorder a page against what the user asked for is worth a bound, not a
    paragraph - and the bound is one row ABOVE the measurement, so a re-seed that moves a single
    row does not redden this door while a lane that costs two rows of ten is called out here.
    """
    got = plane[query]
    lost = got["share_pref"] - got["share"]
    assert lost <= 0.2 + 1e-9, (
        f"{query}: the vector lane cost the preference {lost:.2f} of the top ten "
        f"({got['share_pref']:.2f} without it, {got['share']:.2f} with it, strategy "
        f"{got['strategy']}) - measured 2026-10-30 was 0.10 at the widest (two sentences), so "
        "two rows of ten means the lane is outranking the user's own sentence")
