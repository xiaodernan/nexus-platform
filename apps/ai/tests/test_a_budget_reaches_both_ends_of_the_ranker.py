"""Does the price a user states reach the ranker - both ends of it?

Measured 2026-10-30 (`tmp/d624_census.txt`), a Hong Kong user writes the ceiling AFTER the amount:
「300蚊以內」, 「300以下」, 「500蚊樓下」, 「$3000以下」, 「人均300以內」, 「每位$200以內」 and 「人均消費300蚊」
all carried NO budget at all, because every ceiling cue in the patterns must PRECEDE the number -
the English/formal shape ("under 300", "最多300"). Eleven of the twenty-six sentences in that
census were silent, and they were the natural ones.

The floor had the same hole plus a second one: 「300蚊以上」 produced no budget, and the range
「預算 300 - 500」 was read as max=300 - the LOW end - so a user asking for 300-500 was answered
with everything under 300. And a floor that DID parse was then dropped: `plan_from_intent` copied
`intent.budget.max` into the plan and nothing copied `.min`, so `price_fit` had one end to work
with. The ranker now scores the band: inside it 1.0, and each end decays on the same log scale.

The legs below are offline except the last, which reads the live plane through `run_search`.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.ranking import Candidate, PriceConfig, load_ranking_weights, organic_rank, price_fit
from nexus_ai.search.service import plan_from_intent
from nexus_ai.api.pipeline import validate_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
CFG = PriceConfig()


def _budget(text: str) -> dict:
    return extract_intent_dict(text).get("budget") or {}


@pytest.mark.parametrize("text,cap", [
    ("300蚊以內的餐廳", 300.0),
    ("300以下的餐廳", 300.0),
    ("500蚊樓下", 500.0),
    ("$300以下", 300.0),
    ("唔好太貴，300蚊内", 300.0),
])
def test_a_ceiling_written_after_the_amount_is_a_budget(text, cap):
    got = _budget(text)
    assert got.get("max") == cap and got.get("min") is None, (
        f"{text!r} answered {got} - the amount-first shape the user actually writes must reach "
        "the plan as a ceiling")


@pytest.mark.parametrize("text,cap", [
    ("人均300以內的餐廳", 300.0),
    ("每人300蚊以內", 300.0),
    ("每位$200以內", 200.0),
    ("人均$300的餐廳", 300.0),
    ("人均消費300蚊", 300.0),
])
def test_a_per_head_figure_is_a_budget_named_per_head(text, cap):
    got = _budget(text)
    assert got.get("max") == cap, f"{text!r} answered {got}"
    assert got.get("per") == "person", (
        f"{text!r} answered per={got.get('per')!r} - a per-head figure read as a party total is "
        "compared against the wrong number")


@pytest.mark.parametrize("text,floor", [
    ("300蚊以上的餐廳", 300.0),
    ("500蚊起", 500.0),
    ("$800以上", 800.0),
    ("人均300蚊以上", 300.0),
])
def test_a_floor_written_after_the_amount_is_a_budget(text, floor):
    got = _budget(text)
    assert got.get("min") == floor and got.get("max") is None, (
        f"{text!r} answered {got} - the bottom of a band was read as nothing at all")


@pytest.mark.parametrize("text,low,high", [
    ("300-500蚊的餐廳", 300.0, 500.0),
    ("預算 300 - 500", 300.0, 500.0),
    ("$300-$500 的餐廳", 300.0, 500.0),
])
def test_a_range_keeps_both_ends(text, low, high):
    got = _budget(text)
    assert (got.get("min"), got.get("max")) == (low, high), (
        f"{text!r} answered {got} - BUDGET_MAX_RE used to take the first number it saw, which is "
        "the LOW end, so 'budget 300-500' answered everything under 300")


@pytest.mark.parametrize("text", [
    "10至20人的餐廳",   # a party size, not money
    "500米以內的餐廳",   # a radius
    "12歲以上的餐廳",   # an age
    "10分鐘以上",        # a duration
])
def test_an_amount_that_is_not_money_stays_out_of_the_budget(text):
    assert _budget(text) in ({}, {"min": None, "max": None, "currency": "HKD", "per": None},
                             None), f"{text!r} was read as money: {_budget(text)!r}"


def test_the_band_is_flat_inside_and_decays_on_either_side():
    def fit(price):
        return price_fit(price, 500.0, CFG, budget_min=300.0)

    assert fit(300.0) == 1.0 and fit(400.0) == 1.0 and fit(500.0) == 1.0
    below, above = fit(150.0), fit(1000.0)
    assert below < 0.9 and above < 0.9, (below, above)
    # Half the floor is the same distance from the band as twice the cap - one log scale.
    assert abs(below - above) < 1e-9, (
        "the floor and the cap must decay at the same rate, or one end of the band is cheaper "
        "to violate than the other")


def test_a_floor_on_its_own_makes_every_row_above_it_in_band():
    # 「300蚊以上」: everything at or above the floor is what the user asked for. The neutral-band
    # curve used to answer 900 -> 0.55 (further from HK$300 was worse), which inverted the ask.
    assert price_fit(900.0, None, CFG, "party", 300.0) == 1.0
    assert price_fit(300.0, None, CFG, "party", 300.0) == 1.0
    assert price_fit(60.0, None, CFG, "party", 300.0) < 0.2


def test_the_plan_carries_both_ends():
    plan = plan_from_intent(validate_intent(extract_intent_dict("300-500蚊的餐廳")),
                            query="300-500蚊的餐廳", limit=10)
    assert (plan.budget_min, plan.budget_max) == (300.0, 500.0), (
        "the floor was parsed and then dropped: plan_from_intent copied .max and nothing copied "
        ".min, so price_fit could only ever work with one end")


def test_the_band_orders_three_rows_that_differ_only_in_price():
    w = load_ranking_weights(os.path.join(os.path.dirname(__file__), "..", "..", "..", "infra",
                                         "config", "ranking_weights.yaml"))
    def row(name, price):
        return Candidate(subject_type="merchant", subject_id=name, merchant_id=name,
                         relevance=0.6, rating=4.0, rating_count=40, price=price,
                         budget_min=300.0, budget_max=500.0, availability="available",
                         popularity=0.5, freshness=0.5)
    ranked = organic_rank([row("below", 80.0), row("in", 400.0), row("above", 1200.0)], w)
    assert [s.candidate.subject_id for s in ranked][0] == "in", (
        f"the in-band row did not win: {[(s.candidate.subject_id, s.breakdown['price_fit']) for s in ranked]}")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_band_reaches_the_live_page():
    """Measured 2026-10-30 (`tmp/d624_live2.txt`): on the 184 restaurants, 「300-500蚊」 scored the top
    ten's price_fit 1.00 / 1.00 / 0.41 / 0.07 / 0.07 / 0.82 / 0.06 / 0.01 / 0.45 / 0.19 - the band
    acting inside the page. The page is NOT all in band and this door does not claim it is: only
    3 of the 184 restaurants are priced 300-500 (`tmp/d624_live2.txt`), and the retrieval likes a
    different set of rows entirely. What is claimed here is the lane's reach, not the corpus's.
    """
    import asyncio

    settings = None
    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    settings = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                        internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        await db_pool.connect(settings, force_new=True)
        try:
            intent = validate_intent(extract_intent_dict("300-500蚊的餐廳"))
            pack = await run_search(Deps(settings), intent, query="300-500蚊的餐廳",
                                    limit=10)
            return [(s.candidate.price, s.breakdown.get("price_fit"))
                    for s in pack.scored[:10]]
        finally:
            await db_pool.dispose()

    rows = asyncio.run(_go())
    fits = [(p, f) for p, f in rows if p is not None and f is not None]
    assert fits, "the live page carried no priced rows - this door cannot read the lane"
    in_band = [f for p, f in fits if 300.0 <= p <= 500.0]
    below = [f for p, f in fits if p < 300.0]
    assert in_band and all(f == 1.0 for f in in_band), (rows, in_band)
    assert below and any(f < 0.5 for f in below), (
        f"no below-floor row was demoted on the page: {rows} - the floor is not reaching price_fit")
