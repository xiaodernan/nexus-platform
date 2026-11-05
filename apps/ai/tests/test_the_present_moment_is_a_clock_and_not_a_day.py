"""The present moment is a clock, and a day is not.

`而家` / `現在` / `现在` / `now` sat in `TODAY_TOKENS`, so 「而家開嘅餐廳」 was read as the DAY it is asked on
(`all_day`, the 09:00-23:00 convention) and D665 then correctly refused to ask the database for nine
o'clock, because a DAY is not a clock. Between the two correct rules the request lost its hour: the
plan carried `open_now=True`, neither lane read it, and the answer was every restaurant in the plane.
Measured on the published plane (`tmp/d701_opennow.py`, `tmp/d701_after.py`, Thursday 2026-11-05):

    request            09:00 HK                     20:00 HK
    而家開嘅餐廳       184 of 184 -> 14              184 (all restaurants are open at eight)
    現在營業嘅餐廳     184 -> 14, the same page      184
    而家 (bare)        470 -> 123                   470 -> 316
    今日嘅餐廳         184 -> 184 (unchanged: a DAY still names no hour, D665)

The words that name the PRESENT are their own table now, and the lane answers them with the instant
the request was asked at (`ParsedTime("explicit", now, ...)`, quality `now`): the existing readers turn
that into `open_weekday` + `open_time`, the clause a named clock has always used, so both lanes filter
by construction. The cue also joins the strip tables - a cue the lane READ must leave the match text.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timedelta, timezone

import pytest

from nexus_ai.nlu.timeparse import NOW_TOKENS, TODAY_TOKENS, parse_time

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
MORNING = datetime(2026, 11, 5, 1, 0, tzinfo=timezone.utc)    # Thursday 09:00 in Hong Kong
EVENING = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)   # Thursday 20:00 in Hong Kong


def test_the_present_moment_is_not_a_day_word():
    for word in ("而家", "依家", "現在", "现在", "now"):
        assert word in NOW_TOKENS, (word, NOW_TOKENS)
        assert word not in TODAY_TOKENS, (word, TODAY_TOKENS)
    for word in ("今日", "今天", "today"):
        assert word in TODAY_TOKENS and word not in NOW_TOKENS, word


@pytest.mark.parametrize("sentence", ["而家開嘅餐廳", "現在營業嘅餐廳", "依家開緊嘅咖啡店",
                                      "open now cafe"])
def test_the_present_moment_parses_as_the_current_instant(sentence):
    parsed = parse_time(sentence, now=MORNING)
    assert parsed is not None, sentence
    assert parsed.type == "explicit" and parsed.quality == "now", parsed
    assert parsed.starts_at == MORNING, parsed.starts_at
    assert parsed.ends_at == MORNING + timedelta(hours=2), parsed


@pytest.mark.parametrize("sentence", ["今日嘅餐廳", "聽日嘅餐廳", "今晚嘅餐廳"])
def test_a_day_or_a_band_is_still_not_the_present_moment(sentence):
    parsed = parse_time(sentence, now=MORNING)
    assert parsed is not None, sentence
    assert parsed.quality != "now", parsed


def test_the_plan_asks_for_the_hour_it_is_asked_at():
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("而家開嘅餐廳", {"now": MORNING}),
                              query="而家開嘅餐廳", now=MORNING)
    assert plan.filters.get("open_time") == time(9, 0), plan.filters
    assert plan.filters.get("open_weekday") == 3, plan.filters      # Thursday
    assert plan.open_now is True, plan


def test_the_cue_that_was_read_leaves_the_match_text():
    from nexus_ai.nlu.understand import match_core

    left = match_core("而家開嘅餐廳", strip_time=True, strip_surfaces=("餐廳",))
    assert left == "開", left
    assert match_core("而家", strip_time=True) == "", match_core("而家", strip_time=True)


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "restaurant", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, opens, closes, *, crosses=False, weekday=3):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


ROWS = [_row("breakfast"), _row("dinner"), _row("allnight")]
HOURS = [_hours("breakfast", (8, 0), (10, 0)),
         _hours("dinner", (18, 0), (22, 0)),
         _hours("allnight", (18, 0), (1, 0), crosses=True)]


def _answer(sentence, now):
    import asyncio

    import nexus_ai.search.service as S
    from nexus_ai.nlu.understand import extract_intent

    plan = S.plan_from_intent(extract_intent(sentence, {"now": now}), query=sentence, now=now)
    _c, _resp, _b, scored = asyncio.run(
        S.search(backend=S.StaticBackend(merchants=ROWS, hours=HOURS), plan=plan))
    return sorted(s.candidate.subject_id for s in scored)


def test_the_fixture_lane_answers_the_shops_open_at_this_hour():
    assert _answer("而家開嘅餐廳", MORNING) == ["breakfast"], _answer("而家開嘅餐廳", MORNING)
    assert _answer("而家開嘅餐廳", EVENING) == ["allnight", "dinner"], _answer("而家開嘅餐廳", EVENING)


def test_a_named_day_still_answers_every_shop_that_trades_it():
    assert _answer("今日嘅餐廳", MORNING) == ["allnight", "breakfast", "dinner"], _answer(
        "今日嘅餐廳", MORNING)


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
            for label, now in (("morning", MORNING), ("evening", EVENING)):
                for sentence in ("而家開嘅餐廳", "現在營業嘅餐廳", "今日嘅餐廳", "而家"):
                    plan = S.plan_from_intent(extract_intent(sentence, {"now": now}),
                                              query=sentence, now=now)
                    _c, resp, _b, scored = await S.search(backend=live, plan=plan)
                    pages[(label, sentence)] = (
                        getattr(resp, "total_estimate", None),
                        sorted(str(getattr(s, "subject_id", "")) for s in scored))

            def _open_at(clock):
                row = """select count(*) from merchants m where m.status = 'published'
                    and exists (select 1 from business_hours h
                                where h.merchant_id = m.id and h.weekday = 3
                                  and ((h.crosses_midnight = false and h.opens_at <= $1::time
                                        and h.closes_at > $1::time)
                                    or (h.crosses_midnight = true and (h.opens_at <= $1::time
                                        or h.closes_at > $1::time))))"""
                row_r = """select count(distinct m.id) from merchants m
                    join merchant_categories mc on mc.merchant_id = m.id
                    join categories c on c.id = mc.category_id
                    left join categories pc on pc.id = c.parent_id
                    where m.status = 'published' and (c.slug = 'restaurant' or pc.slug = 'restaurant')
                      and exists (select 1 from business_hours h
                                  where h.merchant_id = m.id and h.weekday = 3
                                    and ((h.crosses_midnight = false and h.opens_at <= $1::time
                                          and h.closes_at > $1::time)
                                      or (h.crosses_midnight = true and (h.opens_at <= $1::time
                                          or h.closes_at > $1::time))))"""
                return int(db.fetchval(row, clock)), int(db.fetchval(row_r, clock))

            async def both(clock):
                return (await db.fetchval(
                    """select count(*) from merchants m where m.status = 'published'
                       and exists (select 1 from business_hours h
                                   where h.merchant_id = m.id and h.weekday = 3
                                     and ((h.crosses_midnight = false and h.opens_at <= $1::time
                                           and h.closes_at > $1::time)
                                       or (h.crosses_midnight = true and (h.opens_at <= $1::time
                                           or h.closes_at > $1::time))))""", clock),
                    await db.fetchval(
                    """select count(distinct m.id) from merchants m
                       join merchant_categories mc on mc.merchant_id = m.id
                       join categories c on c.id = mc.category_id
                       left join categories pc on pc.id = c.parent_id
                       where m.status = 'published'
                         and (c.slug = 'restaurant' or pc.slug = 'restaurant')
                         and exists (select 1 from business_hours h
                                     where h.merchant_id = m.id and h.weekday = 3
                                       and ((h.crosses_midnight = false and h.opens_at <= $1::time
                                             and h.closes_at > $1::time)
                                         or (h.crosses_midnight = true and (h.opens_at <= $1::time
                                             or h.closes_at > $1::time))))""", clock))

            return {"pages": pages,
                    "morning": await both(time(9, 0)),
                    "evening": await both(time(20, 0))}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_live_plane_answers_the_shops_open_at_this_hour(plane):
    plane_all, plane_rest = plane["morning"]
    total, _ids = plane["pages"][("morning", "而家開嘅餐廳")]
    assert total == plane_rest, (total, plane_rest)
    assert 0 < total < 184, total
    assert plane["pages"][("morning", "而家")][0] == plane_all, (
        plane["pages"][("morning", "而家")][0], plane_all)


def test_the_same_question_at_eight_answers_the_shops_open_then(plane):
    total, _ids = plane["pages"][("evening", "而家開嘅餐廳")]
    assert total == plane["evening"][1], (total, plane["evening"])
    assert total > plane["pages"][("morning", "而家開嘅餐廳")][0], plane["pages"]


def test_the_two_spellings_of_now_answer_one_page(plane):
    assert plane["pages"][("morning", "而家開嘅餐廳")] == \
        plane["pages"][("morning", "現在營業嘅餐廳")], plane["pages"]


def test_a_day_is_still_not_an_hour(plane):
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("今日嘅餐廳", {"now": MORNING}),
                              query="今日嘅餐廳", now=MORNING)
    assert plan.filters.get("open_time") is None, plan.filters     # D665: a DAY names no hour
    assert plan.filters.get("open_weekday") == 3, plan.filters
    total, _ids = plane["pages"][("morning", "今日嘅餐廳")]
    assert total > plane["pages"][("morning", "而家開嘅餐廳")][0], plane["pages"]
