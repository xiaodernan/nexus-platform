"""凌晨 is the small hours, and the lane had no time for it at all.

`PART_OF_DAY` held five bands (`timeparse.py:44-50`) and 凌晨 was in none of them - not a date word
either - so `parse_time` answered None and the plan carried no time filter: 「凌晨嘅餐廳」 returned
**184 of 184 restaurants**, every restaurant in the corpus, whatever hour it shuts. Measured on the
published plane (`tmp/d667_counts2.py`, Wednesday 09:00 HK, one `now` for both readers):

    sentence              filters (before)   pool (before)   lanes now
    凌晨                   none               470 of 470      60/60
    凌晨嘅餐廳             none               184 of 184      0/0
    凌晨嘅咖啡店           none               79 of 79        0/0
    凌晨三點               wd=3, 03:00        21              21/21
    深夜兩點               wd=3, 14:00 (!)    177 of 184      0/0
    晚上兩點               wd=3, 14:00 (!)    177 of 184      0/0

The last two rows are the other half: a CLOCK beside a night word went through the rule that adds
twelve to every hour below noon (`_guess_meridiem`), so 「深夜兩點」 asked for two in the AFTERNOON
and answered 177 restaurants. 0 is the honest answer for 凌晨嘅餐廳 on this corpus - the 60
merchants that trade between midnight and five are 39 bars and 21 hotels, and no restaurant or cafe
is one of them (`tmp/d667_cat.py`).

The band is 00:00-05:00, the only band that starts at midnight, so D666's window reader carries it
with no new clause: `open_time` 00:00 and `open_until` 05:00 on the coming night's weekday.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, time, timezone

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)   # Wednesday 09:00 in Hong Kong
SMALL_HOURS = {"open_weekday": 3, "open_time": time(0, 0), "open_until": time(5, 0)}


def _plan(text, now=NOW):
    from nexus_ai.nlu.understand import extract_intent

    return S.plan_from_intent(extract_intent(text, {"now": now}), query=text, now=now)


def _clock(text):
    plan = _plan(text)
    return plan.filters.get("open_time"), plan.filters.get("open_until")


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "bar", "avg_price_hkd": 90.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, weekday, opens, closes, *, crosses=False):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


def _answer(rows, filters, *, hours=()):
    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=("merchant",))
    backend = S.StaticBackend(merchants=rows, offerings=[], hours=hours)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


ROWS = [_row("allnight"), _row("day"), _row("late"), _row("middle"), _row("shut")]
HOURS = [
    _hours("allnight", 3, (0, 0), (4, 0)),                  # trades in the small hours
    _hours("day", 3, (9, 0), (18, 0)),                      # daytime only
    _hours("late", 3, (22, 0), (2, 0), crosses=True),        # crosses midnight into them
    _hours("middle", 3, (3, 0), (4, 0)),                    # 03:00-04:00, inside the band only
    # "shut" states no hours at all
]


def test_the_plan_reads_the_small_hours_as_a_window():
    plan = _plan("凌晨嘅餐廳")
    assert plan.filters.get("open_weekday") == 3, plan.filters
    assert plan.filters.get("open_time") == time(0, 0), plan.filters
    assert plan.filters.get("open_until") == time(5, 0), plan.filters


def test_the_word_leaves_the_match_text():
    """`:query_text` is the sentence as the reader holds it; the strip is `match_text`, the one
    field the ranker scores."""
    from nexus_ai.nlu.understand import match_core

    plan = _plan("凌晨嘅餐廳")
    assert "凌晨" not in plan.match_text, plan.match_text
    # 餐廳 is the CATEGORY and leaves for the category filter's reason; the strip this unit is
    # about takes 凌晨 and leaves the rest of the sentence where it was.
    assert match_core("凌晨嘅酒吧", strip_time=True) == "酒吧", (
        match_core("凌晨嘅酒吧", strip_time=True))


def test_a_clock_in_the_small_hours_is_not_the_afternoon():
    """The crux: 「深夜兩點」 is 02:00, and the old rule asked for 14:00 and answered 177
    restaurants - the afternoon's pool for a sentence about two in the morning."""
    assert _clock("深夜兩點嘅餐廳") == (time(2, 0), None)
    assert _clock("凌晨三點嘅餐廳") == (time(3, 0), None)


def test_a_clock_that_is_really_the_evening_still_reads_pm():
    assert _clock("深夜十一點嘅餐廳") == (time(23, 0), None)
    assert _clock("晚上八點嘅餐廳") == (time(20, 0), None)
    assert _clock("下午兩點嘅餐廳") == (time(14, 0), None)


def test_a_shop_that_trades_in_the_small_hours_answers_the_band():
    """`middle` opens at 03:00 and is inside the band with the point at midnight long behind it -
    the row the old "open at 00:00" reading deleted."""
    got, _total = _answer(ROWS, SMALL_HOURS, hours=HOURS)
    assert got == ["allnight", "late", "middle"], got


def test_a_shop_that_trades_only_in_the_daytime_does_not():
    got, _total = _answer(ROWS, SMALL_HOURS, hours=HOURS)
    assert "day" not in got, got


def test_a_row_with_no_hours_still_fails():
    got, _total = _answer(ROWS, SMALL_HOURS, hours=HOURS)
    assert "shut" not in got, got


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

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
            out = {"merchants": len(merchants), "pools": {}}
            for sentence in ("凌晨", "凌晨嘅餐廳", "凌晨三點"):
                plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                          query=sentence, now=NOW)
                pool = {}
                for name, backend in (("fixture", fixture), ("live", live)):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["pools"][sentence] = pool
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_small_hours_answer_the_same_pool_on_both_lanes(plane):
    """Checked on both lanes against the same replay: the corpus seed moves weekly, so the test
    pins the same-plane invariant and the shape of the answer, never an absolute pool size."""
    pools = plane["pools"]
    band = pools["凌晨"]
    assert band["fixture"] == band["live"], pools
    assert 0 < band["live"] < plane["merchants"], (band, plane["merchants"])
    restaurant = pools["凌晨嘅餐廳"]
    assert restaurant["fixture"] == restaurant["live"], pools
    assert restaurant["live"] <= band["live"], pools
    point = pools["凌晨三點"]
    assert point["fixture"] == point["live"], pools
    assert 0 < point["live"] <= band["live"], pools
