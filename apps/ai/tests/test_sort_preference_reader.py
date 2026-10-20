"""The reader for `Intent.sort_preference` — API_CONTRACT §34, §67, §8.

`plan_from_intent()` has written `plan.sort_preference` since the intent layer existed, and
`nlu/state_merger.py` fills it from the user's own words ("太贵了" → `price_low`, "近一点" →
`distance`), but the ranking pipeline never read it: every follow-up that named an order came
back with the same cards in the same order. This file pins the reader that closes that seam.

Three properties, each with its own red arm:
  * the table covers the contract's closed `SortPreference` vocabulary exactly — a name added
    to the Literal without a table entry (or the reverse) is a bug in whichever list was edited
    last, so the reader refuses to fall back;
  * a preference re-orders, it never re-scores and never filters (§67: the organic score is
    untouched, and no card is dropped);
  * a card with no value for the field goes last instead of being read as zero (§8: an unknown
    price is not the cheapest restaurant in the answer).

DB-free and provider-free: the unit cases build `Scored` lists directly (the same fixture shape
`tests/test_sponsored_ranking.py` uses), the service cases run the real pipeline over
`StaticBackend`, and the chain case starts from the utterance.
"""

from __future__ import annotations

from typing import get_args

import pytest

from nexus_ai.contract import SortPreference
from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.search.ranking import (
    SORT_PREFERENCE_FIELDS,
    Candidate,
    RankingWeights,
    Scored,
    WEIGHT_KEYS,
    apply_sort_preference,
    apply_sponsored,
)

import nexus_ai.search.service as S

#: Equal weights: §67's placement rule lives in `SponsoredConfig`, whose shipped defaults the
#: pipeline reads from `infra/config/ranking_weights.yaml`. The sponsored case only needs the
#: cap, so it takes the same construction `tests/test_sponsored_ranking.py` uses.
_weights = RankingWeights(weights={k: 1.0 / len(WEIGHT_KEYS) for k in WEIGHT_KEYS})


def _s(subject_id: str, *, score: float, price: float | None = None,
       distance_m: float | None = None, rating: float | None = None,
       popularity: float = 0.0, sponsored: bool = False) -> Scored:
    c = Candidate(subject_type="merchant", subject_id=subject_id, merchant_id=subject_id,
                  relevance=0.5, price=price, distance_m=distance_m, rating=rating,
                  popularity=popularity, sponsored=sponsored)
    return Scored(candidate=c, score=score, organic_score=score, breakdown={}, contributions=[])


def _ids(scored: list[Scored]) -> list[str]:
    return [s.candidate.subject_id for s in scored]


#: organic order is a > b > c > d; price order is b < c < a and d has no price; the three
#: distances are ordered b < a < c with d unknown, so `distance` and `price_low` cannot be
#: satisfied by the same accidental ordering.
def _four() -> list[Scored]:
    return [_s("a", score=0.90, price=400.0, distance_m=1000.0, rating=4.0, popularity=0.1),
            _s("b", score=0.80, price=100.0, distance_m=500.0, rating=4.8, popularity=0.9),
            _s("c", score=0.70, price=250.0, distance_m=1500.0, rating=None, popularity=0.5),
            _s("d", score=0.60, price=None, distance_m=None, rating=4.9, popularity=0.3)]


# ------------------------------------------------------------------ the vocabulary census
def test_the_table_covers_the_contract_vocabulary_exactly():
    # Both directions: a Literal name with no field entry crashes the pipeline at run time,
    # and a table entry the contract never allows is dead code that a later reader trusts.
    assert set(get_args(SortPreference)) == set(SORT_PREFERENCE_FIELDS)


# ------------------------------------------------------------------- each named ordering
def test_relevance_leaves_the_organic_order_alone():
    assert _ids(apply_sort_preference(_four(), "relevance")) == ["a", "b", "c", "d"]


def test_price_low_is_ascending_and_an_unknown_price_goes_last():
    # §8: `d` has no price. Read as 0 it would win the answer; it must lose the whole ordering.
    assert _ids(apply_sort_preference(_four(), "price_low")) == ["b", "c", "a", "d"]


def test_distance_is_ascending_and_an_unknown_distance_goes_last():
    assert _ids(apply_sort_preference(_four(), "distance")) == ["b", "a", "c", "d"]


def test_rating_is_descending_and_an_unrated_card_goes_last():
    assert _ids(apply_sort_preference(_four(), "rating")) == ["d", "b", "a", "c"]


def test_trending_is_descending_by_popularity():
    assert _ids(apply_sort_preference(_four(), "trending")) == ["b", "c", "d", "a"]


def test_ties_fall_back_to_the_organic_order_then_the_key():
    tied = [_s("x", score=0.2, price=100.0), _s("y", score=0.5, price=100.0),
            _s("z", score=0.9, price=50.0)]
    assert _ids(apply_sort_preference(tied, "price_low")) == ["z", "y", "x"]
    identical = [_s("b", score=0.5, price=100.0), _s("a", score=0.5, price=100.0)]
    assert _ids(apply_sort_preference(identical, "price_low")) == ["a", "b"]


def test_a_preference_reorders_it_never_rescores_or_filters():
    before = _four()
    after = apply_sort_preference(before, "price_low")
    assert len(after) == len(before)  # nothing dropped: §34 changes order, not the answer set
    assert sorted(s.organic_score for s in after) == sorted(s.organic_score for s in before)
    assert all(s.score == s.organic_score for s in after)


def test_an_unlisted_preference_is_a_bug_not_a_fallback():
    # `SortPreference` is a closed Literal, so this name cannot reach the pipeline from a
    # request; it reaches it from an edit to one list without the other.
    with pytest.raises(KeyError, match="price_high"):
        apply_sort_preference(_four(), "price_high")


def test_a_preference_never_gives_a_paid_slot_rank_zero():
    # §67: sponsored placement still runs *after* the reader, so the cheapest promoted card
    # cannot buy the top of a "太贵了" answer.
    ranked = apply_sort_preference([_s("sp", score=0.1, price=50.0, sponsored=True),
                                    _s("o2", score=0.5, price=200.0),
                                    _s("o1", score=0.9, price=300.0)], "price_low")
    assert _ids(ranked) == ["sp", "o2", "o1"]  # promoted first on price alone
    placed = apply_sponsored(ranked, _weights)
    assert _ids(placed)[0] == "o2"
    assert _ids(placed)[1] == "sp"


# ------------------------------------------------------------------- the served pipeline
MERCHANTS = [
    {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
     "display_name": "Ramen House", "category_primary": "restaurant", "district": "Sha Tin",
     "avg_price_hkd": 120, "rating_agg": 4.5, "review_count": 10, "tags": ["ramen"],
     "price_amount": 100},
    {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
     "display_name": "Sushi Zen", "category_primary": "restaurant", "district": "Central",
     "avg_price_hkd": 400, "rating_agg": 4.2, "review_count": 20, "price_amount": 380,
     "tags": ["sushi"]},
    {"subject_id": "m3", "merchant_id": "m3", "subject_type": "merchant",
     "display_name": "Yum Cha", "category_primary": "restaurant", "district": "Sha Tin",
     "avg_price_hkd": 250, "rating_agg": 4.9, "review_count": 200, "price_amount": 230,
     "tags": ["dim sum"]},
]

#: Same three, Chinese cards and Chinese tags, because the chain case starts from a
#: Chinese utterance and `_filter_static` matches on those strings.
ZH_MERCHANTS = [
    {"subject_id": "z1", "merchant_id": "z1", "subject_type": "merchant",
     "display_name": "沙田拉麵屋", "category_primary": "restaurant", "district": "Sha Tin",
     "avg_price_hkd": 120, "rating_agg": 4.5, "review_count": 10, "tags": ["拉麵"],
     "price_amount": 100},
    {"subject_id": "z2", "merchant_id": "z2", "subject_type": "merchant",
     "display_name": "觀塘拉麵店", "category_primary": "restaurant", "district": "Kwun Tong",
     "avg_price_hkd": 400, "rating_agg": 4.8, "review_count": 300, "tags": ["拉麵"],
     "price_amount": 380},
    {"subject_id": "z3", "merchant_id": "z3", "subject_type": "merchant",
     "display_name": "旺角拉麵館", "category_primary": "restaurant", "district": "Mong Kok",
     "avg_price_hkd": 250, "rating_agg": 4.2, "review_count": 40, "tags": ["拉麵"],
     "price_amount": 230},
]


async def _served(plan, merchants=MERCHANTS):
    cards, _, _, scored = await S.search(backend=S.StaticBackend(merchants=merchants), plan=plan)
    return [c.title for c in cards], [round(s.organic_score, 4) for s in scored]


@pytest.mark.asyncio
async def test_the_plan_preference_reorders_the_served_cards():
    # The reverse control is in the same run: the only difference between these two calls is
    # `sort_preference`, so the flip below can only come from the reader.
    relevance, _ = await _served(S.SearchPlan(limit=10))
    assert relevance == ["Yum Cha", "Sushi Zen", "Ramen House"]
    prices, _ = await _served(S.SearchPlan(limit=10, sort_preference="price_low"))
    assert prices == ["Ramen House", "Yum Cha", "Sushi Zen"]


@pytest.mark.asyncio
async def test_the_followup_sentence_reaches_the_served_order():
    # §34 end to end, offline: utterance -> merge_turn -> Intent -> SearchPlan -> served cards.
    # Nothing between the cue and the ranking table is hand-written here.
    state = {"intent": "discover_merchant", "language": "zh-HK", "raw_query": "拉麵"}
    first = S.plan_from_intent(merge_turn(state, "拉麵").as_intent_model())
    before, before_scores = await _served(first, ZH_MERCHANTS)
    assert before == ["觀塘拉麵店", "旺角拉麵館", "沙田拉麵屋"]  # the expensive one leads on merit

    second = S.plan_from_intent(merge_turn(state, "太贵了").as_intent_model())
    assert second.sort_preference == "price_low"
    after, after_scores = await _served(second, ZH_MERCHANTS)
    assert after == ["沙田拉麵屋", "旺角拉麵館", "觀塘拉麵店"]  # exactly reversed
    assert sorted(after_scores) == sorted(before_scores)  # reordered, not re-scored


@pytest.mark.asyncio
async def test_closer_orders_by_distance_only_when_distance_is_known():
    # "近一点" asks for the nearest answer. With no geo in the plan the static backend knows no
    # distances, so every card is missing the field and §8 forbids inventing one: the order is
    # the organic order, not an arbitrary one, and the answer set survives whole.
    state = {"intent": "discover_merchant", "language": "zh-HK", "raw_query": "拉麵"}
    plan = S.plan_from_intent(merge_turn(state, "近一点").as_intent_model())
    assert plan.sort_preference == "distance"
    titles, _ = await _served(plan, ZH_MERCHANTS)
    assert titles == ["觀塘拉麵店", "旺角拉麵館", "沙田拉麵屋"]
