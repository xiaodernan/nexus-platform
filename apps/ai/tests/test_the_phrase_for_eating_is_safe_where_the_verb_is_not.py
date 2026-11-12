"""A meal is read from the phrase, not from the verb.

`EAT_CUES` is a table of PHRASES on purpose: the bare verb 食 is a substring of 素食, 小食 and 食堂,
each of which has its own reading, and of 食煙, which is not a meal - the table's own comment says so.
The phrase every Cantonese speaker actually writes for eating, 食嘢, was in NO row of it. So only a
sentence that happened to write a LONGER cue was read: 「想食嘢」 answers the restaurant plane, while
「食嘢」 answers all 470 published merchants, 「通宵食嘢」 answers the 100 shops open in the deep-night
window with the word still in the match text, and 「去邊食嘢」 the 470 as well
(`tmp/d706_probe.py`, 11:00 HKT Thursday).

The corpus was read before the word was written (`tmp/d706_census.py`): 食嘢 writes 0 of the 470
published merchants and 0 of the 5,534 offerings, and so does 去邊 - a phrase no row can meet can only
be a cue, never content.

    request       before                                after
    通宵食嘢      unknown, no kind, 100, 「食嘢」 a term   discover, restaurant, 40, no term
    食嘢          unknown, no kind, 470, 「食嘢」 a term   discover, restaurant, 184, no term
    去邊食嘢      discover, no kind, 470                 discover, restaurant, 184 (「去邊」 filed)
    深夜有咩食    discover, restaurant, 40               unchanged
    素食 / 小食 / 食煙  unchanged                         unchanged

The 40 is the restaurant subset of the 100 merchants open 23:00-05:00 - the same two numbers D701 and
D703 pin - so this unit only moves 通宵食嘢 from the window's whole answer to its restaurants.

One table, two readers: adding the phrase to `EAT_CUES` also makes `_EAT_FRAME` (built from that
table, `understand.py:891`) blank it out of the match text, and makes the discovery signal
(`understand.py:460`) and the food bucket (`:512`) answer it. Nothing else was written by hand.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest

from nexus_ai.nlu.lexicon import EAT_CUES
from nexus_ai.nlu.understand import extract_intent, match_core

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday


# ------------------------------------------------------------------ the table
def test_the_table_carries_the_phrase_the_user_writes():
    assert "食嘢" in EAT_CUES, EAT_CUES


def test_the_table_still_carries_no_bare_verb():
    # the reason the phrase is safe: 食 alone is 素食 / 小食 / 食堂 / 食煙.
    assert "食" not in EAT_CUES, EAT_CUES


@pytest.mark.parametrize("phrase", ["素食", "小食", "食煙"])
def test_the_words_the_bare_verb_would_have_broken_are_still_read_as_they_were(phrase):
    ex = extract_intent(phrase, {"now": NOW})
    # 食煙 is not a meal; 素食 and 小食 name food. What this leg pins is that the phrase did not turn
    # any of the three into a bare-verb reading: 食煙 keeps NO restaurant bucket.
    if phrase == "食煙":
        assert ex.category is None, (phrase, ex.category)
    else:
        assert ex.category == "restaurant", (phrase, ex.category)


# ------------------------------------------------------------------ the reading
@pytest.mark.parametrize("sentence", ["食嘢", "通宵食嘢", "去邊食嘢", "想食嘢",
                                     "深夜有咩食"])
def test_the_sentence_reads_a_meal(sentence):
    ex = extract_intent(sentence, {"now": NOW})
    assert ex.intent == "discover_merchant", (sentence, ex.intent)
    assert ex.category == "restaurant", (sentence, ex.category)


def test_the_phrase_leaves_the_match_text():
    # the frame is built from the same table, so the cue cannot stay a search term.
    assert "食嘢" not in match_core("通宵食嘢"), match_core("通宵食嘢")
    assert match_core("食嘢").strip() == "", match_core("食嘢")


def test_the_hour_the_sentence_names_survives_the_meal():
    import nexus_ai.search.service as S

    plan = S.plan_from_intent(extract_intent("通宵食嘢", {"now": NOW}),
                              query="通宵食嘢", now=NOW)
    assert plan.filters.get("category") == "restaurant", plan.filters
    assert plan.match_text == "", plan.match_text
    band = {k: v for k, v in plan.filters.items()
            if k in ("min_closing_hour", "max_opening_hour", "open_time", "open_until")}
    assert band, plan.filters


def test_a_sentence_that_names_no_meal_is_left_alone():
    # the control: 通宵 alone is a window, not a meal, and must not read the restaurant bucket.
    ex = extract_intent("通宵", {"now": NOW})
    assert ex.category is None, (ex.category, ex.intent)


# ------------------------------------------------------------------ the page
@pytest.fixture(scope="module")
def pages():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search, validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    SENTENCES = ["通宵食嘢", "食嘢", "深夜有咩食", "想食嘢", "通宵"]

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            deps = Deps(st)
            out = {}
            for sentence in SENTENCES:
                pack = await run_search(deps, validate_intent(extract_intent(sentence, {"now": NOW}).to_dict()),
                                        query=sentence, now=NOW, limit=8)
                out[sentence] = {
                    "total": pack.response.total_estimate,
                    "kinds": [s.candidate.category for s in pack.scored],
                    "match": pack.plan.match_text,
                }
            everything = await db.fetchval(
                "select count(*) from merchants where status = 'published'")
            return {"out": out, "everything": int(everything)}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_night_meal_answers_the_restaurants_open_in_the_window(pages):
    got = pages["out"]["通宵食嘢"]
    assert got["total"] == 40, got
    assert got["match"] == "", got
    # every row on the page is a restaurant, and the window is still the deep night's
    assert all(k not in (None, "Live Music Bar", "Wine Bar") for k in got["kinds"]), got["kinds"]


def test_a_bare_meal_answers_the_restaurant_plane(pages):
    got = pages["out"]["食嘢"]
    assert got["total"] == 184, got
    assert got["total"] < pages["everything"], (got, pages["everything"])


def test_the_meal_that_already_worked_did_not_move(pages):
    assert pages["out"]["深夜有咩食"]["total"] == 40, pages["out"]["深夜有咩食"]
    assert pages["out"]["想食嘢"]["total"] == 184, pages["out"]["想食嘢"]


def test_a_window_with_no_meal_is_still_the_whole_window(pages):
    # the control on the live plane: 通宵 names an hour and no kind, so it answers the 100 open
    # in it - the number D701 and D703 both pin.
    got = pages["out"]["通宵"]
    assert got["total"] == 100, got
