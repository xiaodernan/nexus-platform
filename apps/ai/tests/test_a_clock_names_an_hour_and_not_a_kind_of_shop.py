"""A clock names an hour, not a kind of shop.

`_PREFERENCE_CATEGORY_MAP` carried `("time_pref", "open_late") -> bar 0.8 / restaurant 0.5`, so the
one word a sentence used to say WHEN also voted for WHAT KIND of place it was - and 0.8 beat 0.5.
Measured on the published plane (`tmp/d701b.py`, `tmp/d701c.py`, 2026-11-06, 470 published
merchants, reference instant 11:00 HKT Thursday):

    request        category read      pool before   pool after
    深夜           bar                39            104 (every kind open 23:00-05:00)
    宵夜           bar                39            44  (the restaurants open in that window)
    食宵夜         bar                39            44
    深夜有咩食     bar                39            104
    深夜嘅餐廳     restaurant (named) 44            44  (unchanged - the word was already there)
    晚上嘅餐廳     restaurant (named) 184           184 (unchanged)

Two statements, one row. A TIME preference names no category: the kinds of shop that are open at
23:00 are the plane's answer, and the ranking lane already reads `time_pref/open_late` as the
`opens_late` attribute (`search/service.py:1309`), so nothing about the hour is lost. The two
SUPPER words are the exception and they are a MEAL, not a clock: 宵夜 / 夜宵 say food, and the food
bucket is read from the word itself (`SUPPER_CUES`, `nlu/lexicon.py`) after the band has taken the
hour - so 宵夜 keeps the 23:00-05:00 window and answers restaurants rather than bars.

What a named kind still does: 宵夜酒吧 is a bar and 宵夜咖啡店 a cafe, because the named word is
read first and the supper rule only fires where no category was named.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timezone

import pytest

from nexus_ai.nlu.understand import extract_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday

#: the words that name an hour and nothing else. D702 took 深夜有咩食 out of this list: the
#: MEAL word in that sentence (食) names food, and the corrected reading answers restaurants in
#: the window - the hour leg stays (test_the_bare_clock...below), the category does not.
CLOCK_WORDS = ["深夜", "夜晚", "open late", "late night"]


@pytest.mark.parametrize("word", CLOCK_WORDS)
def test_a_clock_names_no_category(word):
    assert extract_intent(word, {"now": NOW}).category is None, word


def test_a_named_kind_still_wins_over_the_clock():
    ex = extract_intent("深夜嘅酒吧", {"now": NOW})
    assert ex.category == "bar", ex.category


@pytest.mark.parametrize("word", ["宵夜", "夜宵", "食宵夜", "宵夜有咩食"])
def test_a_supper_is_a_meal_and_not_a_clock(word):
    ex = extract_intent(word, {"now": NOW})
    assert ex.category == "restaurant", (word, ex.category)
    assert ex.confidence["category"] < 0.95, ex.confidence


@pytest.mark.parametrize("sentence,kind", [("宵夜酒吧", "bar"), ("宵夜咖啡店", "cafe")])
def test_the_supper_rule_does_not_override_a_named_kind(sentence, kind):
    assert extract_intent(sentence, {"now": NOW}).category == kind, sentence


def test_the_supper_keeps_its_hour_while_it_learns_its_kind():
    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("宵夜", {"now": NOW}), query="宵夜", now=NOW)
    assert plan.filters.get("category") == "restaurant", plan.filters
    assert plan.filters.get("open_time") == time(23, 0), plan.filters
    assert plan.filters.get("open_until") == time(5, 0), plan.filters


def test_a_time_preference_is_not_a_category_hint():
    from nexus_ai.nlu.understand import IntentExtraction, _infer_category_from_signals

    ex = IntentExtraction(raw_query="x")
    ex.preferences = [{"key": "time_pref", "value": "open_late", "polarity": 1}]
    assert _infer_category_from_signals(ex) is None
    # the other preferences still vote: the rule is about the CLOCK, not the map
    ex2 = IntentExtraction(raw_query="x")
    ex2.preferences = [{"key": "ambience", "value": "lively", "polarity": 1}]
    assert _infer_category_from_signals(ex2) == ("bar", 0.5), _infer_category_from_signals(ex2)


def test_the_plan_of_a_bare_clock_carries_the_window_and_no_kind():
    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("深夜", {"now": NOW}), query="深夜", now=NOW)
    assert "category" not in plan.filters or not plan.filters.get("category"), plan.filters
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

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            live = Deps(st).backend()
            totals = {}
            for sentence in ("深夜", "宵夜", "深夜嘅餐廳", "晚上嘅餐廳", "酒吧"):
                plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                          query=sentence, now=NOW)
                _c, resp, _b, _s = await S.search(backend=live, plan=plan)
                totals[sentence] = getattr(resp, "total_estimate", None)
            window = await db.fetchval("""
                select count(distinct m.id) from merchants m
                where m.status = 'published'
                  and exists (select 1 from business_hours h
                              where h.merchant_id = m.id and h.weekday = 3
                                and (h.crosses_midnight = true OR h.closes_at > '23:00'::time
                                     OR h.opens_at < '05:00'::time))""")
            bars = await db.fetchval("""
                select count(distinct m.id) from merchants m
                where m.status = 'published'
                  and exists (select 1 from merchant_categories mc join categories c
                                on c.id = mc.category_id
                              left join categories pc on pc.id = c.parent_id
                              where mc.merchant_id = m.id
                                and (c.slug = 'bar' or pc.slug = 'bar'))""")
            restaurants = await db.fetchval("""
                select count(distinct m.id) from merchants m
                where m.status = 'published'
                  and exists (select 1 from merchant_categories mc join categories c
                                on c.id = mc.category_id
                              left join categories pc on pc.id = c.parent_id
                              where mc.merchant_id = m.id
                                and (c.slug = 'restaurant' or pc.slug = 'restaurant'))""")
            return {"totals": totals, "window": int(window), "bars": int(bars),
                    "restaurants": int(restaurants)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_bare_clock_answers_the_whole_window(plane):
    assert plane["totals"]["深夜"] == plane["window"], plane
    assert plane["totals"]["深夜"] > plane["bars"], plane


def test_the_supper_answers_the_food_in_that_window(plane):
    assert plane["totals"]["宵夜"] == plane["totals"]["深夜嘅餐廳"], plane
    assert plane["totals"]["宵夜"] < plane["totals"]["深夜"], plane


def test_the_named_requests_did_not_move(plane):
    assert plane["totals"]["晚上嘅餐廳"] == plane["restaurants"], plane
    assert plane["totals"]["酒吧"] == plane["bars"], plane
