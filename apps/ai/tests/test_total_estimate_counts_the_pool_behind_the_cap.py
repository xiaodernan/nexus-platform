"""D599 - `total_estimate` could never exceed the candidate cap, so a root answered "150".

The search path fetches candidates with `limit=max(60, plan.limit * 3)` and reported
`total_estimate=len(ranked)`. Any population larger than that cap was therefore answered with
the cap: naming the `restaurant` root (184 published merchants) told the caller 150, and the
unfiltered catalogue (470) told them 150. `docs/API_CONTRACT.md` §2 names the field
`total_estimate` and the live category door already asserts it equals the taxonomy's own count
for leaves and roots - true only while the population fits under 60 x 3.

The fix is one round trip, not a second query: each candidate SELECT can carry
`count(*) OVER () AS pool_total`, a window taken over the rows the WHERE matches BEFORE the
ORDER BY / LIMIT. Measured on the seeded plane (2026-10-29) the window answers cafe **79**,
restaurant **184** and the unfiltered catalogue **470**, and the unfiltered query cost 22.4 ms
with the column against 234.1 ms without it (first run, cold). The service asks for it with
`with_total=True`, sums the lanes it actually queried, and reports
`max(len(ranked), pool_total)`: the page still answers `len(ranked)` when the pool was smaller,
so nothing that was already right shrinks.

What this does NOT change: ranking still drops weak text matches below the relevance floor
after the page is fetched, so a text query's total is the size of the MATCHING POOL, not of the
survivors. That is the honest reading of "how many results exist"; the card list remains ranked
and floored.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.search.sql import build_merchant_query, build_offering_query

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TENANT = S.DEFAULT_TENANT_ID

MERCHANTS = [
    {"id": "m1", "slug": "a", "display_name": "A", "display_name_zh": "", "district": "Central",
     "category_primary": "cafe", "tags": ["cafe"], "avg_price_hkd": 40, "attributes": {}},
    {"id": "m2", "slug": "b", "display_name": "B", "display_name_zh": "", "district": "Central",
     "category_primary": "cafe", "tags": ["cafe"], "avg_price_hkd": 50, "attributes": {}},
    {"id": "m3", "slug": "c", "display_name": "C", "display_name_zh": "", "district": "Central",
     "category_primary": "cafe", "tags": ["cafe"], "avg_price_hkd": 60, "attributes": {}},
]


def test_the_window_column_is_opt_in_on_both_lanes():
    merchant = build_merchant_query(tenant_id=TENANT, text=None, embedding=None, with_total=True)
    assert "count(*) OVER () AS pool_total" in merchant.sql
    assert "count(*) OVER ()" not in build_merchant_query(
        tenant_id=TENANT, text=None, embedding=None).sql, (
        "every merchant query pays for the window - compare and recommend do not need it")
    offering = build_offering_query(tenant_id=TENANT, text=None, with_total=True)
    assert "count(*) OVER () AS pool_total" in offering.sql
    assert "count(*) OVER ()" not in build_offering_query(tenant_id=TENANT, text=None).sql


def test_a_row_without_the_column_speaks_for_its_own_lane():
    assert S._pool_total([{"pool_total": 184}]) == 184
    assert S._pool_total([{"id": "x"}, {"id": "y"}]) == 2, (
        "a backend that answers no window column must keep its own row count")
    assert S._pool_total([]) == 0


async def test_a_fixture_page_keeps_its_own_total():
    plan = S.SearchPlan(limit=1)
    cards, resp, _, _ = await S.search(backend=S.StaticBackend(merchants=MERCHANTS), plan=plan)
    assert len(cards) == 1
    assert resp.total_estimate == 3, (
        "the fixture backend answered 3 rows and the response reported fewer than the match")


live = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    common = dict(tenant_id=TENANT, text=None, geo=None, radius_m=None, limit=150)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            b = S.PostgresBackend(db)
            out = {}
            for name, flt in (("all", None), ("cafe", {"category": "cafe"}),
                              ("restaurant", {"category": "restaurant"}),
                              ("bar", {"category": "bar"})):
                rows = await b.merchant_candidates(
                    **dict(common, embedding=None, filters=flt, with_total=True))
                out[name] = (len(rows), int(rows[0]["pool_total"]) if rows else 0)
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live
def test_the_pool_is_bigger_than_the_capped_page(plane):
    capped, pool = plane["restaurant"]
    assert capped == 150, f"the page is not capped at 150: {capped}"
    assert pool == 184, (
        f"the restaurant root holds 184 merchants and the window answered {pool} - "
        f"total_estimate would still report the cap")
    assert plane["bar"][0] == plane["bar"][1], (
        "a population under the cap must answer the same number both ways")


@live
def test_an_uncapped_plane_answers_its_whole_catalogue(plane):
    capped, pool = plane["all"]
    assert pool == 470, pool
    assert capped <= 150, capped


live_search = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


def _search(settings, **body):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/search", json={"query": "", "limit": 2, **body})
        assert r.status_code == 200, r.text
        return r.json()


@live_search
def test_the_response_reports_the_pool_not_the_page():
    from nexus_ai.config import Settings

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    body = _search(st, filters={"category": "restaurant"})
    assert len(body["items"]) == 2, [i.get("title") for i in body["items"]]
    assert body["total_estimate"] == 184, (
        f"two cards were asked for and the corpus holds 184 restaurants; the response said "
        f"{body['total_estimate']}")
    rootless = _search(st)
    assert rootless["total_estimate"] == 470, rootless["total_estimate"]
