"""A meal is a request to eat, and eating names food.

The words that say the user wants EATING were in no table at all: 「有咩好食」「食咩好」「想食嘢」
「肚餓」 each came back `intent=unknown` with no category, and the search answered the whole plane -
470 of 470 published merchants (`tmp/d702_before.py`, reference instant 11:00 HKT Thursday). The same
question with a noun was a discovery, because 食飯 is a category synonym - so the product understood
「食飯」 and not 「有咩好食」.

EATING now has its own table (`EAT_CUES`, `nlu/lexicon.py`), read in two places: the intent reader
(`_fill_intent_kind`, as one more signal that a sentence is a discovery) and the category reader
(`_fill_category`, as the food bucket at confidence 0.6 - an inference, never above a named kind's
0.95). The phrase leaves the match text, built from the same table so the reader and the strip cannot
drift (`_EAT_FRAME` in `nlu/understand.py`).

Measured on the published plane after the change:

    request              before            after
    食咩好 / 食乜好      470 (all)         184 restaurants
    有咩食 / 有乜食      470               184
    有咩好食 / 有乜好食  470               184
    想食嘢              470               184
    肚餓                470               184
    搵食                470 (no kind)     184
    深夜有咩食          104 (no kind)     44   (the restaurants in the deep-night window)
    而家想食嘢          255 (no kind)     14   (the restaurants open at 11:00 - the same hand count)
    唔想食辣            404 (no kind)     118  (restaurants, SPICY avoided - the polarity is kept)
    食煙                470               470  (unchanged: not a meal)
    食飯 / 素食 / 小食    184               184  (unchanged: their own reading)

A named kind still wins, because both readers ask for one first: 想食甜品 is the bakery pool (40),
食咩好咖啡店 the cafe pool (79), 有咩好食嘅火鍋 the hotpot pool (19).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest

from nexus_ai.nlu.lexicon import EAT_CUES
from nexus_ai.nlu.understand import extract_intent, match_core

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday

MEALS = ["食咩好", "食乜好", "有咩食", "有乜食", "有咩好食", "有乜好食", "想食嘢", "肚餓", "搵食"]


@pytest.mark.parametrize("sentence", MEALS)
def test_the_table_names_every_spelling_this_gate_uses(sentence):
    # the legs below must fail because the PRODUCT is wrong, not because a phrase is missing
    assert any(cue in sentence for cue in EAT_CUES), (sentence, EAT_CUES)


@pytest.mark.parametrize("sentence", MEALS)
def test_a_meal_is_a_discovery(sentence):
    ex = extract_intent(sentence, {"now": NOW})
    assert ex.intent == "discover_merchant", (sentence, ex.intent)
    assert ex.category == "restaurant", (sentence, ex.category)
    assert ex.confidence["category"] < 0.95, ex.confidence


@pytest.mark.parametrize("sentence", MEALS)
def test_the_meal_phrase_is_not_a_search_term(sentence):
    # a cue the lane READ must leave the match text: no row writes it, and left in it divides
    # every row's score against a phrase the corpus cannot contain
    core = match_core(sentence, strip_surfaces=())
    assert core == "", (sentence, core)


@pytest.mark.parametrize("sentence", ["食煙", "食烟"])
def test_smoking_is_not_a_meal(sentence):
    ex = extract_intent(sentence, {"now": NOW})
    assert ex.intent == "unknown", (sentence, ex.intent)
    assert ex.category is None, (sentence, ex.category)


@pytest.mark.parametrize("sentence", ["食飯", "素食", "小食"])
def test_the_words_with_their_own_reading_did_not_move(sentence):
    ex = extract_intent(sentence, {"now": NOW})
    assert ex.intent == "discover_merchant", (sentence, ex.intent)
    assert ex.category == "restaurant", (sentence, ex.category)


@pytest.mark.parametrize("sentence,kind", [("想食甜品", "bakery"),
                                          ("食咩好咖啡店", "cafe"),
                                          ("有咩好食嘅火鍋", "hotpot")])
def test_a_named_kind_is_read_before_the_meal_is(sentence, kind):
    assert extract_intent(sentence, {"now": NOW}).category == kind, sentence


def test_a_refusal_keeps_its_polarity_beside_the_meal():
    ex = extract_intent("唔想食辣", {"now": NOW})
    assert ex.intent == "discover_merchant", ex.intent
    values = {str(c.get("value")) for c in (ex.constraints or [])}
    assert "spicy" in values, (values, ex.constraints)


def test_the_meal_carries_the_window_it_was_asked_in():
    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("深夜有咩食", {"now": NOW}),
                              query="深夜有咩食", now=NOW)
    assert plan.filters.get("category") == "restaurant", plan.filters
    assert plan.filters.get("open_time") is not None, plan.filters


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
            for sentence in ("食咩好", "深夜有咩食", "而家想食嘢", "食煙", "食飯"):
                plan = S.plan_from_intent(extract_intent(sentence, {"now": NOW}),
                                          query=sentence, now=NOW)
                _c, resp, _b, _s = await S.search(backend=live, plan=plan)
                totals[sentence] = getattr(resp, "total_estimate", None)
            restaurants = await db.fetchval("""
                select count(distinct m.id) from merchants m
                where m.status = 'published'
                  and exists (select 1 from merchant_categories mc join categories c
                                on c.id = mc.category_id
                              left join categories pc on pc.id = c.parent_id
                              where mc.merchant_id = m.id
                                and (c.slug = 'restaurant' or pc.slug = 'restaurant'))""")
            at_eleven = await db.fetchval("""
                select count(distinct m.id) from merchants m
                where m.status = 'published'
                  and exists (select 1 from merchant_categories mc join categories c
                                on c.id = mc.category_id
                              left join categories pc on pc.id = c.parent_id
                              where mc.merchant_id = m.id
                                and (c.slug = 'restaurant' or pc.slug = 'restaurant'))
                  and exists (select 1 from business_hours h
                              where h.merchant_id = m.id and h.weekday = 3
                                and h.opens_at <= '11:00'::time
                                and (h.crosses_midnight = true
                                     or h.closes_at > '11:00'::time))""")
            deep = await db.fetchval("""
                select count(distinct m.id) from merchants m
                where m.status = 'published'
                  and exists (select 1 from merchant_categories mc join categories c
                                on c.id = mc.category_id
                              left join categories pc on pc.id = c.parent_id
                              where mc.merchant_id = m.id
                                and (c.slug = 'restaurant' or pc.slug = 'restaurant'))
                  and exists (select 1 from business_hours h
                              where h.merchant_id = m.id and h.weekday = 3
                                and (h.crosses_midnight = true OR h.closes_at > '23:00'::time
                                     OR h.opens_at < '05:00'::time))""")
            everything = await db.fetchval(
                "select count(*) from merchants where status = 'published'")
            return {"totals": totals, "restaurants": int(restaurants),
                    "at_eleven": int(at_eleven), "deep": int(deep),
                    "everything": int(everything)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_live_page_is_the_food_the_plane_holds(plane):
    assert plane["totals"]["食咩好"] == plane["restaurants"], plane
    assert plane["totals"]["食飯"] == plane["restaurants"], plane


def test_the_live_page_carries_the_hour_it_was_asked_in(plane):
    assert plane["totals"]["深夜有咩食"] == plane["deep"], plane
    assert plane["totals"]["而家想食嘢"] == plane["at_eleven"], plane
    assert 0 < plane["deep"] < plane["restaurants"], plane


def test_smoking_still_answers_the_whole_plane(plane):
    # the pin that the table did not overreach: 食煙 names no meal, so nothing narrows
    assert plane["totals"]["食煙"] == plane["everything"], plane
