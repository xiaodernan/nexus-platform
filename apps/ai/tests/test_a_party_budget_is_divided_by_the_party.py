"""A party's budget was compared against one head's price.

Measured 2026-10-30 (`tmp/d632_probe.txt`, `tmp/d632_page_before.txt`, `tmp/d632_page_after.txt`):
\"4個人預算1000\" is a party total and every row's `avg_price_hkd` is per head - the seed writes
`\"model\": \"per_person\"` on every price fact (`data/seed/generate.py:1051`) - but `price_fit`
took `budget_per`, never read it, and compared the two numbers directly. The whole of the 184
published restaurants (max HK$354.55, `tmp/d632_prices.txt`) was answered as inside a HK$1000 cap,
and a band was worse: \"4個人預算1000-2000嘅餐廳\" asked for HK$250-500 a head and every card on its
page scored 0.093 or less on the price axis, so the band could not move anything - the ten cards led
with an HK$88.43 row (relevance 1.00, `tmp/d632_page_before.txt`).

After the division the same query leads with the HK$343.14 and HK$274.73 rows, both inside the
per-head band, and \"10個人預算500嘅餐廳\" leads with the HK$43.14 row where it led with HK$88.43.

\"4個人預算1000嘅餐廳\" is UNCHANGED - at HK$250 a head every restaurant was already inside it - and
that is asserted too, because a normalisation that moves every page would be a different change.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.ranking import PriceConfig, price_fit
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10
CFG = PriceConfig()

#: the restaurant prices the pages below were measured on
PRICES = (26.0, 43.14, 50.0, 88.43, 140.0, 250.0, 274.73, 343.14, 900.0)


@pytest.mark.parametrize("price", PRICES)
def test_a_party_budget_scores_as_its_share_of_a_head(price):
    """HK$1000 for four is HK$250 a head, and the ranker has to say so - exactly, not approximately."""
    party = price_fit(price, 1000.0, CFG, "party", None, 4)
    head = price_fit(price, 250.0, CFG, "person", None, 4)
    assert party == pytest.approx(head, abs=1e-12), (price, party, head)


@pytest.mark.parametrize("price", PRICES)
def test_a_party_band_scores_as_its_share_of_a_head(price):
    party = price_fit(price, 2000.0, CFG, "party", 1000.0, 4)
    head = price_fit(price, 500.0, CFG, "person", 250.0, 4)
    assert party == pytest.approx(head, abs=1e-12), (price, party, head)


@pytest.mark.parametrize("party_size", [None, 1])
def test_a_party_of_one_and_no_party_are_no_ops(party_size):
    got = price_fit(343.14, 1000.0, CFG, "party", None, party_size)
    assert got == price_fit(343.14, 1000.0, CFG), got


def test_a_per_head_budget_is_not_divided_again():
    """「人均300」 is already per head: dividing it by the party would make a party of four a HK$75 ask."""
    got = price_fit(343.14, 300.0, CFG, "person", None, 4)
    assert got == price_fit(343.14, 300.0, CFG, "person"), got


@pytest.mark.parametrize("text,cap,floor", [
    ("4個人預算1000嘅餐廳", 1000.0, None),
    ("10個人預算500嘅餐廳", 500.0, None),
    ("4個人預算1000-2000嘅餐廳", 2000.0, 1000.0),
])
def test_the_plan_keeps_the_number_the_user_wrote_and_the_party(text, cap, floor):
    """The plan hands BOTH to the ranker unshared - the sharing is the ranker's rule, not a rewrite
    of what the user said: a card that repeats the budget has to repeat their number."""
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert (plan.budget_min, plan.budget_max) == (floor, cap), (plan.budget_min, plan.budget_max)
    assert plan.budget_per == "party", plan.budget_per
    assert plan.party_size is not None and plan.party_size > 1, plan.party_size


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
            out["prices"] = await db.fetchrow(
                "select count(*) as total, count(*) filter (where avg_price_hkd <= 250) as le250, "
                "count(*) filter (where avg_price_hkd <= 500) as le500, "
                "max(avg_price_hkd) as hi from merchants m where m.status = 'published' "
                "and exists (select 1 from merchant_categories mc join categories c "
                "on c.id = mc.category_id where mc.merchant_id = m.id "
                "and c.slug like 'restaurant%')")
            pages = {}
            for q in ("4個人預算1000-2000嘅餐廳", "10個人預算500嘅餐廳", "4個人預算1000嘅餐廳"):
                pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                        query=q, limit=TOP_K)
                pages[q] = dict(
                    parties=[c.candidate.party_size for c in pack.scored[:TOP_K]],
                    prices=[c.candidate.price for c in pack.scored[:TOP_K]],
                    fits=[round(c.breakdown.get("price_fit", -1), 3) for c in pack.scored[:TOP_K]])
            out["pages"] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_candidate_carries_the_party_the_budget_is_shared_across(plane):
    parties = plane["pages"]["4個人預算1000-2000嘅餐廳"]["parties"]
    assert set(parties) == {4}, (
        f"the candidate did not carry the party, so the ranker could not share the budget: {parties}")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_page_begins_inside_the_band_a_party_total_names(plane):
    """HK$1000-2000 for four is HK$250-500 a head. Measured before this unit: every card scored
    0.093 or less on the price axis and the first was HK$88.43."""
    page = plane["pages"]["4個人預算1000-2000嘅餐廳"]
    first, second = page["prices"][0], page["prices"][1]
    assert 250 <= first <= 500 and 250 <= second <= 500, (
        f"the page begins at {page['prices'][:3]} - outside the per-head band the total names")
    assert page["fits"][0] == 1.0 and page["fits"][1] == 1.0, page["fits"][:3]


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_big_party_is_the_case_where_the_division_bites(plane):
    """HK$500 for ten is HK$50 a head; before the division every row was inside it."""
    page = plane["pages"]["10個人預算500嘅餐廳"]
    assert page["prices"][0] <= 50, page["prices"][:3]
    assert max(page["fits"]) == 1.0 and min(page["fits"]) < 0.9, (
        f"the whole page is still answered as inside HK$50: {page['fits']}")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_party_budget_the_corpus_answers_whole_does_not_move(plane):
    """HK$1000 for four is HK$250 a head and 176 of the 184 restaurants are below it - so this page
    is the one that must NOT change, and the census below is why."""
    prices = plane["prices"]
    assert (prices["total"], prices["le250"]) == (184, 176), dict(prices)
    page = plane["pages"]["4個人預算1000嘅餐廳"]
    assert page["fits"] == [1.0] * TOP_K, page["fits"]
