"""The radius the request names was read by one lane, and the fixture lane read no distance.

`build_merchant_query` filters a geo request with a bbox prefilter plus a haversine on the nearest
location inside it, and drops a row with no location at all (`search/sql.py:291-320`);
`build_offering_query` does the same on its own join (`:553-580`). `_filter_static` read nothing, so
the same plan answered two different pools. Measured on the published plane (`tmp/d660_both.py`):

    plan                          fixture (before)   live    after (both)
    merchants,  1,000 m            470 of 470        0      0
    merchants,  2,000 m            470               21     21
    merchants,  5,000 m            470               95     95
    offerings,  2,000 m            4,707             233    233
    offerings,  5,000 m            4,707             970    970

470 and 4,707 are the whole planes: the degraded lane answered "everything near" for every radius.
The repair publishes the row's own POINTS (`location_points`, a jsonb array, only when a geo lane was
asked - `sql.py:182-198` for the merchant SELECT and the same helper for the offering one) and the
fixture lane measures with `sql.haversine_m`, the Python function `haversine_expr` already mirrors in
SQL - one formula, not two. The live lane takes the nearest point INSIDE the bbox the radius implies;
a bbox is a superset of its own disc, so the nearest over all of a row's points answers the same
question.

`meters` is written onto the surviving row when a radius was asked, because the live projection
carries it and the card prints it. The nearest location's DISTRICT / MTR fields are NOT filled that
way: the fixture row keeps the district it was handed (`api/demo_data.py:99`), and the geo lane's
display fields remain the live lane's own (`D608`/`D609`).
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.search.sql import haversine_m

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: A real point in Sha Tin, and offsets that are unambiguously inside/outside each radius.
LAT, LNG = 22.3820, 114.1880
NORTH = (LAT + 0.009, LNG)          # ~1,000 m north


def _row(key, points=None, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    if points is not None:
        row["location_points"] = [{"lat": lat, "lng": lng} for lat, lng in points]
    row.update(over)
    return row


ROWS = [
    _row("here", [(LAT, LNG)]),
    _row("north", [NORTH]),
    _row("both", [(LAT + 0.05, LNG), (LAT, LNG)]),      # the nearest one is the one 0 m away
    _row("nowhere", []),
]


def _answer(rows, *, geo=None, radius_m=None, offerings=(), subject_types=("merchant",)):
    import asyncio

    plan = S.SearchPlan(query_text="", filters={}, limit=10, geo=geo, radius_m=radius_m,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


def test_without_a_radius_every_row_answers():
    got, total = _answer(ROWS)
    assert got == ["both", "here", "north", "nowhere"], got
    assert total == 4


def test_a_radius_keeps_the_rows_inside_it():
    got, total = _answer(ROWS, geo=(LAT, LNG), radius_m=500)
    assert got == ["both", "here"], got
    assert total == 2
    got, _total = _answer(ROWS, geo=(LAT, LNG), radius_m=1500)
    assert sorted(got) == ["both", "here", "north"], got


def test_the_nearest_of_several_locations_is_the_one_measured():
    row = _row("two", [(LAT + 0.05, LNG), (LAT, LNG)])
    got, _total = _answer([row], geo=(LAT, LNG), radius_m=500)
    assert got == ["two"], got          # the 5 km branch is outside; the 0 m one is inside


def test_a_row_with_no_location_is_dropped_by_a_radius_and_kept_without_one():
    got, _total = _answer([_row("nowhere", [])], geo=(LAT, LNG), radius_m=50000)
    assert got == [], got
    got, _total = _answer([_row("nowhere", [])])
    assert got == ["nowhere"], got


def test_the_offering_answers_the_distance_of_its_shop():
    offerings = [
        {"subject_id": "o1", "merchant_id": "here", "id": "o1", "kind": "service", "name": "One",
         "name_zh": "一", "price_amount": 10.0, "category": "cafe", "subject_type": "offering",
         "location_points": [{"lat": LAT, "lng": LNG}]},
        {"subject_id": "o2", "merchant_id": "north", "id": "o2", "kind": "service", "name": "Two",
         "name_zh": "二", "price_amount": 20.0, "category": "cafe", "subject_type": "offering",
         "location_points": [{"lat": NORTH[0], "lng": NORTH[1]}]},
    ]
    got, _total = _answer([], geo=(LAT, LNG), radius_m=500, offerings=offerings,
                          subject_types=("offering",))
    assert got == ["o1"], got


def test_the_distance_is_written_onto_the_row_the_card_prints():
    import asyncio

    plan = S.SearchPlan(query_text="", filters={}, limit=10, geo=(LAT, LNG), radius_m=5000)
    backend = S.StaticBackend(merchants=[_row("north", [NORTH])])
    _cards, _resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    assert [s.candidate.subject_id for s in scored] == ["north"]
    expected = haversine_m(LAT, LNG, NORTH[0], NORTH[1])
    assert 900 < expected < 1100, expected      # the fixture's own coordinate arithmetic
    # The backend copies each row, so the value is read where the candidate keeps it: the live
    # lane's `meters` column lands on `Candidate.distance_m` (`service.py:1098`).
    metres = scored[0].candidate.distance_m
    assert metres is not None, scored[0].candidate
    assert abs(float(metres) - expected) < 1e-6, metres


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

    POINTS = """coalesce((SELECT jsonb_agg(jsonb_build_object('lat', l3.lat, 'lng', l3.lng))
                             FROM locations l3 WHERE l3.merchant_id = {ref}
                               AND l3.lat IS NOT NULL AND l3.lng IS NOT NULL), '[]'::jsonb)"""

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            merchants = [dict(r) for r in await db.fetch(f"""
                select m.id::text as subject_id, m.id::text as merchant_id, m.display_name,
                       m.display_name_zh, m.description, m.category_primary, m.avg_price_hkd,
                       m.rating_agg, m.review_count, m.popularity_score, m.tags, m.attributes,
                       m.data_origin, m.images, m.plan, m.ai_agent_enabled,
                       {POINTS.format(ref='m.id')} as location_points,
                       coalesce((SELECT array_agg(DISTINCT s.slug)
                                 FROM merchant_categories mc2
                                 JOIN categories c2 ON c2.id = mc2.category_id
                                 LEFT JOIN categories pc2 ON pc2.id = c2.parent_id
                                 CROSS JOIN LATERAL (VALUES (c2.slug), (pc2.slug)) AS s(slug)
                                 WHERE mc2.merchant_id = m.id AND s.slug IS NOT NULL),
                                '{{}}'::text[]) as category_slugs
                from public.merchants m where m.status = 'published'""")]
            offerings = [dict(r) for r in await db.fetch(f"""
                select o.id::text as subject_id, o.id::text as id, o.merchant_id::text as merchant_id,
                       o.kind, o.name, o.name_zh, o.price_amount, o.price_min, o.price_max,
                       o.rating_agg, o.attributes, m.tags, m.category_primary as category,
                       'offering'::text as subject_type,
                       {POINTS.format(ref='o.merchant_id')} as location_points
                from public.offerings o join public.merchants m on m.id = o.merchant_id
                where o.tenant_id = $1::uuid and o.status = 'active' and m.status = 'published'""",
                str(S.DEFAULT_TENANT_ID))]
            out = {"merchants": len(merchants), "offerings": len(offerings), "pools": []}
            for sts, radius in (("merchant", 1000), ("merchant", 2000), ("merchant", 5000),
                                ("offering", 2000), ("offering", 5000)):
                pool = {}
                for name, backend in (("fixture", S.StaticBackend(
                        merchants=merchants if sts == "merchant" else [],
                        offerings=offerings if sts == "offering" else [])),
                        ("live", Deps(st).backend())):
                    plan = S.SearchPlan(query_text="", filters={}, limit=10,
                                        geo=(LAT, LNG), radius_m=radius, subject_types=(sts,))
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["pools"].append((sts, radius, pool))
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("index", range(5))
def test_the_two_lanes_answer_the_same_radius(plane, index):
    sts, radius, pools = plane["pools"][index]
    assert pools["fixture"] == pools["live"], (sts, radius, pools)
    whole = plane["offerings"] if sts == "offering" else plane["merchants"]
    assert 0 <= pools["live"] < whole, (sts, radius, pools, whole)
