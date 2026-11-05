"""The word that says UNTIL was read as a clock on the day.

`OPEN_LATE_CUES` (`nlu/timeparse.py:62-63`) is the table of words that turn a clock into a closing
time - it knows 營業到, 還營業, 開住, 營業中, `open at`, `open until` - and it did not know 開到, the
most ordinary Cantonese spelling of the same request, nor 開至 / 營業至, nor the English "till". So
「開到晚上九點半」 was answered as a WINDOW STARTING at 21:30, `starts_at` and all, and 「開到九點半」
as a window at 09:30. Measured on the published plane (`tmp/d662_probe.py`, `tmp/d662_after.py`):

    sentence                          before                                after
    開到晚上九點半                    explicit window, starts 21:30          late=21:30, no window
    開至九點半                        explicit window, starts 09:30          late=09:30
    營業至九點半                      explicit window, starts 09:30          late=09:30
    open till 6:30pm                  explicit window, starts 18:30          late=18:30
    開到晚上九點半嘅餐廳 (pool)      13 of 184 restaurants                  184 (all, both lanes)

13 is "restaurants open at 21:30" - the wrong question, asked of a sentence that named when the
kitchen closes. The cue table is the ONE source (D463/D475): the spellings are added THERE, and the
gate takes its parameters from the table, so the next spelling is a row rather than a new branch.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timezone

import pytest

from nexus_ai.nlu.timeparse import OPEN_LATE_CUES, parse_time

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)   # Wednesday 09:00 in Hong Kong

#: the spellings the product's own vocabulary uses for "open until", in both scripts
UNTIL_CJK = ("開到", "開至", "營業至")
UNTIL_LATIN = ("open till", "open til", "open thru")


@pytest.mark.parametrize("spelling", UNTIL_CJK + UNTIL_LATIN)
def test_the_table_names_every_spelling_of_until(spelling):
    assert spelling in OPEN_LATE_CUES, (spelling, OPEN_LATE_CUES)


@pytest.mark.parametrize("spelling", UNTIL_CJK)
def test_a_cantonese_until_is_a_closing_time_and_not_a_window(spelling):
    # D698 re-aimed this leg: 九點半 is a CLOSING hour, so it is 21:30 (the evening reading of a
    # bare closing clock) - the 09:30 this leg used to pin was the twelve-hour default that made
    # the filter keep the whole plane. The morning spelling keeps its own reading: see
    # `test_a_shop_open_until_ten_is_open_until_ten_pm.py`.
    parsed = parse_time(spelling + "九點半", now=NOW)
    assert parsed is not None, spelling
    assert parsed.quality == "open_late_after:2130", (spelling, parsed.quality)
    assert parsed.starts_at is None and parsed.ends_at is None, (spelling, parsed)


@pytest.mark.parametrize("spelling", UNTIL_LATIN)
def test_an_english_until_is_a_closing_time_and_not_a_window(spelling):
    parsed = parse_time(spelling + " 6:30pm", now=NOW)
    assert parsed is not None, spelling
    assert parsed.quality == "open_late_after:1830", (spelling, parsed.quality)
    assert parsed.starts_at is None and parsed.ends_at is None, (spelling, parsed)


def test_the_bare_until_word_with_no_clock_states_no_time():
    for spelling in UNTIL_CJK:
        assert parse_time(spelling, now=NOW) is None, spelling


def test_the_plan_asks_for_the_closing_clock_the_sentence_named():
    from nexus_ai.nlu.understand import extract_intent

    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("開到晚上九點半"), query="開到晚上九點半", now=NOW)
    assert plan.at is None, plan.at
    assert plan.open_late_after == time(21, 30), plan.open_late_after
    assert plan.filters.get("min_closing_hour") == time(21, 30), plan.filters


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    import nexus_ai.search.service as S

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

            live = Deps(st).backend()
            pools = {}
            for sentence in ("開到晚上九點半嘅餐廳", "營業到晚上九點半嘅餐廳"):
                plan = S.plan_from_intent(extract_intent(sentence), query=sentence, now=NOW)
                for name, backend in (
                    ("fixture", S.StaticBackend(merchants=merchants, hours=hours)),
                    ("live", live),
                ):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pools[(sentence, name)] = getattr(resp, "total_estimate", None)
            return {"merchants": len(merchants), "pools": pools}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_two_spellings_of_one_closing_time_answer_one_pool(plane):
    pools = plane["pools"]
    answers = list(pools.values())
    assert answers[0] == answers[1], pools
    assert answers[0] == answers[2] == answers[3], pools
    assert 0 < answers[0] < plane["merchants"], (answers, plane["merchants"])
