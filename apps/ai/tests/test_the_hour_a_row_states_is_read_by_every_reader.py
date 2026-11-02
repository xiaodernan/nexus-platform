"""The hour filters were read by one of three readers, and the request names a clock.

`build_merchant_query` filters on three clock clauses - `open_weekday`+`open_time`
(`search/sql.py:247-258`), `min_closing_hour` (`:259-264`) and `max_opening_hour` (`:265-272`) -
each an EXISTS over `business_hours`. The OFFERING SELECT carried none of them, and `_filter_static`
read no clock at all, so the same request answered three different pools. Measured on the published
plane (`tmp/d659_open2.py`), weekday 1 at 19:00, rows behind each answer:

    plan                                  fixture (before)   live (before)   after (both)
    merchants open at 19:00               470 of 470         369             369
    offerings under a shop open at 19:00  4,707 of 4,707     4,707           3,907

470 and 4,707 are the whole plane; 3,907 is the offerings whose MERCHANT is open at that hour
(1,941 is the Sha Tin figure from D656, for scale). An offering is bookable when its shop is open,
and the join already holds the shop.

The fixture lane reads the hours the backend hands it (`StaticBackend(hours=...)`, the same rows
`backend.hours()` serves the cards). A merchant whose rows satisfy no clause FAILS, because that is
what `EXISTS` does - so a row with no hours row at all is dropped, which the third leg pins.
"""

from __future__ import annotations

import os
from datetime import time

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, opens, closes, *, crosses=False, weekday=1):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


ROWS = [_row("a"), _row("b"), _row("c"), _row("d")]
HOURS = [
    _hours("a", (11, 30), (23, 0)),                 # open at 19:00
    _hours("b", (11, 30), (19, 0)),                 # closes exactly as the request names
    _hours("c", (23, 0), (2, 0), crosses=True),     # a night shop
    # "d" states no hours at all
]


def _answer(rows, filters, *, hours=HOURS, offerings=(), subject_types=("merchant",)):
    import asyncio

    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings, hours=hours)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


@pytest.mark.parametrize("at,kept", [
    (time(19, 0), ["a"]),        # b closes AT 19:00 and the clause is `closes_at > t`
    (time(12, 0), ["a", "b"]),
    (time(1, 0), ["c"]),         # the night shop answers at 01:00, in its own crossing row
    (time(3, 0), []),            # and not at 03:00
])
def test_a_row_answers_the_hour_it_is_open(at, kept):
    got, total = _answer(ROWS, {"open_weekday": 1, "open_time": at})
    assert got == kept, (at, got)
    assert total == len(kept), (at, total)


def test_a_row_that_states_no_hours_fails_like_the_exists():
    got, _total = _answer(ROWS, {"open_weekday": 1, "open_time": time(19, 0)})
    assert "d" not in got, got


def test_the_weekday_is_part_of_the_question():
    hours = [_hours("a", (11, 30), (23, 0), weekday=3)]
    got, _total = _answer([_row("a")], {"open_weekday": 1, "open_time": time(19, 0)}, hours=hours)
    assert got == [], got
    got, _total = _answer([_row("a")], {"open_weekday": 3, "open_time": time(19, 0)}, hours=hours)
    assert got == ["a"], got


def test_a_late_closing_hour_and_an_early_opening_hour():
    got, _total = _answer(ROWS, {"min_closing_hour": 21})
    assert got == ["a", "c"], got          # 23:00 and the crossing row; b closes at 19
    got, _total = _answer(ROWS, {"max_opening_hour": 12})
    assert got == ["a", "b", "c"], got     # 11:30 twice and the crossing row; d has none


def test_an_offering_answers_the_hours_of_its_shop():
    offerings = [
        {"subject_id": "o1", "merchant_id": "a", "id": "o1", "kind": "service", "name": "One",
         "name_zh": "一", "price_amount": 10.0, "category": "cafe", "subject_type": "offering"},
        {"subject_id": "o2", "merchant_id": "b", "id": "o2", "kind": "service", "name": "Two",
         "name_zh": "二", "price_amount": 20.0, "category": "cafe", "subject_type": "offering"},
    ]
    got, _total = _answer([], {"open_weekday": 1, "open_time": time(19, 0)},
                          offerings=offerings, subject_types=("offering",))
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

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            merchants = [dict(r) for r in await db.fetch("""
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
            offerings = [dict(r) for r in await db.fetch("""
                select o.id::text as subject_id, o.id::text as id, o.merchant_id::text as merchant_id,
                       o.kind, o.name, o.name_zh, o.price_amount, o.price_min, o.price_max,
                       o.rating_agg, o.attributes, m.tags, m.category_primary as category,
                       'offering'::text as subject_type
                from public.offerings o join public.merchants m on m.id = o.merchant_id
                where o.tenant_id = $1::uuid and o.status = 'active' and m.status = 'published'""",
                str(S.DEFAULT_TENANT_ID))]
            hours = [dict(r) for r in await db.fetch("""
                select bh.merchant_id::text as merchant_id, bh.weekday, bh.opens_at,
                       bh.closes_at, bh.crosses_midnight
                from public.business_hours bh""")]
            out = {"merchants": len(merchants), "offerings": len(offerings), "pools": []}
            cases = [
                ("merchant", {"open_weekday": 1, "open_time": time(19, 0)}),
                ("merchant", {"min_closing_hour": 21}),
                ("merchant", {"max_opening_hour": 8}),   # every shop in the corpus opens by noon, some not by 8
                ("offering", {"open_weekday": 1, "open_time": time(19, 0)}),
                ("offering", {"min_closing_hour": 21}),
            ]
            for sts, filters in cases:
                pool = {}
                for name, backend in (("fixture", S.StaticBackend(
                        merchants=merchants if sts == "merchant" else [],
                        offerings=offerings if sts == "offering" else [],
                        hours=hours)), ("live", Deps(st).backend())):
                    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                                        subject_types=(sts,))
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["pools"].append((sts, sorted(filters), pool))
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("index", range(5))
def test_the_two_lanes_answer_the_same_hours(plane, index):
    sts, filters, pools = plane["pools"][index]
    assert pools["fixture"] == pools["live"], (sts, filters, pools)
    whole = plane["offerings"] if sts == "offering" else plane["merchants"]
    assert 0 < pools["live"] < whole, (sts, filters, pools, whole)
