"""A price and a party size name no content - but they were matched as query terms.

Measured 2026-10-30 (`tmp/d628_shapes.txt`), `kw_score` for the whole sentence against the rows it
retrieves, on the seeded plane:

    餐廳                  1.00
    100蚊以下嘅餐廳        0.325
    人均100以下嘅餐廳      0.200
    4個人嘅餐廳            0.343 / 0.200

The last two rows are not "the budget is being respected" or "the party is being considered" - they are
every row's relevance divided by tokens no row can contain. `canonical(plan.query_text)` was handed to
the retrieval whole, and the SELECT orders the candidate pool by that score, so a phrase that names no
content decided WHICH sixty rows the ranker ever saw: measured (`tmp/d628_final.txt`) the pool for
「4個人嘅餐廳」 shared only 48 of 60 rows with the pool for 「餐廳」, and its page was a different ten.

`match_core()` removes exactly the spans that have their own lane - a price, a party size - and leaves
everything else alone. A constraint that IS content stays: 「安靜嘅咖啡店」 is matched as written, because a
cafe's own description can say 安靜 and the preference lane is not the only reader of that word. Time
and district phrases are NOT stripped here and are filed in PLAN with their measurements.

After the strip (`tmp/d628_final.txt`): 「4個人嘅餐廳」 answers the SAME ten subject ids as 「餐廳」, and
「100蚊以下嘅餐廳」 answers nine of ten rows at relevance 1.00 where it answered 0.11-0.16 before.
The budget page's ORDER does not change, and that is not a disappointment: those shapes also set
`sort_preference=price_low`, which is what puts the cheapest first - §622 read that price as an effect
of the text match and this unit corrects it.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,core", [
    ("100蚊以下嘅餐廳", "餐廳"),
    ("300蚊以內嘅餐廳", "餐廳"),
    ("人均100以下嘅餐廳", "餐廳"),
    ("300-500蚊嘅餐廳", "餐廳"),
    ("4個人嘅餐廳", "餐廳"),
    ("每位$200以內嘅餐廳", "餐廳"),
])
def test_the_price_and_the_party_leave_the_match_text(text, core):
    assert match_core(text) == core


def test_nothing_but_constraints_leaves_an_empty_core():
    # 「我哋4個人，預算800」 names no subject at all. The caller must then keep the original text rather
    # than match "" - a request that is only a constraint is still a request.
    assert match_core("我哋4個人，預算800") == ""
    assert match_core("") == ""
    assert match_core("   ") == ""


@pytest.mark.parametrize("text", [
    "安靜嘅咖啡店",       # a preference word that a description can carry
    "有戶外座位嘅餐廳",   # an attribute word
    "今晩7點嘅餐廳",       # time: filed, not stripped (PLAN)
    "銅鑼灾嘅餐廳",       # district: filed, not stripped (PLAN)
    "餐廳",
])
def test_a_phrase_that_is_content_stays_in_the_match_text(text):
    assert match_core(text) == text


def test_the_plan_keeps_the_users_words_and_matches_the_core():
    q = "100蚊以下嘅餐廳"
    plan = plan_from_intent(validate_intent(extract_intent_dict(q)), query=q, limit=TOP_K)
    assert plan.query_text == q, "the card shows the user's own words - D418's promise"
    assert plan.match_text == "餐廳", (
        f"the plan matched {plan.match_text!r} - the price is still being counted as a query term")


@pytest.fixture(scope="module")
def pages():
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
            for q in ("餐廳", "4個人嘅餐廳", "100蚊以下嘅餐廳"):
                intent = validate_intent(extract_intent_dict(q))
                pack = await run_search(Deps(st), intent, query=q, limit=TOP_K)
                out[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                              rel=[s.candidate.relevance for s in pack.scored[:TOP_K]],
                              total=getattr(pack.response, "total_estimate", None))
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_party_size_no_longer_answers_a_different_ten(pages):
    """Measured 2026-10-30: 48 of 60 pool rows shared, and a different page, before the strip."""
    assert pages["4個人嘅餐廳"]["ids"] == pages["餐廳"]["ids"], (
        "a table for four still steers the retrieval: "
        f"{pages['4個人嘅餐廳']['ids']} against {pages['餐廳']['ids']}. The party's own lane is "
        "slots/capacity, and the text has nothing to say about it")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_ceiling_no_longer_divides_every_rows_relevance(pages):
    got = pages["100蚊以下嘅餐廳"]
    high = sum(1 for r in got["rel"] if r >= 0.9)
    # Measured 9 of 10 at 1.00 (the tenth is a row whose own text never carries 餐廳), against
    # 0 of 10 in 0.11-0.16 before the strip.
    assert high >= 8, f"only {high} of ten rows carry a real match: {got['rel']}"
    assert got["total"] == 184, (
        f"the pool changed size ({got['total']}) - the strip must not add or remove rows, only stop "
        "counting terms no row can meet")
