"""A Latin cap or floor beside a party stayed in the match text.

`PARTY_SPAN_RE` is what removes a party from the words the keyword lane searches, and every
alternative for a Latin sentence started at the NUMBER. So `at most 12 people` removed `12 people`
and left the cap behind, and the keyword lane searched for the phrase `at most` on a query that
had already answered party size 12.

Measured 2026-11-02 (`tmp/d645_before.txt`, `tmp/d645_after.txt`):

    at most 12 people           party 12  match text "at most"
    no more than 12 people      party 12  match text "no more than"
    up to 12 people             party 12  match text "up to"
    less than 12 people         party 12  match text "less than"
    not more than 8 people      party  8  match text "not more than"
    max 10 people               party 10  match text "max"
    at least 4 people           party  4  match text ""
    最少4人                      party  4  match text ""

D643's `_PARTY_LEAD` named the noun a party belongs to (`table for`, `party of`) so a range could
be removed from its start. This is the same shape one word further out: `_PARTY_CUE` names the cap
or floor that sits between the noun and the number, and `_PARTY_TRAIL` names the cap written after
the party (`4 people at most`, `4 people or fewer`). Both are OPTIONAL and the cue comes AFTER the
lead, which is what makes `table for up to 6 people` one span rather than `up to` plus a party.

The cue is part of the span only when a PARTY follows it. `up to 30 mins` is the same four words
with no party behind them; D636 refused a bare Latin cue as residue for exactly this reason, and
the measurement shows it still leaves the match text untouched (`up to 30 mins`, party None). The
budget lane is the same story from the other side: `at most 1000` still answers a ceiling of 1000
with an empty match text, because `12 people` carries a unit and `1000` does not.

What this does NOT touch: `minimum of 4 people` still leaves `minimum of` (the `of` between cue and
number is its own item), `at most 4 people in 旺角` still leaves the filler `in`, `at most 4` with
no party behind it and no money word is still read as text on both sides (the budget lane does not
claim a one-digit cap either way), and `for 2 hours` is still a duration, not a table.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, party_size_of
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

CAPPED = [
    ("at most 12 people", 12),
    ("no more than 12 people", 12),
    ("not more than 8 people", 8),
    ("up to 12 people", 12),
    ("less than 12 people", 12),
    ("max 10 people", 10),
    ("max 4 pax", 4),
    ("no more than 3 guests", 3),
    ("at least 4 people", 4),
    ("minimum 4 people", 4),
    ("more than 4 people", 4),
    ("at least 6 diners", 6),
    ("minimum 6 diners", 6),
    ("table for up to 6 people", 6),
    ("up to 4 guests", 4),
    ("4 people at most", 4),
    ("4 people or fewer", 4),
    ("4 people or less", 4),
    ("最多12人", 12),
    ("最少4人", 4),
    ("至少6位", 6),
    ("起碼4人", 4),
    ("起码4人", 4),
]


@pytest.mark.parametrize("text,size", CAPPED)
def test_a_capped_party_is_read_as_the_size_behind_its_cue(text, size):
    assert party_size_of(text) == size, (text, party_size_of(text))


@pytest.mark.parametrize("text,size", CAPPED)
def test_the_cue_leaves_the_match_text_with_the_party(text, size):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == "", (text, plan.match_text)


@pytest.mark.parametrize("text,left", [
    ("quiet at most 12 people", "quiet"),
    ("at most 12 people quiet", "quiet"),
    ("romantic table for up to 6 people", "romantic"),
    ("rooftop at most 12 people", "rooftop"),
    ("at most 12 people with a view", "with a view"),
])
def test_a_content_word_beside_the_capped_party_survives(text, left):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == left, (text, plan.match_text)


def test_a_cue_with_no_party_behind_it_keeps_all_of_itself():
    plan = plan_from_intent(validate_intent(extract_intent_dict("up to 30 mins")), query="up to 30 mins", limit=TOP_K)
    assert plan.match_text == "up to 30 mins", plan.match_text


def test_a_duration_is_still_not_a_party():
    intent = extract_intent_dict("up to 30 mins")
    assert intent.get("party_size") is None, intent.get("party_size")


@pytest.mark.parametrize("text,ceiling", [
    ("at most 1000", 1000.0),
    ("up to 1000", 1000.0),
    ("no more than 1000蚊", 1000.0),
    ("最多1000蚊", 1000.0),
])
def test_a_money_cap_is_still_the_price_lane_s(text, ceiling):
    intent = extract_intent_dict(text)
    band = intent.get("budget") or {}
    assert band.get("max") == ceiling, (text, band)
    assert intent.get("party_size") is None, (text, intent.get("party_size"))
    plan = plan_from_intent(validate_intent(intent), query=text, limit=TOP_K)
    assert plan.match_text == "", (text, plan.match_text)


PAIRS = [("12 people", "at most 12 people"), ("12 people", "no more than 12 people"),
         ("12 people", "up to 12 people"), ("12 people", "less than 12 people"),
         ("8 people", "not more than 8 people"), ("10 people", "max 10 people"),
         ("4 people", "at least 4 people"), ("6 diners", "minimum 6 diners"),
         ("12人", "最多12人"), ("4人", "最少4人"),
         ("table for 6 people", "table for up to 6 people")]


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        await db_pool.connect(st, force_new=True)
        try:
            out = {}
            for plain, capped in PAIRS:
                pages = {}
                for q in (plain, capped):
                    pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                            query=q, limit=TOP_K)
                    pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                    rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
                out[(plain, capped)] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("plain,capped", PAIRS)
def test_a_capped_party_answers_the_page_its_size_answers(plane, plain, capped):
    pages = plane[(plain, capped)]
    assert pages[capped]["ids"] == pages[plain]["ids"], (
        f"{capped} answers {pages[capped]['ids'][:3]} and {plain} answers {pages[plain]['ids'][:3]}")
    assert pages[capped]["rel"] == pages[plain]["rel"], (capped, pages[capped]["rel"], pages[plain]["rel"])
