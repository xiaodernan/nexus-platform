"""A clock range was read at one end and left a fragment of itself in the match text.

`CLOCK_RE` is a `search`, so it answers with the FIRST clock in the sentence, and `TIME_SPAN_RE`
knew only single clocks. Both halves showed on the same sentence:

Measured 2026-11-02 (`tmp/d646_before.txt`):

    4-6pm          open_time 18:00   match text "4-"       (right end, half the span)
    4pm-6pm        open_time 16:00   match text "-"        (WRONG end)
    4 pm - 6 pm    open_time 16:00   match text "-"
    4點至6點       open_time 04:00   match text "至"
    from 4 to 6pm  open_time 18:00   match text "from 4 to"
    6-9pm dinner   open_time 21:00   match text "6- dinner"

D643 settled this question for a party range and D624 for a money range: the UPPER end is the
reading, because the sentence names when the outing starts. `parse_time` already answered 6pm for
「4-6pm」 (only the `pm` carries a meridiem, so `CLOCK_RE` found it) and 4pm for 「4pm-6pm」, which is
the same sentence read two ways. `CLOCK_RANGE_RE` names the range and `clock_match` returns the
SECOND clock - a real `CLOCK_RE` match, so the meridiem guess and the early/late cues around the
clock keep reading the clock itself.

The strip is the other half: `understand._TIME_CLOCK_RANGE` covers the range as ONE span, from the
sentence (through an optional `from`) to the second clock, so nothing of it is left for the keyword
lane. It is still applied only when the time lane parsed a time (`strip_time=True`), the D629 guard.

What this does NOT touch: 「4-6點」 and 「4點至6點」 have no meridiem word, so both answer 06:00 - that
is the bare-hour convention `4-6點` already used, and the two spellings now agree with each other
instead of one of them answering 04:00. 「2-4 people」 is still a party of 4, 「100-200蚊」 still a band,
「10至20人」 still a party of 4 and 「4-6」 still no time at all: a range is a clock only when a clock
marker (點 / am / pm / a colon) ends it. 「open until 6pm」 still reaches the lane as `open until` and
「24小時 4-6pm」 as `24小時` - the direction words and the constant-hours phrase are their own items.
"""

from __future__ import annotations

import os
from datetime import time as clock

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

RANGES = [
    ("4-6pm", (18, 0)),
    ("4pm-6pm", (18, 0)),
    ("4pm - 6pm", (18, 0)),
    ("4 pm - 6 pm", (18, 0)),
    ("6-9pm", (21, 0)),
    ("19:30-21:00", (21, 0)),
    ("11:30-13:30", (13, 30)),
    ("11-13點", (13, 0)),
    ("下午4-6點", (18, 0)),
    ("下午4點至6點", (18, 0)),
    ("4點至6點半", (6, 30)),
    ("下午4點至6點半", (18, 30)),
    ("from 4 to 6pm", (18, 0)),
    ("星期一4-6pm", (18, 0)),
]


def _plan(text):
    return plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)


@pytest.mark.parametrize("text,hm", RANGES)
def test_a_clock_range_is_read_at_its_upper_end(text, hm):
    got = (_plan(text).filters or {}).get("open_time")
    assert got == clock(*hm), (text, got)


@pytest.mark.parametrize("text,hm", RANGES)
def test_the_clock_range_leaves_the_match_text_whole(text, hm):
    assert _plan(text).match_text == "", (text, _plan(text).match_text)


@pytest.mark.parametrize("text,left", [
    ("quiet 4-6pm", "quiet"),
    ("4-6pm quiet", "quiet"),
    ("6-9pm dinner", "dinner"),
    ("24小時 4-6pm", "24小時"),
])
def test_a_content_word_beside_the_range_survives(text, left):
    assert _plan(text).match_text == left, (text, _plan(text).match_text)


@pytest.mark.parametrize("text,hm", [
    ("4-6點", (6, 0)),
    ("4點至6點", (6, 0)),
    ("4-6點半", (6, 30)),
])
def test_a_range_with_no_meridiem_word_reads_the_bare_hour(text, hm):
    """No 下午 / pm anywhere: the lane's bare-hour convention, and both spellings agree."""
    got = (_plan(text).filters or {}).get("open_time")
    assert got == clock(*hm), (text, got)


@pytest.mark.parametrize("text", ["2-4 people", "100-200蚊", "10至20人", "4-6"])
def test_a_range_that_is_not_a_clock_stays_where_it_was(text):
    intent = extract_intent_dict(text)
    assert not intent.get("time"), (text, intent.get("time"))


def test_the_party_and_money_ranges_are_untouched():
    party = extract_intent_dict("2-4 people")
    assert party.get("party_size") == 4, party.get("party_size")
    band = extract_intent_dict("100-200蚊").get("budget") or {}
    assert (band.get("min"), band.get("max")) == (100.0, 200.0), band
    assert extract_intent_dict("10至20人").get("party_size") == 20


@pytest.mark.parametrize("text,hm", [("10pm", (22, 0)), ("19:30", (19, 30)),
                                     ("下午茶3點", (15, 0))])
def test_a_single_clock_is_read_exactly_as_before(text, hm):
    got = (_plan(text).filters or {}).get("open_time")
    assert got == clock(*hm), (text, got)


@pytest.mark.parametrize("text,quality", [("before 7pm", "before:1900"),
                                          ("after 7pm", "open_late_after:1900"),
                                          ("open until 6pm", "open_late_after:1800")])
def test_a_direction_word_still_steers_the_lane(text, quality):
    got = (extract_intent_dict(text).get("time") or {}).get("quality")
    assert got == quality, (text, got)


def test_the_late_cue_is_still_the_lane_s_own_word():
    """Not this unit: `open until` is a direction cue, not a clock, and it still stays in the text."""
    assert _plan("open until 6pm").match_text == "open until"


def test_a_range_and_a_party_in_one_sentence_keep_their_own_readings():
    plan = _plan("4-6pm 2 people")
    assert (plan.filters or {}).get("open_time") == clock(18, 0), plan.filters
    assert extract_intent_dict("4-6pm 2 people").get("party_size") == 2
    assert plan.match_text == "", plan.match_text


PAIRS = [("6pm", "4-6pm"), ("6pm", "4pm-6pm"), ("6pm", "4 pm - 6 pm"),
         ("下午6點", "下午4-6點"), ("4-6點", "4點至6點"), ("21:00", "19:30-21:00")]


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
            for upper, range_ in PAIRS:
                pages = {}
                for q in (upper, range_):
                    pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                            query=q, limit=TOP_K)
                    pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                    rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]],
                                    filters=dict(pack.plan.filters or {}))
                out[(upper, range_)] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("upper,range_", PAIRS)
def test_a_clock_range_answers_the_page_its_upper_end_answers(plane, upper, range_):
    pages = plane[(upper, range_)]
    assert pages[range_]["filters"] == pages[upper]["filters"], (
        range_, pages[range_]["filters"], pages[upper]["filters"])
    assert pages[range_]["ids"] == pages[upper]["ids"], (
        f"{range_} answers {pages[range_]['ids'][:3]} and {upper} answers {pages[upper]['ids'][:3]}")
    assert pages[range_]["rel"] == pages[upper]["rel"], (range_, pages[range_]["rel"], pages[upper]["rel"])
