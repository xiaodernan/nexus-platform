"""A budget cue written against the digits lost the band, and the ceiling kept it.

Measured 2026-10-30 (`tmp/d631_mechanism.txt`): `_range_is_money` was asked with the text up to
`span.start() + 1` - one character PAST where the amount begins - so a cue that sits directly
against the number ended on a digit and the test failed:

    預算1000-2000        before='預算1'   -> min None,   max 1000
    最多1000-2000        before='最多1'   -> min None,   max 1000
    唔超過1000-2000      before='唔超過1' -> min None,   max 1000
    我哋4個人，預算1000-2000  before='...預算1' -> min None, max 1000
    budget1000-2000      before='budget1' -> min None,  max 1000
    預算 1000-2000       before='預算 '   -> min 1000,   max 2000   (a SPACE saved it)
    預算$1000-2000       before='預算$'   -> min 1000,   max 2000   (a CURRENCY saved it)

So the floor D624 built reached the ranker only for a shape whose cue happened to be followed by a
space or a currency token, and for every other Chinese spelling the band became its own ceiling:
「預算300-500嘅餐廳」 was answered as "at most 300" and led with an HK$88 row.

After the repair the same shapes carry the band, and the page moves with it: the first card for
「預算300-500嘅餐廳」 is the HK$343 row (in band) where it was the HK$88 row before
(`tmp/d631_page_before.txt`, `tmp/d631_page_after.txt`).

The band's other half is the corpus: of the 184 published restaurants, 3 are priced 300-500 and
NONE above HK$500 (`tmp/d631_restaurants.txt`), so 「預算1000-2000嘅餐廳」 cannot be answered in
band by anybody - filed, not repaired here.
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

#: every shape that writes a budget cue AGAINST the digits, measured - the band, both ends
BANDS = [
    ("預算1000-2000嘅餐廳", 1000.0, 2000.0),
    ("最多1000-2000嘅餐廳", 1000.0, 2000.0),
    ("唔超過1000-2000嘅餐廳", 1000.0, 2000.0),
    ("我哋4個人，預算1000-2000", 1000.0, 2000.0),
    ("budget1000-2000", 1000.0, 2000.0),
    ("預算300-500嘅餐廳", 300.0, 500.0),
    ("預算 1000-2000嘅餐廳", 1000.0, 2000.0),   # the space is not what makes it money
    ("預算$1000-2000", 1000.0, 2000.0),
]


@pytest.mark.parametrize("text,floor,cap", BANDS)
def test_the_band_reaches_the_plan_whatever_follows_the_cue(text, floor, cap):
    got = extract_intent_dict(text).get("budget") or {}
    assert (got.get("min"), got.get("max")) == (floor, cap), (
        f"「{text}」 read {got} - a band written against the cue is still being read as its ceiling")


@pytest.mark.parametrize("text,floor,cap", BANDS)
def test_the_plan_hands_both_ends_to_the_ranker(text, floor, cap):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert (plan.budget_min, plan.budget_max) == (floor, cap), (
        f"「{text}」 reached the search as ({plan.budget_min}, {plan.budget_max})")


def test_the_space_and_the_currency_are_not_what_makes_a_band_a_band():
    shapes = ["預算1000-2000", "預算 1000-2000", "預算$1000-2000"]
    plans = [plan_from_intent(validate_intent(extract_intent_dict(s)), query=s, limit=TOP_K)
             for s in shapes]
    bands = {(p.budget_min, p.budget_max) for p in plans}
    assert bands == {(1000.0, 2000.0)}, (
        f"the same band reads three ways depending on punctuation: {bands}")


@pytest.mark.parametrize("text", ["10至20人嘅餐廳", "2至4人嘅餐廳"])
def test_a_range_of_people_is_not_a_range_of_money(text):
    got = extract_intent_dict(text)
    assert not got.get("budget"), (
        f"「{text}」 became a budget: {got.get('budget')} - a party is not a price")


def test_the_ranker_puts_the_band_above_the_rows_below_it():
    """The desk the floor is for: an in-band row scores 1.0 and a row below the floor decays, with
    the same tolerance at both ends (§622). The HK$ figures are the two cards measured above."""
    cfg = PriceConfig()
    in_band = price_fit(343.14, 500.0, cfg, "party", 300.0)
    below = price_fit(88.43, 500.0, cfg, "party", 300.0)
    assert in_band == 1.0 and below < 0.10, (in_band, below)
    assert price_fit(1200.0, 2000.0, cfg, "party", 1000.0) == 1.0


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
            out["band"] = await db.fetchrow(
                "select count(*) filter (where avg_price_hkd between 300 and 500) as b300_500, "
                "count(*) filter (where avg_price_hkd > 500) as gt500 "
                "from merchants m where m.status = 'published' and exists ("
                "select 1 from merchant_categories mc join categories c on c.id = mc.category_id "
                "where mc.merchant_id = m.id and c.slug like 'restaurant%')")
            q = "預算300-500嘅餐廳"
            pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                    query=q, limit=TOP_K)
            out["filters"] = dict(pack.plan.filters or {})
            out["first"] = [(s.candidate.subject_id, s.candidate.price) for s in pack.scored[:3]]
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_page_begins_with_the_band(plane):
    """Measured before the fix: the ten cards led with HK$88.43 and every one of them was answered
    as "inside" a ceiling of HK$300 that the user never wrote."""
    assert plane["first"], "the band query answered nothing"
    price = plane["first"][0][1]
    assert price is not None and 300 <= price <= 500, (
        f"the first card is HK${price}, outside the band the user wrote: {plane['first']}")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_corpus_cannot_seat_a_higher_band(plane):
    """3 of the 184 restaurants are priced 300-500 and none above HK$500 - so 「預算1000-2000」 is
    answered by rows outside the band, whatever the plan now carries. Filed, not repaired here."""
    assert (plane["band"]["b300_500"], plane["band"]["gt500"]) == (3, 0), (
        f"the corpus moved: {dict(plane['band'])} - the band's reach has to be weighed again")
