"""An English party RANGE was read at the wrong end and left half of itself in the text.

`PARTY_RE` is an alternation tried left to right, and every alternative for a Latin sentence
stopped at ONE number: `(?:party(?:\s*of)?|for)\s*(\d{1,2})` read the FIRST digit, and
`(\d{1,2})\s*(?:people|pax|persons?|guests|diners)` only matched a number sitting immediately
before its unit. So a range was read by whichever half happened to end next to the noun.

Measured 2026-11-02 (`tmp/d641_before.txt`, `tmp/d641_after.txt`):

    2-4 people              party  4   match text "2-"          (half the range stayed)
    2 to 4 people           party  4   match text "2 to"
    party of 2 to 4         party  2   match text "to 4"          (the FLOOR answered)
    party of 2-4            party  2   match text "-4"
    table for 4 to 6 people party  4   match text "table for 4 to" (the FLOOR answered)
    4-6 guests              party  6   match text "4-"
    group of 2 to 4         party  -   match text "group of 2 to 4" (no cue was known at all)
    table for 4             party  4   match text "table for 4"    (a single, unstripped)

D633 had already settled the reading for a Chinese range - `2至4人` is ONE party of FOUR - and
this is the same question in the other script, so the answer is the same: the UPPER end, and the
whole span leaves the match text. The lower number is deliberately NOT captured, because
`party_size_of` answers with the first non-empty group and a capture there would return the floor.

The cue forms come before the bare ones, so `table for 4 to 6 people` is removed from `table`
rather than from `4`, and the single `for 4` joined them because the same measurement showed it
reading party 4 while keeping the whole sentence. `between 2 and 4 people` is a range too.

A guard the measurement demanded: `for 2 hours` read a party of two, and once the strip knew the
`for N` cue it removed its own words and left `hours`. A DURATION after the number is not a
table, so `_NO_DURATION` refuses the cue when hours, minutes, days, weeks, months or years follow.

What this does NOT touch: `100-200蚊` is still the price lane's range (measured, budget 100-200,
party None), `4-6pm` is still the time lane's (party None, time read), and `2-4蚊` is still no
band at all - a bare dash range with no money cue and no party cue belongs to nobody, which is
its own filed item. `for 2 hours` still answers party size 2: the guard stops the STRIP, not the
older reading of `for N`, which is a duration defect filed separately.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, party_size_of
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,size", [
    ("2-4 people", 4),
    ("2 to 4 people", 4),
    ("party of 2 to 4", 4),
    ("party of 2-4", 4),
    ("table for 4 to 6 people", 6),
    ("4-6 guests", 6),
    ("2 to 4 diners", 4),
    ("2-4 pax", 4),
    ("group of 2 to 4", 4),
    ("for 4-6", 6),
    ("for 4 to 6", 6),
    ("between 2 and 4 people", 4),
])
def test_a_latin_range_is_one_party_and_its_size_is_the_upper_end(text, size):
    assert party_size_of(text) == size, (text, party_size_of(text))


@pytest.mark.parametrize("text", [
    "2-4 people", "2 to 4 people", "party of 2 to 4", "party of 2-4",
    "table for 4 to 6 people", "4-6 guests", "group of 2 to 4", "between 2 and 4 people",
    "table for 4", "seats for 4",
])
def test_the_range_leaves_the_match_text_whole(text):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == "", (text, plan.match_text)


@pytest.mark.parametrize("text,left", [
    ("quiet 2-4 people", "quiet"),
    ("2-4 people quiet", "quiet"),
    ("romantic table for 4 to 6 people", "romantic"),
])
def test_a_content_word_beside_the_range_survives(text, left):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == left, (text, plan.match_text)


@pytest.mark.parametrize("text,budget,party", [
    ("100-200蚊嘅餐廳", (100.0, 200.0), None),
    ("HK$100 to $200", (100.0, 200.0), None),
])
def test_a_money_range_is_still_the_price_lane_s(text, budget, party):
    intent = extract_intent_dict(text)
    band = intent.get("budget") or {}
    assert (band.get("min"), band.get("max")) == budget, (text, band)
    assert intent.get("party_size") == party, (text, intent.get("party_size"))


def test_a_clock_range_is_still_the_time_lane_s():
    intent = extract_intent_dict("4-6pm")
    assert intent.get("party_size") is None, intent.get("party_size")
    assert (intent.get("time") or {}).get("raw") == "4-6pm", intent.get("time")


def test_a_duration_is_not_stripped_as_a_party():
    plan = plan_from_intent(validate_intent(extract_intent_dict("for 2 hours")), query="for 2 hours", limit=TOP_K)
    assert plan.match_text == "for 2 hours", plan.match_text


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    pairs = (("4 people", "2-4 people"), ("party of 4", "party of 2 to 4"),
             ("table for 6", "table for 4 to 6 people"), ("for 6", "for 4 to 6"))
    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        await db_pool.connect(st, force_new=True)
        try:
            out = {}
            for plain, range_ in pairs:
                pages = {}
                for q in (plain, range_):
                    pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                            query=q, limit=TOP_K)
                    pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                    rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
                out[(plain, range_)] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("plain,range_", [("4 people", "2-4 people"), ("party of 4", "party of 2 to 4"),
                                          ("table for 6", "table for 4 to 6 people"), ("for 6", "for 4 to 6")])
def test_a_range_answers_the_page_its_upper_end_answers(plane, plain, range_):
    pages = plane[(plain, range_)]
    assert pages[range_]["ids"] == pages[plain]["ids"], (
        f"{range_} answers {pages[range_]['ids'][:3]} and {plain} answers {pages[plain]['ids'][:3]}")
    assert pages[range_]["rel"] == pages[plain]["rel"], (range_, pages[range_]["rel"], pages[plain]["rel"])
