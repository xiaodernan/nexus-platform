"""A row that states its district and no coordinates was deleted by the district's own point.

D637 places a district filter at the district's own coordinates so the live lane can order by
distance (`service.py:922-927`, `DISTRICTS[...]["radius_m"]`), and D660 taught the fixture lane to
apply the radius from the row's own `location_points` (`service.py:367-371`). Together they deleted
every row that states a district but no coordinates: the offline demo catalogue (6 rows, all with a
`district`, none with a lat/lng) answered ZERO items for "sha tin"
(`tests/test_stream.py::test_results_payload_schema_and_cards`), and so would any fixture row list
handed to the lane without geometry.

Measured (`tmp/d663_probe3.py`, `tmp/d663_probe4.py`):

    request                              before   after
    demo catalogue, "sha tin"            0 items  2 items (both in Sha Tin)
    merchant rows with a district only   dropped  kept

The rule the two readers now share: a geo request cuts the rows that STATE a location, and a row
that states no location is dropped ONLY when it states no district either - a row that says "I am in
Sha Tin" already answered the district the geo was derived from, and its `meters` stays unknown. A
row with neither a location nor a district cannot answer a geo request on either lane, and D660's
radius behaviour for rows that do state points is untouched (a leg pins each side).
"""

from __future__ import annotations

import os
from datetime import time as clock

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
LAT, LNG = 22.3809, 114.1861


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _points(metres):
    # ~1 degree of latitude is 111,320 m - the same constant `sql.bbox` uses
    return [{"lat": LAT + metres / 111320.0, "lng": LNG}]


def _answer(rows, filters, *, geo=(LAT, LNG), radius_m=1000):
    import asyncio

    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=("merchant",), geo=geo, radius_m=radius_m)
    backend = S.StaticBackend(merchants=rows)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted((s.candidate.subject_id, s.candidate.distance_m) for s in scored), \
        getattr(resp, "total_estimate", None)


def test_the_offline_catalogue_answers_its_own_district():
    import asyncio

    from nexus_ai.api.demo_data import _merchant_rows, demo_backend
    from nexus_ai.nlu.understand import extract_intent

    plan = S.plan_from_intent(extract_intent("sha tin"), query="sha tin")
    assert plan.filters.get("district") == "Sha Tin", plan.filters
    assert plan.geo is not None, "the district is placed at its own coordinates"
    _cards, resp, _b, scored = asyncio.run(S.search(backend=demo_backend(), plan=plan))
    assert getattr(resp, "total_estimate", None) == 2, resp
    wanted = {str(r["subject_id"]) for r in _merchant_rows() if r.get("district") == "Sha Tin"}
    assert wanted and {s.candidate.subject_id for s in scored} == wanted, (scored, wanted)


def test_a_row_that_states_only_its_district_answers_a_district_request():
    got, total = _answer([_row("a", district="Sha Tin")], {"district": "Sha Tin"})
    assert [key for key, _m in got] == ["a"], got
    assert total == 1, total
    assert got[0][1] is None, "a row with no point has no distance to print"


def test_a_row_with_neither_a_location_nor_a_district_is_dropped():
    got, total = _answer([_row("a", district="Sha Tin"), _row("b")], {"district": "Sha Tin"})
    assert [key for key, _m in got] == ["a"], got
    got, _total = _answer([_row("b")], {})
    assert got == [], got


def test_the_radius_still_cuts_the_rows_that_state_points():
    rows = [_row("near", location_points=_points(300)), _row("far", location_points=_points(6000))]
    got, _total = _answer(rows, {})
    assert [key for key, _m in got] == ["near"], got
    assert 200 < got[0][1] < 400, got


def test_a_far_row_with_a_stated_district_keeps_answering_it():
    # the fixture lane cannot measure what a row does not state; the district it DOES state is the
    # question the request asked, and the live lane has the same district EXISTS for these rows
    rows = [_row("stated", district="Sha Tin")]
    got, _total = _answer(rows, {"district": "Sha Tin"}, radius_m=500)
    assert [key for key, _m in got] == ["stated"], got


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            merchants = [dict(r) for r in await db.fetch("""
                select m.id::text as subject_id, m.id::text as merchant_id, m.display_name,
                       m.display_name_zh, m.description, m.category_primary, m.avg_price_hkd,
                       m.rating_agg, m.review_count, m.popularity_score, m.tags, m.attributes,
                       m.data_origin, m.images, m.plan, m.ai_agent_enabled,
                       coalesce((SELECT array_agg(DISTINCT lower(coalesce(l.district, '')))
                                 FROM locations l WHERE l.merchant_id = m.id),
                                '{}'::text[]) as districts,
                       coalesce((SELECT array_agg(DISTINCT s.slug)
                                 FROM merchant_categories mc2
                                 JOIN categories c2 ON c2.id = mc2.category_id
                                 LEFT JOIN categories pc2 ON pc2.id = c2.parent_id
                                 CROSS JOIN LATERAL (VALUES (c2.slug), (pc2.slug)) AS s(slug)
                                 WHERE mc2.merchant_id = m.id AND s.slug IS NOT NULL),
                                '{}'::text[]) as category_slugs
                from public.merchants m where m.status = 'published'""")]
            out = {"merchants": len(merchants), "pools": {}}
            live = Deps(st).backend()
            for district in ("Sha Tin", "Wan Chai"):
                from nexus_ai.nlu.understand import extract_intent

                plan = S.plan_from_intent(extract_intent(district), query=district)
                pool = {}
                for name, backend in (
                    ("fixture", S.StaticBackend(merchants=merchants)),
                    ("live", live),
                ):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["pools"][district] = pool
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.parametrize("district", ["Sha Tin", "Wan Chai"])
def test_the_two_lanes_still_answer_a_district_the_same_way(plane, district):
    pools = plane["pools"][district]
    assert pools["fixture"] == pools["live"], pools
    assert 0 < pools["live"] < plane["merchants"], (pools, plane["merchants"])
