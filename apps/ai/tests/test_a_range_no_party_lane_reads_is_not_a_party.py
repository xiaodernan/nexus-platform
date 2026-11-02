"""A dash range that named no party was removed from the sentence anyway.

D645 taught `PARTY_SPAN_RE` to take a Latin range as one span, and wrote the lead and the cue
(`table for`, `at most`) as OPTIONAL so a bare `2-4 people` would still match. Both being optional
means the range by itself matched, so a sentence with neither a lead nor a unit - and no party at
all - lost its words to a lane that answered nothing.

Measured 2026-11-02 (`tmp/d648_probe2.py`, this file's own gate run):

    2-4            party None   match text ""     (the words vanished)
    2-4蚊          party None   match text ""
    3-8蚊          party None   match text ""
    at most 2 to 4 party None   match text ""     (a cue alone is not a party)
    2-4蚊嘅餐廳    party None   match text ""     (the request lost its amount too)

The rule this restores is the one D643 already used: a span is removed when the PARTY lane reads
it. That lane needs a LEAD (`party of 2 to 4`) or a UNIT (`2-4 people`), and a bare cue is not
enough - measured, `at most 2 to 4` answers no party. So the range alternative is now two:
`_PARTY_LEAD_ONLY` (the lead, required) or the unit itself.

What this does NOT do: it does not read `2-4蚊` as a price band. The money lane takes two to five
digits by design (D624), so a one-digit amount marked as money still reads no band - but its words
now STAY in the sentence and reach the keyword lane, which is the honest half of the repair. The
band itself is a separate item.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, match_core, party_size_of
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

UNREAD = ["2-4", "2-4蚊", "3-8蚊", "$2-$4", "2蚊-4蚊", "5至10蚊", "at most 2 to 4"]


@pytest.mark.parametrize("text", UNREAD)
def test_a_range_no_lane_reads_keeps_its_words(text):
    assert match_core(text) == text, (text, match_core(text))


@pytest.mark.parametrize("text", UNREAD)
def test_a_range_no_lane_reads_stays_unread(text):
    intent = extract_intent_dict(text)
    assert intent.get("party_size") is None, (text, intent.get("party_size"))
    assert not intent.get("budget"), (text, intent.get("budget"))


@pytest.mark.parametrize("text,size", [
    ("2-4 people", 4),
    ("party of 2 to 4", 4),
    ("group of 2 to 4", 4),
    ("table for 2-4 people", 4),
    ("table for 4 to 6 people", 6),
    ("for 4 to 6", 6),
    ("4-6 guests", 6),
    ("between 2 and 4 people", 4),
    ("at most 2 to 4 people", 4),
    ("2至4人", 4),
    ("10至20人", 20),
])
def test_a_party_the_lane_reads_leaves_the_words(text, size):
    assert party_size_of(text) == size, (text, party_size_of(text))
    assert match_core(text) == "", (text, match_core(text))


def test_a_money_range_still_reads_and_leaves():
    intent = extract_intent_dict("20-40蚊嘅餐廳")
    band = intent.get("budget") or {}
    assert (band.get("min"), band.get("max")) == (20.0, 40.0), band
    plan = plan_from_intent(validate_intent(intent), query="20-40蚊嘅餐廳", limit=TOP_K)
    assert plan.match_text == "", plan.match_text


def test_a_content_word_beside_an_unread_range_survives():
    plan = plan_from_intent(validate_intent(extract_intent_dict("cheap 2-4 旺角")),
                            query="cheap 2-4 旺角", limit=TOP_K)
    assert plan.match_text == "cheap 2-4", plan.match_text


PAIRS = [("4 people", "2-4 people"), ("party of 4", "party of 2 to 4"),
         ("table for 6", "table for 4 to 6 people")]


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
        db = await db_pool.connect(st, force_new=True)
        try:
            out = {}
            for plain, range_ in PAIRS:
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
@pytest.mark.parametrize("plain,range_", PAIRS)
def test_a_read_range_still_answers_its_upper_end_s_page(plane, plain, range_):
    pages = plane[(plain, range_)]
    assert pages[range_]["ids"] == pages[plain]["ids"], (
        f"{range_} answers {pages[range_]['ids'][:3]} and {plain} answers {pages[plain]['ids'][:3]}")
    assert pages[range_]["rel"] == pages[plain]["rel"], (range_, pages[range_]["rel"], pages[plain]["rel"])
