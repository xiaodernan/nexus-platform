"""A party range was read as a price band when a budget cue sat in front of it.

D636 refused a cue-first CEILING whose digits counted people (`最多40人`), and the RANGE rule kept
its own, weaker test: a currency token inside the span, or a budget cue immediately before it. The
cue 最多 is both a party cap and a budget cap, so a sentence that says "ten to twenty of us" was
read as "ten to twenty dollars".

Measured 2026-11-02 (`tmp/d649_probe2.py`):

    最多10-20人        party 20   budget 10-20   (a party of 10-20 filtered the catalogue by price)
    最多10-20 people   party 20   budget 10-20
    at most 10-20 people party 20 budget max 10 (the ceiling lane read the digits on its own)
    預算10-20人        party 20   budget 10-20
    最多40-60人        party -    budget 40-60   (no party lane range above 40, so the band stood alone)

Two guards, both on the same span:

- `_PARTY_COUNTER_AFTER` refuses the RANGE band when a party counter (個 / 个 / 位 / 人 / people /
  pax / persons / guests / diners) follows the second number.
- `_PARTY_RANGE_AFTER` refuses the CEILING amount when what follows the amount the cue rule read is a
  range separator and a second number that ends in that counter - the shape `-20人` sits between the
  digits (10) and the counter, so `_PARTY_AFTER` never saw it.

What this does NOT touch: `最多1000-2000`, `最多1000-2000蚊`, `預算1000-2000` and `100-200蚊` still read
their band, `最多1000蚊` still reads its ceiling, and `10-20人` still reads party 20 with no band -
the guard is about the counter, not about the cue.

Still open (filed): a ONE-DIGIT amount marked as money - `2-4蚊`, `5至10蚊`, `$2-$4` - reads no band
at all, because the money lane takes two to five digits by design (D624). Its words stay in the
sentence (D648); the band is its own item.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

PEOPLE = [
    ("最多10-20人", 20),
    ("最多10至20人", 20),
    ("最多10-20個人", 20),
    ("預算10-20人", 20),
    ("預算10至20位", 20),
    ("最多4-6位", 6),
    ("最多10-20 people", 20),
    ("at most 10-20 people", 20),
]


@pytest.mark.parametrize("text,size", PEOPLE)
def test_a_capped_party_range_reads_the_party_and_no_money(text, size):
    intent = extract_intent_dict(text)
    assert intent.get("party_size") == size, (text, intent.get("party_size"))
    assert not intent.get("budget"), (text, intent.get("budget"))


@pytest.mark.parametrize("text,size", PEOPLE)
def test_a_capped_party_range_leaves_no_words(text, size):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.match_text == "", (text, plan.match_text)


def test_a_party_range_above_the_reading_claims_no_money_either():
    """40-60 people is outside `party_size_of`'s 1..40, and it used to leave a HK$40-60 band."""
    intent = extract_intent_dict("最多40-60人")
    assert intent.get("party_size") is None, intent.get("party_size")
    assert not intent.get("budget"), intent.get("budget")


@pytest.mark.parametrize("text,band", [
    ("最多1000-2000", (1000.0, 2000.0)),
    ("最多1000-2000蚊", (1000.0, 2000.0)),
    ("預算1000-2000", (1000.0, 2000.0)),
    ("100-200蚊", (100.0, 200.0)),
    ("20-40蚊嘅餐廳", (20.0, 40.0)),
])
def test_a_money_range_still_reads_its_band(text, band):
    got = extract_intent_dict(text).get("budget") or {}
    assert (got.get("min"), got.get("max")) == band, (text, got)


def test_a_money_ceiling_still_reads_its_ceiling():
    got = extract_intent_dict("最多1000蚊").get("budget") or {}
    assert got.get("max") == 1000.0, got


def test_a_plain_party_range_reads_no_band():
    intent = extract_intent_dict("10-20人")
    assert intent.get("party_size") == 20
    assert not intent.get("budget"), intent.get("budget")


PAIRS = [("10-20人", "最多10-20人"), ("10-20人", "最多10至20人"),
         ("10-20人", "預算10-20人"), ("100-200蚊", "最多100-200蚊")]


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
