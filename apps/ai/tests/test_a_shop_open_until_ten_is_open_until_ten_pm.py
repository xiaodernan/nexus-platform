"""A shop open until ten is open until ten at NIGHT.

`OPEN_LATE_CUES` (`nlu/timeparse.py`) turns a clock into a closing time, but the clock itself was
still read by the twelve-hour default: 「開到十點」 asked for a closing time of TEN IN THE MORNING.
Every shop closes at or after 10:00, so the filter kept the whole published plane - the sentence
narrowed nothing. Measured on the published plane (`tmp/d698_until.py`, `tmp/d698_pairs.py`, 470
published merchants), before this unit:

    request                 plan carried   pool
    開到九點                late=09:00     470 of 470  (the whole plane)
    開到十點                late=10:00     470 of 470
    開到十一點              late=11:00     470 of 470
    開到晚上九點            late=21:00     285
    開到晚上十點            late=22:00     266
    開到晚上十一點          late=23:00     221
    開到十二點              late=12:00     470        (midnight read as noon)

After: the bare spelling and the marked spelling of one closing time answer the SAME page - 285,
266, 221 - and 「開到十二點」 answers the 103 shops still open on the day's last minute (23:59,
because a `time` cannot name midnight and 00:00 is met by every shop). The morning keeps its own
words: 「開到朝早十點」 still closes at 10:00 and still answers the plane (the correct answer to
"open until ten in the morning").

The tables are split rather than the rule widened: UNTIL and AFTER name a CLOSING hour, while
"still open" / "open at" name a MOMENT at which the shop is open - a moment keeps the clock's own
half. 「開到十二點半」 (00:30 the next morning) is filed, not guessed.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timezone

import pytest

from nexus_ai.nlu.timeparse import (OPEN_LATE_CUES, OPEN_NOW_CUES, OPEN_UNTIL_CUES,
                                    parse_time)

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 1, 0, tzinfo=timezone.utc)   # Thursday 09:00 in Hong Kong


@pytest.mark.parametrize("spelling", ["開到", "開至", "營業到", "營業至", "open until", "open till"])
def test_the_closing_cues_are_the_ones_that_name_a_closing_hour(spelling):
    assert spelling in OPEN_UNTIL_CUES, (spelling, OPEN_UNTIL_CUES)
    assert spelling in OPEN_LATE_CUES, (spelling, OPEN_LATE_CUES)


@pytest.mark.parametrize("spelling", ["open at", "still open", "營業中", "開住"])
def test_the_moment_cues_are_not_read_as_a_closing_hour(spelling):
    assert spelling in OPEN_NOW_CUES, (spelling, OPEN_NOW_CUES)
    assert spelling not in OPEN_UNTIL_CUES, (spelling, OPEN_UNTIL_CUES)


@pytest.mark.parametrize("sentence,quality", [
    ("開到九點", "open_late_after:2100"),
    ("開到十點", "open_late_after:2200"),
    ("開到十一點", "open_late_after:2300"),
    ("開到十點半", "open_late_after:2230"),
])
def test_a_bare_closing_clock_is_an_evening_clock(sentence, quality):
    parsed = parse_time(sentence, now=NOW)
    assert parsed is not None
    assert parsed.quality == quality, (sentence, parsed.quality)
    assert parsed.starts_at is None and parsed.ends_at is None, parsed


@pytest.mark.parametrize("spelling", ["開到", "開至", "營業到", "營業至"])
@pytest.mark.parametrize("hour,quality", [("九點", "2100"), ("十點", "2200"),
                                          ("十一點", "2300")])
def test_every_spelling_of_until_reads_the_same_clock(spelling, hour, quality):
    parsed = parse_time(spelling + hour, now=NOW)
    assert parsed is not None
    assert parsed.quality == "open_late_after:" + quality, (spelling, parsed.quality)


@pytest.mark.parametrize("sentence,quality", [
    ("開到朝早十點", "open_late_after:1000"),
    ("開到早上七點", "open_late_after:0700"),
    ("開到朝早九點半", "open_late_after:0930"),
    ("開到下午三點", "open_late_after:1500"),
])
def test_a_part_of_day_still_wins_over_the_evening_default(sentence, quality):
    parsed = parse_time(sentence, now=NOW)
    assert parsed is not None
    assert parsed.quality == quality, (sentence, parsed.quality)


@pytest.mark.parametrize("sentence", ["開到十二點", "開到晚上十二點", "開到午夜十二點", "開到零點"])
def test_twelve_o_clock_is_the_end_of_the_day(sentence):
    parsed = parse_time(sentence, now=NOW)
    assert parsed is not None
    assert parsed.quality == "open_late_after:2359", (sentence, parsed.quality)


def test_an_explicit_pm_is_left_alone():
    parsed = parse_time("open until 10pm", now=NOW)
    assert parsed is not None
    assert parsed.quality == "open_late_after:2200", parsed.quality


def test_the_plan_asks_the_database_for_ten_at_night():
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("開到十點"), query="開到十點", now=NOW)
    assert plan.at is None, plan.at
    assert plan.open_late_after == time(22, 0), plan.open_late_after
    assert plan.filters.get("min_closing_hour") == time(22, 0), plan.filters


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": 4.2,
           "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _hours(mid, closes, *, opens=(11, 30), crosses=False, weekday=3):
    return {"merchant_id": mid, "weekday": weekday, "opens_at": time(*opens),
            "closes_at": time(*closes), "crosses_midnight": crosses}


def test_the_fixture_lane_drops_the_shop_that_shuts_at_ten_in_the_morning():
    sentences = ("開到十點", "開到朝早十點")
    rows = [_row("morning"), _row("late"), _row("midnight")]
    hours = [_hours("morning", (10, 30)), _hours("late", (22, 30)),
             _hours("midnight", (1, 30), opens=(18, 0), crosses=True)]
    import asyncio

    import nexus_ai.search.service as S
    from nexus_ai.nlu.understand import extract_intent

    answers = {}
    for sentence in sentences:
        plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}), query=sentence, now=NOW)
        _c, _resp, _b, scored = asyncio.run(
            S.search(backend=S.StaticBackend(merchants=rows, hours=hours), plan=plan))
        answers[sentence] = sorted(s.candidate.subject_id for s in scored)
    # the crossing shop is open past midnight, so it is open at 22:00 as well - the rule both
    # lanes share. The row the EVENING reading removes is the one that shuts at 10:30 am.
    assert answers["開到十點"] == ["late", "midnight"], answers
    assert answers["開到朝早十點"] == ["late", "midnight", "morning"], answers


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
        await db_pool.connect(st, force_new=True)
        try:
            live = Deps(st).backend()
            out = {}
            for bare, marked in (("開到九點", "開到晚上九點"),
                                 ("開到十點", "開到晚上十點"),
                                 ("開到十一點", "開到晚上十一點"),
                                 ("開到十二點", "開到晚上十二點"),
                                 ("營業到十點", "營業到晚上十點")):
                for tag, sentence in (("bare", bare), ("marked", marked)):
                    plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                              query=sentence, now=NOW)
                    _c, resp, _b, scored = await S.search(backend=live, plan=plan)
                    out[(bare, tag)] = (getattr(resp, "total_estimate", None),
                                        sorted(str(getattr(s, "subject_id", "")) for s in scored))
            total = await (await db_pool.connect(st, force_new=True)).fetchval(
                "select count(*) from merchants where status = 'published'")
            return {"answers": out, "plane": int(total)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.parametrize("bare,marked", [
    ("開到九點", "開到晚上九點"),
    ("開到十點", "開到晚上十點"),
    ("開到十一點", "開到晚上十一點"),
    ("開到十二點", "開到晚上十二點"),
    ("營業到十點", "營業到晚上十點"),
])
def test_the_two_spellings_of_one_closing_time_answer_one_page(plane, bare, marked):
    answers = plane["answers"]
    assert answers[(bare, "bare")] == answers[(bare, "marked")], (bare, answers)
    assert 0 < answers[(bare, "bare")][0] < plane["plane"], (bare, answers[(bare, "bare")])
