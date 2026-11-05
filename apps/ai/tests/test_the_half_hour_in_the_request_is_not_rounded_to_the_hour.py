"""The half hour the request names was rounded away before any reader saw it.

`parse_time` carries the clock to four digits - `open_late_after:2130`, `before:0730` - and
`plan_from_intent` divided that number by 100 (`search/service.py:946-952`), so 「營業到晚上九點半」 asked
the search for a closing time of NINE O'CLOCK. Both readers then built their clause from the hour:
the live EXISTS binds `int(h) * interval '1 hour'` (`search/sql.py:274-290` merchant, `:529-545`
offering) and the fixture lane builds `time(int(h), 0)` (`service.py:461-487`). Measured on the
published plane (`tmp/d661_probe.py`, 470 published merchants, 4,707 active offerings, 5,472 hour
rows):

    request                     plan carries   pool (both lanes)
    營業到晚上九點半            late=21:00     470 merchants = the whole plane
    九點半之後仲開              late=09:00     470 merchants = the whole plane
    open until 6:30pm           late=18:00     470 merchants = the whole plane
    七點半前                    early=07:00    470 merchants = the whole plane

The corpus is not on the hour: 2,908 `business_hours` rows close at a non-zero minute (18:30: 244,
21:30: 102, 22:30: 616, 23:30: 267), and 2,028 open at one (07:30: 268, 11:30: 810). Closing at or
after 21:00 holds 285 published merchants and 3,238 offerings; at or after 21:30, 283 and 3,217. So
the rounded request answered 470 where the sentence named 283 - the whole plane, i.e. no filter at
all in effect.

The fix carries a `datetime.time`, the same value `open_time` already binds (D399): the plan fields
hold a clock, both filter keys hold a clock, and an int is still read as `int:00` so a hand-built
caller or an older test keeps its meaning.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timezone

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)   # Wednesday 09:00 in Hong Kong


def _plan(text):
    from nexus_ai.nlu.understand import extract_intent

    return S.plan_from_intent(extract_intent(text), query=text, now=NOW)


@pytest.mark.parametrize("text,field,key,expected", [
    ("營業到晚上九點半", "open_late_after", "min_closing_hour", time(21, 30)),
    # D698: a bare closing clock is an evening clock, so 九點半 is 21:30 - this leg used to pin
    # 09:30 (the rounding fix's old twelve-hour default) and the sentence no longer asks for the
    # morning. The rounding itself is what this gate is about and is unchanged.
    ("九點半之後仲開", "open_late_after", "min_closing_hour", time(21, 30)),
    ("open until 6:30pm", "open_late_after", "min_closing_hour", time(18, 30)),
    ("七點半前", "open_early_before", "max_opening_hour", time(7, 30)),
])
def test_the_plan_carries_the_half_hour_the_sentence_said(text, field, key, expected):
    plan = _plan(text)
    assert getattr(plan, field) == expected, (text, getattr(plan, field))
    assert plan.filters.get(key) == expected, (text, plan.filters)


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
    _hours("a", (11, 30), (20, 45)),                # closes before either clock below
    _hours("b", (11, 30), (21, 30)),                # closes exactly at it
    _hours("c", (11, 30), (21, 45)),                # closes after it
    _hours("d", (11, 30), (21, 0)),                 # closes at the old, rounded hour
]


def _answer(rows, filters, *, hours=HOURS, offerings=(), subject_types=("merchant",)):
    import asyncio

    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings, hours=hours)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


def test_the_fixture_lane_keeps_the_rows_that_close_at_or_after_the_half_hour():
    got, total = _answer(ROWS, {"min_closing_hour": time(21, 30)})
    assert got == ["b", "c"], got
    assert total == 2, total


def test_the_fixture_lane_reads_the_half_hour_before_a_clock():
    got, _total = _answer(ROWS, {"max_opening_hour": time(11, 45)})
    assert got == ["a", "b", "c", "d"], got
    got, _total = _answer(ROWS, {"max_opening_hour": time(11, 15)})
    assert got == [], got


def test_an_int_is_still_an_hour_for_a_hand_built_caller():
    got, _total = _answer(ROWS, {"min_closing_hour": 21})
    assert got == ["b", "c", "d"], got          # 21:00, 21:30, 21:45 - and not the 21:15 shop


def test_an_offering_answers_the_half_hour_of_its_shop():
    offerings = [
        {"subject_id": "o1", "merchant_id": "a", "id": "o1", "kind": "service", "name": "One",
         "name_zh": "一", "price_amount": 10.0, "category": "cafe", "subject_type": "offering"},
        {"subject_id": "o2", "merchant_id": "c", "id": "o2", "kind": "service", "name": "Two",
         "name_zh": "二", "price_amount": 20.0, "category": "cafe", "subject_type": "offering"},
    ]
    got, _total = _answer([], {"min_closing_hour": time(21, 30)},
                          offerings=offerings, subject_types=("offering",))
    assert got == ["o2"], got


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
            out = {"merchants": len(merchants), "offerings": len(offerings), "pools": {}}
            live = Deps(st).backend()
            for subject in ("merchant", "offering"):
                rows = merchants if subject == "merchant" else offerings
                for value in (time(21, 0), time(21, 30)):
                    pool = {}
                    for name, backend in (
                        ("fixture", S.StaticBackend(
                            merchants=rows if subject == "merchant" else [],
                            offerings=rows if subject == "offering" else [], hours=hours)),
                        ("live", live),
                    ):
                        plan = S.SearchPlan(query_text="",
                                            filters={"min_closing_hour": value}, limit=10,
                                            subject_types=(subject,))
                        _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                        pool[name] = getattr(resp, "total_estimate", None)
                    out["pools"][(subject, value)] = pool
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.parametrize("subject", ["merchant", "offering"])
def test_the_two_lanes_answer_the_half_hour_the_same_way(plane, subject):
    pools = plane["pools"][(subject, time(21, 30))]
    assert pools["fixture"] == pools["live"], pools
    whole = plane["merchants"] if subject == "merchant" else plane["offerings"]
    assert 0 < pools["live"] < whole, (pools, whole)


@pytest.mark.parametrize("subject,on_the_hour,on_the_half", [
    ("merchant", 285, 283), ("offering", 3238, 3217),
])
def test_the_half_hour_answers_fewer_rows_than_the_hour(plane, subject, on_the_hour, on_the_half):
    both = plane["pools"][(subject, time(21, 0))]
    half = plane["pools"][(subject, time(21, 30))]
    assert both["fixture"] == both["live"] == on_the_hour, both
    assert half["fixture"] == half["live"] == on_the_half, half
