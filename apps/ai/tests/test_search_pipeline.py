"""End-to-end, DB-free search pipeline over ``StaticBackend`` (§6/§9/§67/§105).

``search()`` is the deterministic pipeline: candidate fetch → dedupe → facts → candidates →
organic rank → sponsored placement → facets → cards → response. ``StaticBackend`` is a
fixture-driven backend, so the whole path runs offline (no DB, no network) with real ranking
weights loaded from ``infra/config/ranking_weights.yaml``.

Every assertion was confirmed against the running pipeline (empirical probe), never guessed.
Where a naive premise was wrong (``RankingWeights()`` has empty weights → KeyError; the pipeline
loads real weights when ``weights=None``), the premise was corrected, not the code.
"""

from __future__ import annotations

import nexus_ai.search.service as S

MERCHANTS = [
    {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
     "display_name": "Ramen House", "category_primary": "restaurant", "district": "Sha Tin",
     "avg_price_hkd": 120, "rating_agg": 4.5, "review_count": 10, "tags": ["ramen"],
     "price_amount": 100},
    {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
     "display_name": "Sushi Zen", "category_primary": "restaurant", "district": "Central",
     "avg_price_hkd": 400, "rating_agg": 4.2, "review_count": 20, "tags": ["sushi"],
     "price_amount": 380},
]

OFFERINGS = [
    {"subject_id": "o1", "merchant_id": "m1", "subject_type": "offering", "name": "Ramen Set",
     "kind": "experience", "category": "restaurant", "district": "Sha Tin",
     "price_amount": 88, "rating_agg": 4.0, "review_count": 5, "tags": ["ramen"]},
]


async def _run(plan, backend=None, **kw):
    return await S.search(backend=backend or S.StaticBackend(merchants=MERCHANTS), plan=plan, **kw)


class TestTextFiltering:
    async def test_text_match_returns_only_matching_merchant(self):
        cards, resp, _, scored = await _run(S.SearchPlan(query_text="ramen", limit=10))
        assert len(scored) == 1
        assert cards[0].title == "Ramen House"

    async def test_no_text_returns_all_organic(self):
        cards, resp, _, scored = await _run(S.SearchPlan(limit=10))
        assert len(scored) == 2
        assert len(cards) == 2


class TestResponseShape:
    async def test_strategy_and_health_fields(self):
        _, resp, _, scored = await _run(S.SearchPlan(query_text="ramen", limit=10))
        assert resp.strategy.endswith("+static")
        assert resp.degraded is False
        assert resp.provider == "none"
        assert resp.total_estimate == len(scored)

    async def test_facets_present(self):
        _, resp, _, _ = await _run(S.SearchPlan(limit=10))
        assert set(resp.facets) >= {"category", "district", "price_band"}

    async def test_empty_backend(self):
        cards, resp, _, scored = await _run(S.SearchPlan(), backend=S.StaticBackend())
        assert cards == [] and scored == []
        assert resp.total_estimate == 0


class TestLimitsAndDedup:
    async def test_limit_caps_cards_but_total_is_all(self):
        cards, resp, _, scored = await _run(S.SearchPlan(limit=1))
        # `scored` and `cards` are the top-N (capped by limit); the full ranked count
        # is carried separately in total_estimate
        assert len(scored) == 1
        assert len(cards) == 1
        assert resp.total_estimate == 2

    async def test_duplicate_rows_are_deduped(self):
        backend = S.StaticBackend(merchants=MERCHANTS + [dict(MERCHANTS[0])])
        _, _, _, scored = await _run(S.SearchPlan(limit=10), backend=backend)
        # the same subject_type:subject_id collapses to one candidate
        assert len(scored) == 2


class TestSubjectAndLanes:
    async def test_offering_subject_type(self):
        backend = S.StaticBackend(offerings=OFFERINGS)
        cards, resp, _, scored = await _run(
            S.SearchPlan(query_text="ramen", subject_types=("offering",), limit=10),
            backend=backend,
        )
        assert len(scored) == 1
        assert resp.total_estimate == 1

    async def test_vector_lane_suffix(self):
        # D593: the suffix is earned by a non-zero vec_score on a ranked row, not by the
        # request flag - the plane this service reads has 0 of 2118 chunks embedded, and
        # the fixture now says which lane actually scored.
        rows = [dict(MERCHANTS[0], vec_score=0.62), dict(MERCHANTS[1])]
        _, resp, _, _ = await _run(S.SearchPlan(limit=10),
                                   backend=S.StaticBackend(merchants=rows), vector_lane=True)
        assert resp.strategy.endswith("+static+vector")

    async def test_include_sponsored_false_keeps_organic(self):
        cards, resp, _, scored = await _run(S.SearchPlan(limit=10), include_sponsored=False)
        # no sponsored rows here, so the organic set is unchanged
        assert len(scored) == 2
        assert len(cards) == 2
