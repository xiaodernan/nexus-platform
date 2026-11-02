"""The fixture lane read none of the caller's row filters, and answered the whole corpus.

§7.1: the request's filters are hard. The live WHERE reads `min_rating`, `tags` (overlap),
`exclude`, `merchant_id` and the `attributes` containment (`search/sql.py:219-227`); the fixture
mirror read category, district, price, avoid and party and NOTHING else. Measured on the published
plane (`tmp/d655_census.py`), the same plan against both lanes:

    filter                                  fixture (before)   live      fixture (after)
    min_rating 4.6                          470 rows           26        26
    tags ["thai"]                           470 rows            8         8
    exclude [two ids]                       470 rows          468       468
    attributes {"quiet_ambience": true}     470 rows          188       188

470 is the whole published corpus: the degraded path answered a request it never applied. It is the
same shape D549 (avoid) and D607 (party) each closed one filter at a time - this unit closes the row
predicates that need no join, and leaves the hour/geo filters to their own readers.

The `tags` filter had three readers and one of them read it. The merchant SELECT filters `m.tags`
(`sql.py:221`) and the offering SELECT selects `m.tags` into the row (`:583`) without a WHERE clause,
so `tags: [thai]` was answered on the offering plane by 4,707 offerings, none under a thai merchant
(`tmp/d655_tags_offering.py`). The same plan after the clause: 103, every one of them under a merchant
carrying the tag. That clause is in this unit because the fixture mirror cannot be parity with a lane
that ignores the filter - a mirror that copies a missing clause pins the defect.

Each mirror keeps the live clause's own edge: a NULL rating fails a floor (SQL's `>=` on NULL is
NULL), a tag filter passes on ANY overlap (`&&`), and `attributes` is containment of every named
pair, not a match on one of them.
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "restaurant", "avg_price_hkd": 100.0, "rating_agg": 4.0,
           "review_count": 10, "tags": ["restaurant"], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


ROWS = [
    _row("a", rating_agg=4.1, tags=["restaurant", "thai"], attributes={"quiet_ambience": True}),
    _row("b", rating_agg=4.8, tags=["restaurant", "korean"], attributes={"quiet_ambience": False}),
    _row("c", rating_agg=None, tags=["restaurant"], attributes={}),
]


def _answer(rows, filters, *, offerings=None, subject_types=("merchant",)):
    import asyncio

    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings or ())
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


@pytest.mark.parametrize("filters,kept", [
    ({"min_rating": 4.5}, ["b"]),
    ({"min_rating": 0.0}, ["a", "b"]),              # a NULL rating fails a floor, as in SQL
    ({"tags": ["thai"]}, ["a"]),
    ({"tags": ["thai", "korean"]}, ["a", "b"]),      # any overlap passes
    ({"tags": ["ramen"]}, []),
    ({"exclude": ["a", "c"]}, ["b"]),
    ({"merchant_id": "b"}, ["b"]),
    ({"attributes": {"quiet_ambience": True}}, ["a"]),
    ({"attributes": {"quiet_ambience": False}}, ["b"]),
    ({"attributes": {"quiet_ambience": True, "nope": 1}}, []),
])
def test_a_fixture_row_answers_the_callers_filter(filters, kept):
    got, total = _answer(ROWS, filters)
    assert got == sorted(kept), (filters, got)
    assert total == len(kept), (filters, total)


OFFERINGS = [
    {"subject_id": "o1", "merchant_id": "m1", "name": "One", "name_zh": "一", "price_amount": 10.0,
     "category": "restaurant", "kind": "service", "subject_type": "offering",
     "tags": ["restaurant", "thai"], "rating_agg": 4.8, "attributes": {"quiet_ambience": True}},
    {"subject_id": "o2", "merchant_id": "m2", "name": "Two", "name_zh": "二", "price_amount": 20.0,
     "category": "restaurant", "kind": "product", "subject_type": "offering",
     "tags": ["restaurant", "korean"], "rating_agg": 4.1, "attributes": {"quiet_ambience": False}},
]


def test_an_offering_is_filtered_by_its_merchant_and_by_its_own_id():
    got, _total = _answer([], {"merchant_id": "m2"}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o2"], got
    got, _total = _answer([], {"exclude": ["o1"]}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o2"], got


def test_an_offering_answers_the_tag_its_merchant_carries():
    # The tag is the MERCHANT's (`sql.py:583` selects `m.tags`); an offering states none of its own.
    got, _total = _answer([], {"tags": ["thai"]}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o1"], got
    got, _total = _answer([], {"min_rating": 4.5}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o1"], got
    got, _total = _answer([], {"attributes": {"quiet_ambience": True}}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o1"], got


def test_kind_is_the_offering_planes_own_filter():
    # `o.kind` is read by the offering SELECT (`sql.py:448`) and by no merchant clause: a merchant
    # row survives any kind (470 of 470 live, `tmp/d655_kind.py`).
    got, _total = _answer([], {"kind": "service"}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o1"], got
    got, _total = _answer([], {"kind": "product"}, offerings=OFFERINGS,
                          subject_types=("offering",))
    assert got == ["o2"], got
    got, _total = _answer(ROWS, {"kind": "product"}, subject_types=("merchant",))
    assert got == ["a", "b", "c"], got


CASES = [
    {"min_rating": 4.6},
    {"tags": ["thai"]},
    {"attributes": {"quiet_ambience": True}},
]


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
            rows = [dict(r) for r in await db.fetch("""
                select m.id::text as subject_id, m.id::text as merchant_id, m.display_name,
                       m.display_name_zh, m.description, m.category_primary, m.avg_price_hkd,
                       m.rating_agg, m.review_count, m.popularity_score, m.tags, m.attributes,
                       m.data_origin, m.images, m.plan, m.ai_agent_enabled,
                       coalesce((SELECT array_agg(DISTINCT s.slug)
                                 FROM merchant_categories mc2
                                 JOIN categories c2 ON c2.id = mc2.category_id
                                 LEFT JOIN categories pc2 ON pc2.id = c2.parent_id
                                 CROSS JOIN LATERAL (VALUES (c2.slug), (pc2.slug)) AS s(slug)
                                 WHERE mc2.merchant_id = m.id AND s.slug IS NOT NULL),
                                '{}'::text[]) as category_slugs
                from public.merchants m where m.status = 'published'""")]
            cases = [dict(c) for c in CASES]
            cases.append({"exclude": [r["subject_id"] for r in rows[:2]]})
            offerings = [dict(r) for r in await db.fetch("""
                select o.id::text as subject_id, o.id::text as id, o.merchant_id::text as merchant_id,
                       o.kind, o.name, o.name_zh, o.price_amount, o.price_min, o.price_max,
                       o.rating_agg, o.attributes, m.tags, m.category_primary as category,
                       'offering'::text as subject_type
                from public.offerings o join public.merchants m on m.id = o.merchant_id
                where o.tenant_id = $1::uuid and o.status = 'active' and m.status = 'published'""",
                str(S.DEFAULT_TENANT_ID))]
            out = {"rows": len(rows), "offerings": len(offerings), "pools": []}
            for filters in cases:
                pools = {}
                for name, backend in (("fixture", S.StaticBackend(merchants=rows)),
                                      ("live", Deps(st).backend())):
                    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10)
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pools[name] = getattr(resp, "total_estimate", None)
                out["pools"].append((sorted(filters), pools))
            tag = {"tags": ["thai"]}
            off_pools = {}
            for name, backend in (("fixture", S.StaticBackend(merchants=rows, offerings=offerings)),
                                  ("live", Deps(st).backend())):
                plan = S.SearchPlan(query_text="", filters=dict(tag), limit=10,
                                    subject_types=("offering",))
                _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                off_pools[name] = getattr(resp, "total_estimate", None)
            plan = S.SearchPlan(query_text="", filters={}, limit=10, subject_types=("offering",))
            _c, resp, _b, _s = await S.search(backend=Deps(st).backend(), plan=plan)
            out["offerings_all"] = getattr(resp, "total_estimate", None)
            out["kind_pools"] = []
            for kind in ("product", "service", "experience"):
                pools = {}
                for name, backend in (("fixture", S.StaticBackend(merchants=[], offerings=offerings)),
                                      ("live", Deps(st).backend())):
                    plan = S.SearchPlan(query_text="", filters={"kind": kind}, limit=10,
                                        subject_types=("offering",))
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pools[name] = getattr(resp, "total_estimate", None)
                out["kind_pools"].append((kind, pools))
            out["offering_pools"] = off_pools
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("index", range(4))
def test_the_two_lanes_keep_the_same_population(plane, index):
    filters, pools = plane["pools"][index]
    assert pools["fixture"] == pools["live"], (filters, pools)
    assert pools["live"] < plane["rows"], (filters, pools)   # the filter has something to remove


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_offering_plane_answers_the_tag_its_merchant_carries(plane):
    pools = plane["offering_pools"]
    # The fixture's row list is the live predicate's own population: 4,707 active offerings under
    # published merchants, which is what the unread lane answered before this unit.
    assert plane["offerings_all"] == plane["offerings"] > 1000, (plane["offerings_all"], plane["offerings"])
    assert 0 < pools["live"] < plane["offerings"], pools               # the tag removes something
    assert pools["fixture"] == pools["live"], pools


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("index", range(3))
def test_the_offering_kind_answers_the_same_population_on_both_lanes(plane, index):
    kind, pools = plane["kind_pools"][index]
    assert pools["fixture"] == pools["live"], (kind, pools)
    assert 0 < pools["live"] < plane["offerings"], (kind, pools)     # the kind removes something
