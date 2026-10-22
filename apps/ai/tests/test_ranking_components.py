"""Contract tests for the ranking component math (``search/ranking``, §6/§67).

`ranking.py` is deliberately pure Python over a `Candidate` feature vector, so its invariants are
unit-testable without a database. `score_candidate`/`apply_sponsored` are pinned elsewhere
(D345/D347); this file pins the individual components: the Bayesian quality smoothing, the
distance/price/availability curves, the 0..1 quality rescale, the price bands and the facet
counts. Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import math

import pytest

import nexus_ai.search.ranking as R
from nexus_ai.search.ranking import (
    AvailabilityConfig,
    Candidate,
    DistanceConfig,
    PriceConfig,
    RankingWeights,
)

D = DistanceConfig()
A = AvailabilityConfig()
P = PriceConfig()
W = RankingWeights()


def _cand(**kw) -> Candidate:
    base = dict(subject_type="merchant", subject_id="m", merchant_id="m")
    base.update(kw)
    return Candidate(**base)


class TestBayesianQuality:
    def test_no_reviews_falls_back_to_tenant_mean(self):
        assert R.bayesian_quality(5.0, 0, 15, 3.5) == pytest.approx(3.5)

    def test_none_rating_falls_back_to_tenant_mean(self):
        assert R.bayesian_quality(None, 10, 15, 3.5) == pytest.approx(3.5)

    def test_smoothing_pulls_a_thin_sample_down(self):
        # (5*2 + 3.5*15) / 17
        assert R.bayesian_quality(5.0, 2, 15, 3.5) == pytest.approx(3.676471, abs=1e-6)

    def test_a_large_sample_keeps_its_rating(self):
        # (4.6*200 + 3.5*15) / 215
        assert R.bayesian_quality(4.6, 200, 15, 3.5) == pytest.approx(4.523256, abs=1e-6)

    def test_thin_high_rating_loses_to_thick_slightly_lower(self):
        # the docstring's claim: 5.0/2 reviews loses to 4.6/200
        assert R.bayesian_quality(5.0, 2, 15, 3.5) < R.bayesian_quality(4.6, 200, 15, 3.5)


class TestDistanceScore:
    def test_unknown_distance_is_neutral(self):
        assert R.distance_score(None, D) == D.neutral

    def test_zero_distance_is_one(self):
        assert R.distance_score(0, D) == 1.0

    def test_decay_at_the_decay_constant(self):
        assert R.distance_score(2500, D) == pytest.approx(math.exp(-1), abs=1e-6)

    def test_beyond_max_radius_is_floor(self):
        assert R.distance_score(16000, D) == 0.02

    def test_negative_distance_clamps_to_zero(self):
        assert R.distance_score(-5, D) == 1.0


class TestPriceFit:
    def test_unknown_price_is_neutral(self):
        assert R.price_fit(None, None, P) == 0.5

    def test_inside_budget_is_one(self):
        assert R.price_fit(100, 200, P) == 1.0

    def test_over_budget_decays(self):
        # log(400/200)/0.45, then exp(-x)
        assert R.price_fit(400, 200, P) == pytest.approx(0.214311, abs=1e-6)

    def test_over_hard_cap_is_zero(self):
        assert R.price_fit(401, 200, P) == 0.0

    def test_no_budget_uses_the_neutral_band(self):
        assert R.price_fit(100, None, P) == pytest.approx(0.57735, abs=1e-5)


class TestAvailabilityScore:
    def test_unknown_and_unrecognised(self):
        assert R.availability_score(None, A) == A.weight_when_unknown
        assert R.availability_score("unknown", A) == A.weight_when_unknown
        assert R.availability_score("bogus", A) == A.weight_when_unknown

    def test_known_states(self):
        assert R.availability_score("available", A) == 1.0
        assert R.availability_score("limited", A) == 0.6
        assert R.availability_score("full", A) == 0.05


class TestQualityComponent:
    def test_rescales_the_bayesian_rating_onto_0_1(self):
        # bayesian = 3.5 -> (3.5 - 1) / 4 = 0.625
        c = _cand(rating=5.0, rating_count=0, tenant_mean_rating=3.5)
        assert R.quality_component(c, W) == pytest.approx(0.625)


class TestPriceBand:
    @pytest.mark.parametrize("amount,band", [
        (None, "unknown"),
        (99, "$"),
        (100, "$$"),
        (299, "$$"),
        (300, "$$$"),
        (799, "$$$"),
        (800, "$$$$"),
    ])
    def test_boundaries(self, amount, band):
        assert R.price_band(amount) == band


class TestFacetCounts:
    def test_counts_and_skips_unknown_values(self):
        cs = [
            _cand(subject_id="a", district="Sha Tin", category="restaurant",
                  price=120, open_now=True),
            _cand(subject_id="b", district="Sha Tin", category="cafe",
                  price=60, open_now=False),
            _cand(subject_id="c", district=None, category=None, price=None, open_now=None),
        ]
        out = R.facet_counts(cs, ("district", "category", "price_band", "open_now"))
        assert out["district"] == {"Sha Tin": 2}
        assert out["category"] == {"restaurant": 1, "cafe": 1}
        assert out["price_band"] == {"$$": 1, "$": 1}
        assert out["open_now"] == {"open": 1, "closed": 1}

    def test_only_requested_facets_are_returned(self):
        out = R.facet_counts([_cand(district="Central")], ("district",))
        assert set(out) == {"district"}
