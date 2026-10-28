"""Does a preference the user STATES in this query move the rows that carry it?

D600 measures whether the answer is the kind of place named. This door measures the other half:
when the sentence says 安靜 / 有戶外座位 / 有停車場 / 近地鐵, are the rows that record that fact
lifted to the top? The metric is LIFT - the share of the top ten carrying the attribute, divided
by the share of the whole filtered population carrying it. Lift 1.0 means the ranking did
nothing; below 1.0 means it did worse than a random page.

Measured on the seeded plane 2026-10-29 (470 published merchants, no embeddings):

    query               attribute            population   base   top10   lift
    安靜的咖啡店        quiet_ambience       79 cafes     0.43   0.60    1.39
    適合情侶約會的地方  date_occasion        184 rest.    1.00   1.00    1.00
    可以帶寵物的餐廳    pet_friendly_access  184 rest.    0.22   0.50    2.24
    有戶外座位的餐廳    outdoor_seating      184 rest.    0.23   0.20    0.88
    有停車場的餐廳      parking_access       184 rest.    0.28   0.00    0.00
    近地鐵站的餐廳      mtr_near_access      184 rest.    0.30   0.20    0.67

Three findings, each named rather than smoothed over:

* **Quiet works, and only quiet.** The preference lane feeds `personalization` (weight 0.06),
  so a preference can move a row by at most 0.06 while quality/distance spread wider - and a
  page whose population is 43% quiet can only reach 0.60.
* **The date case is vacuous.** Every one of the 184 restaurants records `date_occasion: true`,
  so no ordering can demonstrate the preference; that is the same corpus-constant shape D594
  fixed for the outdoor fact, and this row records it instead of claiming a win.
* **The access preferences do not lift, and parking is anti-correlated.** `parking_access` is
  true on 28% of restaurants and 0 of the top ten; outdoor and MTR sit at 0.88 and 0.67. The
  row below asserts the measured state so that a fix reddens it and forces this table to move.

The pet row was a MISREAD until D603, not a ranking miss: the plan was `category=pet`, i.e. ten
pet GROOMERS, because the specific-word rule read 寵物 over the head noun 餐廳. D603 made 的/嘅
mark the head (`帶寵物的餐廳` is a restaurant, `寵物美容` is still a pet groomer), and with the
right population the preference lifts 0.22 -> 0.50 (lift 2.24). The table shows the after.
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

#: the two the ranking is expected to answer; the access three are measured, not yet answered.
WORKING = {"安靜的咖啡店": 1.2, "可以帶寵物的餐廳": 1.5}


def _true(row, attr):
    return (row.get("attributes") or {}).get(attr) is True


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent_dict

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            out = {}
            for query, attr in CASES:
                intent = validate_intent(extract_intent_dict(query))
                plan = S.plan_from_intent(intent, query=query, limit=10)
                population = await backend.merchant_candidates(
                    tenant_id=S.DEFAULT_TENANT_ID, text=None, embedding=None,
                    filters=plan.filters, geo=None, radius_m=None, limit=100000)
                _cards, _resp, _bundle, scored = await S.search(backend=backend, plan=plan)
                rows = [s.candidate.raw["row"] for s in scored[:10]]
                base = sum(1 for r in population if _true(r, attr)) / len(population)
                share = sum(1 for r in rows if _true(r, attr)) / len(rows)
                out[query] = {"base": base, "share": share,
                              "lift": (share / base) if base else 0.0,
                              "population": len(population), "filters": dict(plan.filters or {})}
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("query,floor", sorted(WORKING.items()))
def test_the_preference_lifts_the_rows_that_carry_it(plane, query, floor):
    got = plane[query]
    assert got["lift"] >= floor, (
        f"{query}: lift fell to {got['lift']:.2f} (top10 {got['share']:.2f} of a {got['base']:.2f} "
        f"population, filters {got['filters']}) - the stated preference stopped moving the "
        f"ranking")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_date_case_cannot_demonstrate_anything_on_this_corpus(plane):
    got = plane["適合情侶約會的地方"]
    assert got["base"] == 1.0 and got["share"] == 1.0, (
        f"the corpus no longer records date_occasion on every restaurant (base {got['base']:.2f}, "
        f"top10 {got['share']:.2f}) - this case can now be a real test of the occasion "
        f"preference, and the door should say so")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_access_preferences_do_not_yet_lift_the_top_ten(plane):
    """A KNOWN DEFECT, asserted so that a fix reddens this row and moves the table above."""
    measured = {q: round(plane[q]["lift"], 2)
                for q in ("有戶外座位的餐廳", "有停車場的餐廳", "近地鐵站的餐廳")}
    worse = {q: v for q, v in measured.items() if v < 1.0}
    assert len(worse) == 3, (
        f"an access preference now lifts the ranking ({measured}) - update this row and the "
        f"table in the docstring; the defect it records is fixed")
