"""D677 - "lunch service" is a meal occasion, not a clock: 「午市套餐」 is not 11:30.

`PART_OF_DAY` carried 午市 as the noon cue, so 「午市套餐」 (a lunch set) and 「午市有冇好食」
(is there good lunch-time fare?) were served for the pool that is open at 11:30-14:30 on the
day asked - every row outside it answered nothing, including the rows that carry the word. The
corpus was measured: **115 of the 470 published merchants carry 午市** in their own text, all of
it their own lunch sets - the word is an occasion, and no row intends "open at 11:30" by writing
it. The noon the product DOES want to read has its own cues: 中午 / 正午 / lunch / luncheon /
noon / midday - those are untouched by this unit.

The decision, the one D630 made for the category table: a meal-occasion word is neither content
(the strip takes it, as D634's pinned gate demands) nor a filter (it narrows nothing). It is
**understood and constrains nothing**.

What this unit did not touch, said rather than implied:
- English `lunch` stays the noon cue (`lunch`, `luncheon`): the filed sentences are Chinese and
  the English word is a genuine clock reading for English speakers.
- the 115 rows stay unmatchable on the word, exactly as D634 left them - the pinned pair
  `午市套餐 -> 套餐`, `午市嘅餐廳 -> 餐廳` survives unchanged.
- `apps/web`'s mock mirrors the old table and belongs to the web lane; it will drift until that
  lane touches it, and is filed rather than edited here.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone, time

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu.understand import extract_intent, match_core

NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)   # Wednesday 09:00 in Hong Kong

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")


def _plan(text: str):
    return S.plan_from_intent(extract_intent(text, {"now": NOW}), query=text, now=NOW)


def test_a_lunch_set_asks_for_no_hour():
    plan = _plan("午市套餐")
    assert "open_time" not in plan.filters, plan.filters
    assert "open_weekday" not in plan.filters, plan.filters
    assert "open_until" not in plan.filters, plan.filters


def test_an_is_there_good_fare_at_lunch_asks_for_no_hour():
    plan = _plan("午市有冇好食")
    assert "open_time" not in plan.filters, plan.filters
    assert "open_weekday" not in plan.filters, plan.filters
    assert "open_until" not in plan.filters, plan.filters


def test_a_bare_lunch_service_names_no_clock():
    plan = _plan("午市")
    assert "open_time" not in plan.filters, plan.filters
    assert "open_weekday" not in plan.filters, plan.filters


def test_a_lunch_service_cafe_asks_for_no_hour_either():
    plan = _plan("午市嘅咖啡店")
    assert "open_time" not in plan.filters, plan.filters
    assert "open_weekday" not in plan.filters, plan.filters


def test_the_word_is_still_stripped_from_the_match_text():
    assert match_core("午市套餐", strip_time=True) == "套餐"
    assert match_core("午市有冇好食", strip_time=True) == "好食"


def test_the_clock_has_its_own_words_and_they_still_read_noon():
    # 中午 is a clock word: the Wednesday band is read exactly as before (D666's window).
    plan = _plan("中午嘅餐廳")
    assert plan.filters.get("open_time") == time(11, 30), plan.filters
    assert plan.filters.get("open_until") == time(14, 30), plan.filters


def test_the_english_noon_cue_is_unchanged():
    plan = _plan("lunch 嘅餐廳")
    assert plan.filters.get("open_time") == time(11, 30), plan.filters


@live_only
def test_the_served_page_for_a_lunch_set_is_not_the_noon_pool_only():
    """The product half: the served answer is every restaurant 套餐 can mean, not the 11:30 pool."""
    import asyncio

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as client:
        r = client.post("/ai/v1/search", json={"query": "午市套餐", "limit": 10})
        assert r.status_code == 200, r.text[:300]
        j = r.json()
        assert not j.get("degraded"), "served degraded - cards are the demo catalogue"
        assert j.get("items"), "no cards served for a lunch-set ask"
