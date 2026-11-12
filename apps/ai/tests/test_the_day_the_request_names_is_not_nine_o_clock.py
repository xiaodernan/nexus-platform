"""A request that names a DAY was answered as nine o'clock that morning.

`parse_time`'s bare-day branch answers a whole-day window, 09:00-23:00 by convention
(`nlu/timeparse.py:470-473`, quality `all_day`), and a weekend as Saturday 09:00 - Monday 00:00
(`:452-456`). `plan_from_intent` then took the window's START as the hour the user named and wrote
`open_time = 09:00` (`service.py:1008-1020`), so every day-level sentence became a 09:00 filter on
both lanes. Measured on the published plane (`tmp/d665_counts.py`, Wednesday):

    sentence                 plan (before)          pool (before)
    今日嘅咖啡店             wd=1, open 09:00       35 of 79 cafes
    聽日嘅餐廳               wd=2, open 09:00       13 of 184 restaurants
    今個週末嘅咖啡店         wd=5, open 09:00       36 cafes
    今晚嘅餐廳               wd=1, open 18:00       142 of 184 restaurants

`聽日嘅餐廳` answering 13 of 184 restaurants is the shape of it: most restaurants open at 11:30, so
a 09:00 point excludes 171 of them from a request that named a DAY and no hour at all. The DAY is a
real filter - a shop with no hours that day is closed that day (D422) - so the plan keeps
`open_weekday` and the display instant (`plan.at`, which the card uses for its open state), and stops
writing the hour.

What this does NOT change: a part of day is still a clock-backed window (`今晚` -> 18:00), and a clock
the user says is still the filter (`聽日7點` -> 07:00 on tomorrow). Both keep their legs here.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timezone

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)   # Wednesday 09:00 in Hong Kong


def _plan(text, now=NOW):
    from nexus_ai.nlu.understand import extract_intent

    # D672: the PARSER takes its own `now`, and calling it without one made every leg depend on
    # the wall clock the suite happened to run at - 「今日」 was a Tuesday only because the machine
    # said so. One `now`, handed to both readers.
    return S.plan_from_intent(extract_intent(text, {"now": now}), query=text, now=now)


def test_a_day_is_a_weekday_and_not_an_hour():
    plan = _plan("今日嘅咖啡店")
    assert plan.filters.get("open_weekday") == 2, plan.filters     # Wednesday in Hong Kong
    assert "open_time" not in plan.filters, plan.filters
    assert plan.at is not None, "the card still needs the day it was asked about"


def test_tomorrow_is_the_next_weekday_and_not_an_hour():
    plan = _plan("聽日嘅餐廳")
    assert plan.filters.get("open_weekday") == 3, plan.filters
    assert "open_time" not in plan.filters, plan.filters


def test_a_clock_the_user_says_is_still_the_filter():
    plan = _plan("聽日7點嘅餐廳")
    assert plan.filters.get("open_weekday") == 3, plan.filters
    assert plan.filters.get("open_time") == time(7, 0), plan.filters


def test_a_part_of_day_keeps_its_window_start():
    plan = _plan("今晚嘅餐廳")
    assert plan.filters.get("open_weekday") == 2, plan.filters
    assert plan.filters.get("open_time") == time(18, 0), plan.filters


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, weekday, opens=(11, 30), closes=(22, 0), *, crosses=False):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


def _answer(rows, filters, *, hours=(), offerings=(), subject_types=("merchant",)):
    import asyncio

    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings, hours=hours)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


ROWS = [_row("tue"), _row("wed"), _row("night"), _row("none")]
HOURS = [
    _hours("tue", 1),                                        # trades Tuesday
    _hours("wed", 2),                                        # trades Wednesday only
    _hours("night", 1, (22, 0), (2, 0), crosses=True),       # Tuesday night, crossing midnight
    # "none" states no hours at all
]


def test_a_weekday_without_a_clock_keeps_the_rows_that_trade_that_day():
    got, total = _answer(ROWS, {"open_weekday": 1}, hours=HOURS)
    assert got == ["night", "tue"], got
    assert total == 2, total


def test_a_weekday_without_a_clock_still_drops_a_row_that_states_no_hours():
    got, _total = _answer(ROWS, {"open_weekday": 1}, hours=HOURS)
    assert "none" not in got, got


def test_a_weekday_with_a_clock_still_asks_the_clock():
    got, _total = _answer(ROWS, {"open_weekday": 1, "open_time": time(19, 0)}, hours=HOURS)
    assert got == ["tue"], got


def test_an_offering_answers_the_weekday_of_its_shop():
    offerings = [
        {"subject_id": "o1", "merchant_id": "tue", "id": "o1", "kind": "service", "name": "One",
         "name_zh": "一", "price_amount": 10.0, "category": "cafe", "subject_type": "offering"},
        {"subject_id": "o2", "merchant_id": "wed", "id": "o2", "kind": "service", "name": "Two",
         "name_zh": "二", "price_amount": 20.0, "category": "cafe", "subject_type": "offering"},
    ]
    got, _total = _answer([], {"open_weekday": 1}, hours=HOURS, offerings=offerings,
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
            hours = [dict(r) for r in await db.fetch("""
                select bh.merchant_id::text as merchant_id, bh.weekday, bh.opens_at,
                       bh.closes_at, bh.crosses_midnight
                from public.business_hours bh""")]
            from nexus_ai.nlu.understand import extract_intent

            fixture = S.StaticBackend(merchants=merchants, hours=hours)
            live = Deps(st).backend()
            out = {"merchants": len(merchants), "pools": {}, "weekdays": {}}
            for sentence in ("今日嘅餐廳", "今日嘅咖啡店"):
                plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                          query=sentence, now=NOW)
                pool = {}
                for name, backend in (("fixture", fixture), ("live", live)):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["pools"][sentence] = pool
            # The clause is `open_weekday` ALONE, so every weekday of the week is a question it
            # answers - not just the two the sentences above land on (`tmp/d665_weekdays.py`).
            for wd in range(7):
                plan = S.SearchPlan(query_text="", filters={"open_weekday": wd}, limit=10,
                                    subject_types=("merchant",))
                pool = {}
                for name, backend in (("fixture", fixture), ("live", live)):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["weekdays"][str(wd)] = pool
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_day_answers_the_same_pool_on_both_lanes(plane):
    """Measured after the fix (`tmp/d667_counts2.py`, Wednesday 09:00 HK, one `now` for both
    readers): 175/175 restaurants and 74/74 cafes, against 13 and 35 when the day was read as
    09:00 and 184 and 79 when the weekday went unread."""
    pools = plane["pools"]
    day = pools["今日嘅餐廳"]
    assert day["fixture"] == day["live"] == 175, pools
    # 13 was the 09:00 point; 184 was the whole restaurant plane when the weekday went unread on
    # the live lane before this clause existed. A day request lands strictly between the two.
    assert 13 < day["live"] < 184, pools
    cafe = pools["今日嘅咖啡店"]
    assert cafe["fixture"] == cafe["live"] == 74, pools
    assert 0 < cafe["live"] < 79, pools     # some cafe states no Wednesday row
