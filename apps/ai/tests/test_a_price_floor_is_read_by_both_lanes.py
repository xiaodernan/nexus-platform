"""A caller's price floor was answered by rows below it on the fixture lane.

`Filters.min_price` is a HARD filter (§7.1: the request's filters are hard), and both live clauses
read it - `merchants` as `avg_price_hkd IS NULL OR avg_price_hkd >= x` (`search/sql.py:216`) and an
offering as `COALESCE(price_amount, price_min)` (`:457`). The fixture mirror read ONE column
(`avg_price_hkd`) and only its CEILING, so the degraded lane answered a different question. Measured
on the published plane (`tmp/d654_minprice2.py`), `餐廳` with `min_price: 300`:

    rows whose own price clears the floor      3 of 184
    live lane                                  3 answers, total 3, none below
    fixture lane (before)                     10 answers, 7 below, total 184
    fixture lane (after)                       3 answers, total 3, none below

The same read had a second hole on the other kind: an offering states `price_amount` (with
`price_max` / `price_min` as bounds), and a fixture offering row was filtered by its
`avg_price_hkd` alias - the merchant's average on the live SELECT (`sql.py:583`) - so a ceiling could
exclude an offering by the price of the shop it sits in.

One reader for both kinds (`_static_price`), one NULL rule: a row that states no price passes, which
is what both live clauses do and what an unstated price means.
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
FLOOR = 300.0
CEILING = 300.0


def _merchant(key, price):
    return {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
            "category_primary": "restaurant", "avg_price_hkd": price, "rating_agg": 4.0,
            "review_count": 10, "tags": ["restaurant"], "data_origin": "demo"}


MERCHANTS = [_merchant("cheap", 100.0), _merchant("edge", 300.0), _merchant("rich", 600.0),
             _merchant("unpriced", None)]


def _answer(rows, filters, *, offerings=None, subject_types=("merchant",)):
    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings or ())
    import asyncio
    cards, resp, _bundle, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


@pytest.mark.parametrize("filters,kept", [
    ({"min_price": FLOOR}, ["edge", "rich", "unpriced"]),
    ({"max_price": CEILING}, ["cheap", "edge", "unpriced"]),
    ({"min_price": FLOOR, "max_price": 500.0}, ["edge", "unpriced"]),
    ({"min_price": 0.0}, ["cheap", "edge", "rich", "unpriced"]),
])
def test_a_merchant_price_filter_reads_the_row(filters, kept):
    got, total = _answer(MERCHANTS, filters)
    assert got == sorted(kept), (filters, got)
    assert total == len(kept), (filters, total)


OFFERINGS = [
    {"subject_id": "o-amount", "merchant_id": "m1", "name": "Amount", "name_zh": "價",
     "price_amount": 500.0, "avg_price_hkd": 900.0, "category": "restaurant", "kind": "service",
     "subject_type": "offering"},
    {"subject_id": "o-low", "merchant_id": "m1", "name": "Low", "name_zh": "低",
     "price_amount": 100.0, "avg_price_hkd": 900.0, "category": "restaurant", "kind": "service",
     "subject_type": "offering"},
    {"subject_id": "o-band", "merchant_id": "m1", "name": "Band", "name_zh": "段",
     "price_min": 400.0, "price_max": 800.0, "avg_price_hkd": 100.0, "category": "restaurant",
     "kind": "service", "subject_type": "offering"},
    {"subject_id": "o-none", "merchant_id": "m1", "name": "None", "name_zh": "無",
     "avg_price_hkd": 100.0, "category": "restaurant", "kind": "service",
     "subject_type": "offering"},
]


@pytest.mark.parametrize("filters,kept", [
    ({"min_price": FLOOR}, ["o-amount", "o-band", "o-none"]),
    ({"max_price": CEILING}, ["o-low", "o-none"]),
])
def test_an_offering_price_filter_reads_its_own_price(filters, kept):
    # The `avg_price_hkd` each row carries is the shop's average and must not decide it: o-low is a
    # 100 offering in a 900 shop and is excluded by a 300 floor, o-band is 400-800 in a 100 shop
    # and is kept by it.
    got, _total = _answer([], filters, offerings=OFFERINGS, subject_types=("offering",))
    assert got == sorted(kept), (filters, got)


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent_dict

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
            intent = validate_intent(extract_intent_dict("餐廳"))
            out = {"rows": len(rows), "below": 0, "lanes": {}}
            out["below"] = sum(1 for r in rows
                               if r["avg_price_hkd"] is not None and float(r["avg_price_hkd"]) < FLOOR)
            for filters in ({"min_price": FLOOR}, {"max_price": FLOOR}):
                lanes = {}
                for name, backend in (("fixture", S.StaticBackend(merchants=rows)),
                                      ("live", Deps(st).backend())):
                    plan = S.plan_from_intent(intent, query="餐廳", filters=dict(filters), limit=10)
                    _cards, resp, _b, scored = await S.search(backend=backend, plan=plan)
                    lanes[name] = dict(
                        ids=sorted(s.candidate.subject_id for s in scored),
                        prices=[s.candidate.price for s in scored],
                        total=getattr(resp, "total_estimate", None))
                out["lanes"][next(iter(filters))] = lanes
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_corpus_has_rows_on_both_sides_of_the_floor(plane):
    # Without both sides the parity below could pass on a corpus that never says no.
    assert plane["below"] > 10 and plane["below"] < plane["rows"], plane["below"]


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("key", ["max_price", "min_price"])
def test_both_lanes_remove_the_same_rows(plane, key):
    lanes = plane["lanes"][key]
    # The TOTAL is the population the filter leaves, and it is what the two lanes must agree on: a
    # page cut inside a tie group replaces rows the filter did not remove (D607 measured 21 of 200
    # for the party predicate), so only a population small enough to fit the page is compared as a
    # SET - the floor keeps 3 of these 184 rows and the ceiling keeps the other 181.
    assert lanes["fixture"]["total"] == lanes["live"]["total"], (key, lanes)
    if lanes["live"]["total"] <= 10:
        assert lanes["fixture"]["ids"] == lanes["live"]["ids"], (
            f"{key}: fixture {lanes['fixture']['ids'][:3]} vs live {lanes['live']['ids'][:3]}")
    for name in ("fixture", "live"):
        prices = [float(p) for p in lanes[name]["prices"] if p is not None]
        if key == "min_price":
            assert min(prices) >= FLOOR, (name, min(prices))
        else:
            assert max(prices) <= FLOOR, (name, max(prices))
