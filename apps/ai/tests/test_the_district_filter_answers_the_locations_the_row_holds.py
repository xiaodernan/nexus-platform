"""The district filter was read by one lane, and by nobody on the offering plane.

§7.1: the filter is hard. The merchant SELECT asks whether the merchant HAS a location in the
district (`search/sql.py:228-231`, an EXISTS over `locations`); the fixture lane compared ONE
string on the row (`search/service.py:270`); the offering SELECT carried no district clause at
all. Measured on the published plane, same plan against both lanes (`tmp/d656_district2.py`):

    plan                        fixture (before)   live (before)   live (after)   fixture (after)
    merchants, district Sha Tin   0                194             194            194
    merchants, district Tai Wai   0                137             137            137
    offerings, district Sha Tin   0                4,707           1,941          1,941
    offerings, district Tai Wai   0                4,707           1,357          1,357

The fixture lane answered NOTHING because the row it is handed is the live projection, whose
`district` column is NULL unless a lat/lng was asked for (`geo_select`), and the live offering
plane answered EVERYTHING because the clause was never written. Both holes are one property: the
row did not publish the set the clause tests, so neither lane could answer the question.

The repair publishes that set: `districts` on both projections (`sql.py:211-221`, computed only
when a district is asked, the same economy as `category_slugs`), the offering SELECT gains the
merchant's own EXISTS (`:487-494`), and the mirror reads the set - falling back to the single
`district` string, which is what the demo rows state (`api/demo_data.py:99`).
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "id": key,
           "display_name": key, "display_name_zh": key, "category_primary": "restaurant",
           "avg_price_hkd": 100.0, "rating_agg": 4.2, "review_count": 10,
           "tags": ["restaurant"], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


ROWS = [
    _row("shatin", districts=["sha tin"]),
    _row("both", districts=["sha tin", "tai wai"]),
    _row("string", district="Sha Tin"),          # a demo row states one string and no set
    _row("nowhere"),
]


def _answer(rows, filters, *, offerings=(), subject_types=("merchant",)):
    import asyncio

    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


@pytest.mark.parametrize("district,kept", [
    ("Sha Tin", ["both", "shatin", "string"]),
    ("sha tin", ["both", "shatin", "string"]),     # the clause lowercases both sides
    ("Tai Wai", ["both"]),                         # the second location answers too
    ("Kwun Tong", []),
])
def test_a_fixture_row_answers_with_every_district_it_lists(district, kept):
    got, total = _answer(ROWS, {"district": district})
    assert got == sorted(kept), (district, got)
    assert total == len(kept), (district, total)


def test_the_offering_plane_is_filtered_by_its_merchants_districts():
    offerings = [
        {"subject_id": "o1", "merchant_id": "m1", "id": "o1", "kind": "service",
         "name": "One", "name_zh": "一", "price_amount": 10.0, "category": "restaurant",
         "subject_type": "offering", "districts": ["sha tin"]},
        {"subject_id": "o2", "merchant_id": "m2", "id": "o2", "kind": "service",
         "name": "Two", "name_zh": "二", "price_amount": 20.0, "category": "restaurant",
         "subject_type": "offering", "districts": ["tai wai"]},
    ]
    got, _total = _answer([], {"district": "Sha Tin"}, offerings=offerings,
                          subject_types=("offering",))
    assert got == ["o1"], got


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

    DISTRICTS = """coalesce((SELECT array_agg(DISTINCT lower(coalesce(ld2.district, '')))
                                FROM locations ld2 WHERE ld2.merchant_id = {ref}), '{{}}'::text[])"""

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            merchants = [dict(r) for r in await db.fetch(f"""
                select m.id::text as subject_id, m.id::text as merchant_id,
                       m.display_name, m.display_name_zh, m.description, m.category_primary,
                       m.avg_price_hkd, m.rating_agg, m.review_count, m.popularity_score,
                       m.tags, m.attributes, m.data_origin, m.images, m.plan, m.ai_agent_enabled,
                       {DISTRICTS.format(ref='m.id')} as districts
                from public.merchants m where m.status = 'published'""")]
            offerings = [dict(r) for r in await db.fetch(f"""
                select o.id::text as subject_id, o.id::text as id, o.merchant_id::text as merchant_id,
                       o.kind, o.name, o.name_zh, o.price_amount, o.price_min, o.price_max,
                       o.rating_agg, o.attributes, m.tags, m.category_primary as category,
                       'offering'::text as subject_type,
                       {DISTRICTS.format(ref='o.merchant_id')} as districts
                from public.offerings o join public.merchants m on m.id = o.merchant_id
                where o.tenant_id = $1::uuid and o.status = 'active' and m.status = 'published'""",
                str(S.DEFAULT_TENANT_ID))]
            multi = await db.fetchrow("""
                select m.id::text as id, array_agg(DISTINCT lower(coalesce(ld.district, ''))) as ds
                from public.merchants m join public.locations ld on ld.merchant_id = m.id
                where m.status = 'published'
                group by m.id having count(DISTINCT lower(coalesce(ld.district, ''))) > 1
                order by m.id limit 1""")
            out = {"merchants": len(merchants), "offerings": len(offerings), "pools": []}
            for sts, rows, offs in (("merchant", merchants, ()), ("offering", (), offerings)):
                for district in ("Sha Tin", "Tai Wai"):
                    pool = {}
                    for name, backend in (("fixture", S.StaticBackend(merchants=rows, offerings=offs)),
                                          ("live", Deps(st).backend())):
                        plan = S.SearchPlan(query_text="", filters={"district": district},
                                            limit=10, subject_types=(sts,))
                        _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                        pool[name] = getattr(resp, "total_estimate", None)
                    out["pools"].append((sts, district, pool))
            if multi:
                mid, ds = multi["id"], sorted(multi["ds"])
                row = next(r for r in merchants if r["subject_id"] == mid)
                both = {}
                for district in ds:
                    for name, backend in (("fixture", S.StaticBackend(merchants=[row])),
                                          ("live", Deps(st).backend())):
                        plan = S.SearchPlan(query_text="",
                                            filters={"district": district, "merchant_id": mid},
                                            limit=10, subject_types=("merchant",))
                        _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                        both[f"{name}:{district}"] = getattr(resp, "total_estimate", None)
                out["multi"] = {"id": mid, "districts": ds, "answers": both, "row": row}
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("index", range(4))
def test_the_two_lanes_keep_the_same_district_population(plane, index):
    sts, district, pools = plane["pools"][index]
    assert pools["fixture"] == pools["live"], (sts, district, pools)
    assert 0 < pools["live"] < plane[("offerings" if sts == "offering" else "merchants")], (
        sts, district, pools)


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_merchant_in_two_districts_answers_both_on_both_lanes(plane):
    multi = plane.get("multi")
    assert multi, "the published plane has no merchant with two districts"
    assert len(multi["districts"]) >= 2, multi["districts"]
    for district in multi["districts"]:
        got_f = multi["answers"][f"fixture:{district}"]
        got_l = multi["answers"][f"live:{district}"]
        assert got_f == 1 and got_l == 1, (district, multi["answers"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_built_queries_publish_the_set_they_filter_on(plane):
    # The gate's own row lists compute `districts` by hand, so they cannot prove the SERVICE's
    # projection publishes it. These are the real builders, run on the real plane.
    import asyncio

    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.search import sql as SQL

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            out = {}
            for name, build, extra in (("merchant", SQL.build_merchant_query, {"embedding": None}),
                                       ("offering", SQL.build_offering_query, {})):
                query = build(tenant_id=str(S.DEFAULT_TENANT_ID), text=None,
                              filters={"district": "Sha Tin"}, limit=10, **extra)
                rows = [dict(r) for r in await db.fetch(query.sql, *query.params)]
                out[name] = (len(rows), [r.get("districts") for r in rows[:5]])
            return out
        finally:
            await db_pool.dispose()

    out = asyncio.run(_go())
    for name in ("merchant", "offering"):
        count, sample = out[name]
        assert count > 0, (name, count)
        assert all(d for d in sample), (name, sample)
        assert all("sha tin" in d for d in sample), (name, sample)
