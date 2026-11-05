"""An ask to stay open all night names the night.

通宵 and 24小時 are two spellings of the same request: the shops still open through the night. They
were in NO band at all, so the sentence carried no window - and because 通宵 also sits in the
`time_pref/open_late` row, the engine answered the plane ordered by rating. Measured on the published
plane (`tmp/d703_before.py`, 11:00 HKT Thursday, 470 published merchants):

    request               before                          after
    通宵                  470, the cue in the match text   104 (every kind open 23:00-05:00)
    通宵營業              470                              104
    24小時                470                              104
    24小時餐廳            184 (all restaurants)            44  (the restaurants in that window)
    24小時營業嘅餐廳      184                              44
    通宵嘅餐廳            184                              44
    overnight             439 on the EVENING band         104
    all night             439 on the EVENING band         104
    今晚 / tonight        184, evening 18:00-23:00        184 (unchanged)

`overnight` was in the evening band (18:00-23:00) - the hours BEFORE the night it names - and
"all night" fell to "night" for the same reason. Both are in the deep-night band now; the longest cue
wins in `_find_part`, so "all night" beats "night" without taking 今晚 or tonight away from the evening.

24小時 is read as this WINDOW and not as a predicate of its own: a shop open at every hour is open at
three in the morning, and the corpus has no 24-hour attribute to ask - `business_hours` is the only
writer (21 merchants carry a 00:00-23:59 zone, measured `tmp/d703_census.py`). The reading is a proxy
and it is stated as one: it answers shops that are open in the small hours, which is what a 24-hour ask
is asking for at 03:00, and it does not claim the row is open at noon.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timedelta, timezone

import pytest

from nexus_ai.nlu.timeparse import PART_OF_DAY, parse_time

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday

#: the spellings the TABLE must carry. The simplified forms 24小时 / 24小时营业 are absent on
#: purpose: `nlu/canonical` rewrites every table at import (measured: the tuple holds 24小時 where
#: the source writes 24小时), so the Simplified user is answered by the canonical form - and the
#: parse leg below is what pins that they are.
ALL_NIGHT = ["通宵", "通宵營業", "24小時", "24h", "24 hours", "open 24",
             "all night", "overnight"]

#: spellings that must PARSE, whether the table spells them or the canonicaliser does
ALL_NIGHT_SPELLINGS = ALL_NIGHT + ["24小时", "24小时营业"]


def _band(label):
    for name, tokens, start, end in PART_OF_DAY:
        if name == label:
            return tokens, start, end
    raise AssertionError(label)


@pytest.mark.parametrize("word", ALL_NIGHT)
def test_the_word_is_in_the_deep_night_band(word):
    tokens, start, end = _band("deep_night")
    assert word in tokens, (word, tokens)
    assert (start, end) == (time(23, 0), time(5, 0)), (start, end)


@pytest.mark.parametrize("word", ["overnight", "all night"])
def test_the_phrase_is_no_longer_the_evening(word):
    assert word not in _band("night")[0], _band("night")[0]


def test_the_evening_keeps_its_own_words():
    tokens, start, end = _band("night")
    for word in ("今晚", "tonight", "夜晚"):
        assert word in tokens, word
    assert (start, end) == (time(18, 0), time(23, 0)), (start, end)


@pytest.mark.parametrize("word", ALL_NIGHT_SPELLINGS)
def test_the_word_parses_as_the_crossing_window(word):
    parsed = parse_time(word, now=NOW)
    assert parsed is not None, word
    assert parsed.type == "range" and parsed.quality == "deep_night", (word, parsed)
    assert parsed.starts_at.hour == 23, (word, parsed.starts_at)
    assert parsed.ends_at.hour == 5, (word, parsed.ends_at)
    assert parsed.starts_at.date() == NOW.date(), (word, parsed.starts_at)


def test_all_night_is_not_read_as_the_evening_night():
    # the longest cue wins: "night" would answer 18:00 and the phrase answers 23:00
    assert parse_time("all night", now=NOW).starts_at.hour == 23
    assert parse_time("tonight", now=NOW).starts_at.hour == 18


@pytest.mark.parametrize("sentence", ["通宵", "24小時", "通宵營業"])
def test_the_plan_carries_the_window_and_not_the_word(sentence):
    import nexus_ai.search.service as S
    from nexus_ai.nlu.understand import extract_intent

    plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}), query=sentence, now=NOW)
    assert plan.filters.get("open_time") == time(23, 0), plan.filters
    assert plan.filters.get("open_until") == time(5, 0), plan.filters
    assert plan.filters.get("open_weekday") is not None, plan.filters
    assert not (plan.match_text or "").strip(), plan.match_text


@pytest.mark.parametrize("sentence", ["24小時餐廳", "通宵嘅餐廳", "24小時營業嘅餐廳"])
def test_the_named_kind_keeps_its_door_and_gets_the_hour(sentence):
    import nexus_ai.search.service as S
    from nexus_ai.nlu.understand import extract_intent

    plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}), query=sentence, now=NOW)
    assert plan.filters.get("category") == "restaurant", plan.filters
    assert plan.filters.get("open_time") == time(23, 0), plan.filters
    assert plan.filters.get("open_until") == time(5, 0), plan.filters


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    import nexus_ai.search.service as S
    from nexus_ai.nlu.understand import extract_intent

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            live = Deps(st).backend()
            totals = {}
            for sentence in ("通宵", "24小時", "overnight", "深夜", "24小時餐廳", "深夜嘅餐廳",
                             "今晚嘅餐廳"):
                plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                          query=sentence, now=NOW)
                _c, resp, _b, _s = await S.search(backend=live, plan=plan)
                totals[sentence] = getattr(resp, "total_estimate", None)
            everything = await db.fetchval(
                "select count(*) from merchants where status = 'published'")
            return {"totals": totals, "everything": int(everything)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.parametrize("sentence", ["通宵", "24小時", "overnight"])
def test_the_three_spellings_answer_the_one_night(plane, sentence):
    assert plane["totals"][sentence] == plane["totals"]["深夜"], (sentence, plane["totals"])
    assert 0 < plane["totals"][sentence] < plane["everything"], (sentence, plane["totals"])


@pytest.mark.parametrize("sentence", ["24小時餐廳"])
def test_the_named_kind_answers_the_food_in_that_night(plane, sentence):
    assert plane["totals"][sentence] == plane["totals"]["深夜嘅餐廳"], (sentence, plane["totals"])
    assert plane["totals"][sentence] < plane["totals"]["今晚嘅餐廳"], (sentence, plane["totals"])
