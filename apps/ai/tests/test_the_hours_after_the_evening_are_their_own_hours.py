"""The hours after the evening are the hours after the evening.

深夜 and 宵夜 sat in the 18:00-23:00 band (`nlu/timeparse.py`), so 「深夜嘅餐廳」 asked for shops open
in the EVENING and answered every restaurant in the plane. Measured on the published plane
(`tmp/d699_bands.py`, `tmp/d699_measure2.py`, 2026-11-05, 470 published merchants):

    request             plan carried                 pool before    pool after
    深夜嘅餐廳          evening 18:00-23:00          184 (all)      44 of 184
    宵夜嘅餐廳          evening 18:00-23:00          184 (all)      44 - the same page as 深夜
    晚上嘅餐廳          evening 18:00-23:00          184            184 (unchanged)
    深夜 (no category)  evening                     470 (all)      39 (the time_pref names bars)

The two words name the hours AFTER the evening - the shops still open at eleven and later - which
is one window with two edges, 23:00 to 05:00. A band that crosses midnight is a shape neither lane
had: the plan dropped the far edge (`until > open_time`), and both readers only knew a same-day
window. The plan now carries both edges in either order, the fixture lane has the crossing twin of
its window test, and both SELECTs carry the crossing clause (`crosses_midnight OR closes_at > start
OR opens_at < until`), which is what 104 merchants of the plane meet.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timedelta, timezone

import pytest

from nexus_ai.nlu.timeparse import PART_OF_DAY, parse_time

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 1, 0, tzinfo=timezone.utc)   # Thursday 09:00 in Hong Kong


def _band(label):
    for name, tokens, start, end in PART_OF_DAY:
        if name == label:
            return tokens, start, end
    raise AssertionError(label)


@pytest.mark.parametrize("word", ["深夜", "宵夜", "夜宵", "半夜", "夜深"])
def test_the_hours_after_the_evening_are_their_own_band(word):
    tokens, start, end = _band("deep_night")
    assert word in tokens, (word, tokens)
    assert (start, end) == (time(23, 0), time(5, 0)), (start, end)
    assert word not in _band("night")[0], word


def test_the_evening_keeps_its_own_words():
    tokens, start, end = _band("night")
    for word in ("夜晚", "晚上", "今晚", "tonight"):
        assert word in tokens, word
    assert (start, end) == (time(18, 0), time(23, 0)), (start, end)


@pytest.mark.parametrize("word", ["凌晨"])
def test_the_small_hours_keep_their_own_band(word):
    tokens, start, end = _band("late_night")
    assert word in tokens, (word, tokens)
    assert (start, end) == (time(0, 0), time(5, 0)), (start, end)


def test_a_crossing_band_ends_on_the_next_day():
    parsed = parse_time("深夜嘅餐廳", now=NOW)
    assert parsed is not None
    assert parsed.type == "range" and parsed.quality == "deep_night", parsed
    assert parsed.starts_at.date() == NOW.date(), parsed.starts_at
    assert parsed.starts_at.hour == 23, parsed.starts_at
    assert parsed.ends_at.date() == parsed.starts_at.date().replace(day=parsed.starts_at.day + 1)
    assert parsed.ends_at.hour == 5, parsed.ends_at


def test_the_coming_night_is_tonight_and_not_tomorrows():
    # 09:00 in Hong Kong: the coming deep night begins tonight at 23:00. The old `end <= now` roll
    # put it on TOMORROW because the far edge (05:00) was already behind the clock.
    parsed = parse_time("深夜", now=NOW)
    assert parsed.starts_at.date() == NOW.date(), parsed.starts_at
    inside = datetime(2026, 11, 5, 17, 0, tzinfo=timezone.utc)   # 01:00 on the 6th, in Hong Kong
    hk = timezone(timedelta(hours=8))
    parsed = parse_time("深夜", now=inside)
    assert parsed.starts_at.date() == (inside.astimezone(hk).date() - timedelta(days=1)), parsed
    assert parsed.starts_at.hour == 23 and parsed.ends_at.hour == 5, parsed


def test_the_plan_carries_both_edges_of_the_crossing_band():
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("深夜嘅餐廳", {"now": NOW}),
                              query="深夜嘅餐廳", now=NOW)
    assert plan.filters.get("open_time") == time(23, 0), plan.filters
    assert plan.filters.get("open_until") == time(5, 0), plan.filters
    assert plan.filters.get("open_weekday") is not None, plan.filters


def test_a_clock_inside_the_deep_night_is_still_an_evening_clock():
    # the meridiem rule the old night band gave 深夜 must survive the move: 深夜十一點 is 23:00
    parsed = parse_time("深夜十一點嘅餐廳", now=NOW)
    assert parsed is not None
    assert parsed.type == "explicit", parsed
    assert parsed.starts_at.hour == 23, parsed.starts_at


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "restaurant", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, opens, closes, *, crosses=False, weekday=3):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


ROWS = [_row("dinner"), _row("late"), _row("crossing"), _row("dawn"), _row("lunch")]
#: every row trades both days the legs ask about: Thursday (the coming deep night) and Friday (the
#: coming small hours, which begin at midnight tomorrow).
_SPAN = [((11, 30), (22, 0), False), ((11, 30), (23, 30), False),
         ((18, 0), (1, 30), True), ((4, 0), (14, 0), False), ((12, 0), (15, 0), False)]
HOURS = [_hours(name, opens, closes, crosses=crosses, weekday=day)
         for day in (3, 4)
         for name, (opens, closes, crosses) in zip(
             ("dinner", "late", "crossing", "dawn", "lunch"), _SPAN)]


def _answer(sentence):
    import asyncio

    import nexus_ai.search.service as S
    from nexus_ai.nlu.understand import extract_intent

    plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}), query=sentence, now=NOW)
    _c, _resp, _b, scored = asyncio.run(
        S.search(backend=S.StaticBackend(merchants=ROWS, hours=HOURS), plan=plan))
    return sorted(s.candidate.subject_id for s in scored)


def test_the_fixture_lane_keeps_only_the_shops_open_after_eleven():
    assert _answer("深夜嘅餐廳") == ["crossing", "dawn", "late"], _answer("深夜嘅餐廳")
    assert _answer("宵夜嘅餐廳") == _answer("深夜嘅餐廳")


def test_the_evening_still_answers_its_own_shops():
    assert _answer("晚上嘅餐廳") == ["crossing", "dinner", "late"], _answer("晚上嘅餐廳")


def test_the_small_hours_are_unchanged():
    assert _answer("凌晨嘅餐廳") == ["crossing", "dawn"], _answer("凌晨嘅餐廳")


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            live = Deps(st).backend()
            pages = {}
            for sentence in ("深夜嘅餐廳", "宵夜嘅餐廳", "晚上嘅餐廳", "聽日深夜嘅餐廳"):
                plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                          query=sentence, now=NOW)
                _c, resp, _b, scored = await S.search(backend=live, plan=plan)
                pages[sentence] = (getattr(resp, "total_estimate", None),
                                   sorted(str(getattr(s, "subject_id", "")) for s in scored))
            deep = await db.fetchval("""
                select count(distinct m.id) from merchants m
                join merchant_categories mc on mc.merchant_id = m.id
                join categories c on c.id = mc.category_id
                left join categories pc on pc.id = c.parent_id
                where m.status = 'published' and (c.slug = 'restaurant' or pc.slug = 'restaurant')
                  and exists (select 1 from business_hours h
                              where h.merchant_id = m.id and h.weekday = 3
                                and (h.crosses_midnight = true OR h.closes_at > '23:00'::time
                                     OR h.opens_at < '05:00'::time))""")
            evening = await db.fetchval("""
                select count(distinct m.id) from merchants m
                join merchant_categories mc on mc.merchant_id = m.id
                join categories c on c.id = mc.category_id
                left join categories pc on pc.id = c.parent_id
                where m.status = 'published' and (c.slug = 'restaurant' or pc.slug = 'restaurant')""")
            from nexus_ai.search.service import SearchPlan

            offering_plan = SearchPlan(query_text="",
                                       filters={"open_weekday": 3, "open_time": time(23, 0),
                                                "open_until": time(5, 0)},
                                       subject_types=("offering",), limit=60)
            _c, oresp, _b, _os = await S.search(backend=live, plan=offering_plan)
            offerings = await db.fetchval("""
                select count(*) from offerings o join merchants m on m.id = o.merchant_id
                where o.status = 'active' and m.status = 'published'
                  and exists (select 1 from business_hours h
                              where h.merchant_id = m.id and h.weekday = 3
                                and (h.crosses_midnight = true OR h.closes_at > '23:00'::time
                                     OR h.opens_at < '05:00'::time))""")
            return {"pages": pages, "deep": int(deep), "evening": int(evening),
                    "offerings": int(offerings),
                    "offering_answer": getattr(oresp, "total_estimate", None)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_live_plane_answers_the_shops_that_are_still_open(plane):
    total, ids = plane["pages"]["深夜嘅餐廳"]
    assert total == plane["deep"], (total, plane["deep"])
    assert 0 < total < plane["evening"], (total, plane["evening"])


def test_the_two_words_answer_one_page(plane):
    assert plane["pages"]["深夜嘅餐廳"] == plane["pages"]["宵夜嘅餐廳"], plane["pages"]


def test_the_evening_did_not_move(plane):
    total, _ids = plane["pages"]["晚上嘅餐廳"]
    assert total == plane["evening"], (total, plane["evening"])


def test_tomorrows_deep_night_is_pinned_to_tomorrow():
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("聽日深夜嘅餐廳", {"now": NOW}),
                              query="聽日深夜嘅餐廳", now=NOW)
    assert plan.filters.get("open_weekday") == 4, plan.filters      # Thursday -> Friday
    assert plan.filters.get("open_time") == time(23, 0), plan.filters
    assert plan.filters.get("open_until") == time(5, 0), plan.filters


def test_the_offering_lane_reads_the_same_window(plane):
    assert plane["offering_answer"] == plane["offerings"], (plane["offering_answer"],
                                                            plane["offerings"])
    assert plane["offerings"] > 0, plane
