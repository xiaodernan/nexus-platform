"""A part of day is a WINDOW, and both readers asked for its first minute.

`timeparse` states each band as a window (`timeparse.py:44-50`: morning 07:00-11:30, noon
11:30-14:30, afternoon 14:00-18:00, evening 17:00-19:30, night 18:00-23:00) and the plan wrote the
window's START as the instant a shop had to be open AT (`service.py:1030-1039`, `out["open_time"]`).
So 「聽日朝早嘅咖啡店」 asked both lanes for shops open at 07:00 and answered **0 of 79 cafes**:
every cafe in the corpus opens at 08:00 or later, and not one of them is "open at seven". Measured
on the published plane (`tmp/d666_probe.py`, Wednesday 09:00 HK, both lanes agreeing before and
after - the defect is the QUESTION, not a lane):

    sentence                 filters (before)         pool (before)   pool (now)
    聽日朝早嘅咖啡店         wd=2, open 07:00         0 of 79         78
    聽日中午嘅餐廳           wd=2, open 11:30         98 of 184       174
    聽日晚黑嘅餐廳           wd=2, open 18:00         136 of 184      174
    下晝嘅咖啡店             wd=1, open 14:00         74              74
    今晚十一點嘅餐廳         wd=1, open 23:00         34              34   (a clock, unchanged)

The repair keeps ONE filter shape and adds the window's far edge: `open_time` is still the start, in
the same `time` column D399 gave it, and `open_until` is the band's end. With both present the
clause is an interval overlap - "open at some point inside the band" - which is what the sentence
means; with only `open_time` it stays the point it always was. The `type` field is what tells the two
apart (`range` for a band, `explicit` for a clock, `timeparse`'s own distinction), because a band
word beside a clock ("今晚十一點") carries the same `quality` the band alone does.

What this does NOT change: a clock the user says is still a point (晚上8點, 聽日7點), and a day is
still a day (D665). Both keep their legs here.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, time, timezone

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)   # Wednesday 09:00 in Hong Kong
MORNING = {"open_weekday": 2, "open_time": time(7, 0), "open_until": time(11, 30)}
NIGHT = {"open_weekday": 2, "open_time": time(18, 0), "open_until": time(23, 0)}


def _plan(text, now=NOW):
    from nexus_ai.nlu.understand import extract_intent

    return S.plan_from_intent(extract_intent(text), query=text, now=now)


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, weekday, opens, closes, *, crosses=False):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


def _answer(rows, filters, *, hours=(), offerings=(), subject_types=("merchant",)):
    plan = S.SearchPlan(query_text="", filters=dict(filters), limit=10,
                        subject_types=tuple(subject_types))
    backend = S.StaticBackend(merchants=rows, offerings=offerings, hours=hours)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return sorted(s.candidate.subject_id for s in scored), getattr(resp, "total_estimate", None)


#: Tuesday rows: the shapes a band has to tell apart
ROWS = [_row("early"), _row("late"), _row("edge"), _row("atclose"), _row("night"), _row("shut")]
HOURS = [
    _hours("early", 2, (8, 0), (18, 0)),        # opens inside the morning
    _hours("late", 2, (14, 0), (22, 0)),        # never open in the morning
    _hours("edge", 2, (6, 0), (7, 0)),          # closes exactly when the window opens
    _hours("atclose", 2, (11, 30), (15, 0)),    # opens exactly when the window closes
    _hours("night", 2, (22, 0), (2, 0), crosses=True),   # crosses midnight into the night band
    # "shut" states no hours at all
]


def test_the_plan_carries_the_bands_two_edges():
    plan = _plan("聽日朝早嘅咖啡店")
    assert plan.filters.get("open_weekday") == 2, plan.filters
    assert plan.filters.get("open_time") == time(7, 0), plan.filters
    assert plan.filters.get("open_until") == time(11, 30), plan.filters


def test_a_clock_the_user_says_is_still_a_point():
    plan = _plan("聽日7點嘅餐廳")
    assert plan.filters.get("open_time") == time(7, 0), plan.filters
    assert "open_until" not in plan.filters, plan.filters


def test_a_band_word_beside_a_clock_is_still_a_point():
    plan = _plan("今晚十一點嘅餐廳")
    assert plan.filters.get("open_time") == time(23, 0), plan.filters
    assert "open_until" not in plan.filters, plan.filters


def test_a_day_is_still_a_day_and_not_a_window():
    plan = _plan("聽日嘅餐廳")
    assert "open_time" not in plan.filters and "open_until" not in plan.filters, plan.filters


def test_a_shop_that_opens_inside_the_band_answers_it():
    got, _total = _answer(ROWS, MORNING, hours=HOURS)
    assert got == ["early"], got


def test_the_same_shop_does_not_answer_the_bands_first_minute():
    """The crux: `early` opens at 08:00 and is open all morning, and the point at 07:00 deleted it."""
    point = dict(MORNING)
    point.pop("open_until")
    got, total = _answer(ROWS, point, hours=HOURS)
    assert got == [], (got, total)


def test_a_shop_that_opens_when_the_band_closes_never_answers_it():
    got, _total = _answer(ROWS, MORNING, hours=HOURS)
    assert "atclose" not in got, got


def test_a_shop_that_closes_when_the_band_opens_never_answers_it():
    got, _total = _answer(ROWS, MORNING, hours=HOURS)
    assert "edge" not in got, got


def test_a_row_that_states_no_hours_still_fails_the_window():
    got, _total = _answer(ROWS, MORNING, hours=HOURS)
    assert "shut" not in got, got


def test_a_row_that_trades_only_at_night_does_not_answer_the_morning_band():
    """The crossing row is open 22:00-02:00: it overlaps no part of 07:00-11:30, and reading the
    crossing as "open all day" would put every late-night shop in a morning answer."""
    got, _total = _answer(ROWS, MORNING, hours=HOURS)
    assert "night" not in got, got


def test_a_row_that_crosses_midnight_answers_the_night_band():
    """`late` opens 14:00 and trades until 22:00, so it is open inside the night band too - the
    window keeps both, and the shop that never trades in the night (`early`) is not here."""
    got, _total = _answer(ROWS, NIGHT, hours=HOURS)
    assert got == ["late", "night"], got


def test_an_offering_answers_the_band_of_its_shop():
    offerings = [
        {"subject_id": "o1", "merchant_id": "early", "id": "o1", "kind": "service", "name": "One",
         "name_zh": "一", "price_amount": 10.0, "category": "cafe", "subject_type": "offering"},
        {"subject_id": "o2", "merchant_id": "late", "id": "o2", "kind": "service", "name": "Two",
         "name_zh": "二", "price_amount": 20.0, "category": "cafe", "subject_type": "offering"},
    ]
    got, _total = _answer([], MORNING, hours=HOURS, offerings=offerings,
                          subject_types=("offering",))
    assert got == ["o1"], got


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
            for sentence in ("聽日朝早嘅咖啡店", "聽日中午嘅餐廳", "聽日晚黑嘅餐廳"):
                plan = S.plan_from_intent(extract_intent(sentence), query=sentence, now=NOW)
                pool = {}
                for name, backend in (("fixture", fixture), ("live", live)):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[name] = getattr(resp, "total_estimate", None)
                out["pools"][sentence] = pool
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_a_band_answers_the_same_pool_on_both_lanes(plane):
    """Measured after the fix (`tmp/d666_sets.py`, set equality too): 78/78 morning cafes, 174/174
    noon restaurants, 174/174 night restaurants."""
    pools = plane["pools"]
    morning = pools["聽日朝早嘅咖啡店"]
    assert morning["fixture"] == morning["live"] == 78, pools
    # the point at 07:00 answered 0 of 79: the whole cafe plane is inside the band
    assert morning["live"] > 0, pools
    noon = pools["聽日中午嘅餐廳"]
    assert noon["fixture"] == noon["live"] == 174, pools
    assert noon["live"] > 98, pools      # the 11:30 point answered 98 of 184
    night = pools["聽日晚黑嘅餐廳"]
    assert night["fixture"] == night["live"] == 174, pools
    assert 0 < night["live"] < plane["merchants"], (night, plane["merchants"])
