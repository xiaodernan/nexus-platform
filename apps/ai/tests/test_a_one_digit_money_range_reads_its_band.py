"""A one-digit amount marked as money was read by nobody.

The money range demanded two to five digits (`\d{2,5}`), so 「5至10蚊」, 「$2-$4」 and 「2蚊-4蚊」 read
no band at all while the same numbers with two digits (「20-40蚊」) read perfectly. D648 had already
stopped the party strip from removing those words, so the request was not lost - it simply reached
the keyword lane as text and the budget it named was ignored.

Measured 2026-11-02/03 (`tmp/d651_probe.py`):

    5至10蚊     band None      match text "5至10蚊"
    $2-$4       band None      match text "$2-$4"
    2蚊-4蚊     band None      match text "2蚊-4蚊"
    20-40蚊     band 20-40     match text ""

The repair widens the READING to one digit and makes the STRIP ask the same question the reading
asks. A bare 「2-4」 is not money - no currency token, no cue - so it keeps its words (D648), and the
strip had to stop removing money ranges by pattern alone: `_strip_money_ranges` runs `BUDGET_RANGE_RE`
and keeps every match `_range_is_money` refuses. One rule for reading and stripping, so a one-digit
span cannot be read one way and removed another.

Order matters and was measured: the party span goes first, then the money range, then the rest of
the amount rules. With the money range still inside the tuple, 「最多1000-2000」 reached
`BUDGET_MAX_RE` first, which consumed 1000 and left `-2000` in the match text.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

ONE_DIGIT = [
    ("5至10蚊", (5.0, 10.0)),
    ("$2-$4", (2.0, 4.0)),
    ("2蚊-4蚊", (2.0, 4.0)),
    ("hk$5-$10", (5.0, 10.0)),
    ("5蚊-10蚊", (5.0, 10.0)),
    ("2-4蚊", (2.0, 4.0)),
]


def _plan(text):
    return plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)


@pytest.mark.parametrize("text,band", ONE_DIGIT)
def test_a_one_digit_range_marked_as_money_reads_its_band(text, band):
    got = extract_intent_dict(text).get("budget") or {}
    assert (got.get("min"), got.get("max")) == band, (text, got)


@pytest.mark.parametrize("text,band", ONE_DIGIT)
def test_a_one_digit_range_marked_as_money_leaves_the_text(text, band):
    assert _plan(text).match_text == "", (text, _plan(text).match_text)


@pytest.mark.parametrize("text", ["2-4", "10-20", "1-2", "3-8"])
def test_a_range_that_marks_no_money_still_keeps_its_words(text):
    intent = extract_intent_dict(text)
    assert not intent.get("budget"), (text, intent.get("budget"))
    assert _plan(text).match_text == text, (text, _plan(text).match_text)


@pytest.mark.parametrize("text,size", [("10至20人", 20), ("最多10-20人", 20), ("2至4人", 4),
                                      ("2-4 people", 4)])
def test_a_party_range_is_still_a_party_and_no_band(text, size):
    intent = extract_intent_dict(text)
    assert intent.get("party_size") == size, (text, intent.get("party_size"))
    assert not intent.get("budget"), (text, intent.get("budget"))


@pytest.mark.parametrize("text,band", [
    ("100-200蚊", (100.0, 200.0)),
    ("20-40蚊嘅餐廳", (20.0, 40.0)),
    ("最多1000-2000", (1000.0, 2000.0)),
    ("最多1000-2000蚊", (1000.0, 2000.0)),
    ("預算1000-2000", (1000.0, 2000.0)),
])
def test_a_two_digit_band_still_reads_and_leaves_nothing(text, band):
    got = extract_intent_dict(text).get("budget") or {}
    assert (got.get("min"), got.get("max")) == band, (text, got)
    assert _plan(text).match_text == "", (text, _plan(text).match_text)


def test_a_clock_range_is_still_not_a_band():
    intent = extract_intent_dict("4-6pm")
    assert not intent.get("budget"), intent.get("budget")
    assert _plan("4-6pm").match_text == "", _plan("4-6pm").match_text


PAIRS = [("$2-$4", "2-4蚊"), ("5至10蚊", "5蚊-10蚊"), ("100-200蚊", "最多100-200蚊")]


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
            for a, b in PAIRS:
                pages = {}
                for q in (a, b):
                    pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                            query=q, limit=TOP_K)
                    pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                    rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
                out[(a, b)] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("a,b", PAIRS)
def test_two_spellings_of_one_band_answer_one_page(plane, a, b):
    pages = plane[(a, b)]
    assert pages[b]["ids"] == pages[a]["ids"], (
        f"{b} answers {pages[b]['ids'][:3]} and {a} answers {pages[a]['ids'][:3]}")
    assert pages[b]["rel"] == pages[a]["rel"], (b, pages[b]["rel"], pages[a]["rel"])
