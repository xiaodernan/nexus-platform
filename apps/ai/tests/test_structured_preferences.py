"""Test structured preference value matching (D384)."""

from __future__ import annotations

import json

import pytest

import nexus_ai.search.service as S

# SqlLikeBackend that does not filter on text (like real SQL backend)
class SqlLikeBackend(S.StaticBackend):
    def __init__(self, *args, user_prefs=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._user_prefs = user_prefs or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id: str, kinds=None):
        return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]



class StructuredPrefBackend(S.StaticBackend):
    """StaticBackend that also supports user_preferences for testing."""
    
    def __init__(self, *args, user_prefs=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._user_prefs = user_prefs or []
    
    async def user_preferences(self, user_id: str, kinds: Sequence[str] | None = None) -> list[dict]:
        return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]


async def test_cuisine_like_preference_matches_merchant_category():
    """A cuisine_like preference with array values should match merchant category/tags."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Cantonese Place", "display_name_zh": "广东饭店",
             "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 10,
             "tags": ["cantonese", "dim_sum"],
             "attributes": {"data_origin": "demo"}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Sushi Bar", "display_name_zh": "寿司吧",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 20,
             "tags": ["japanese", "sushi"],
             "attributes": {"data_origin": "demo"}},
            {"subject_id": "m3", "merchant_id": "m3", "subject_type": "merchant",
             "display_name": "Coffee Shop", "display_name_zh": "咖啡店",
             "category_primary": "cafe", "rating_agg": 4.2, "review_count": 15,
             "tags": ["coffee", "specialty-coffee"],
             "attributes": {"data_origin": "demo"}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "food", "key": "cuisine_like",
             "value": json.dumps({"values": ["cantonese", "sushi", "specialty-coffee"]}),
             "weight": 0.9, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="food", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    # All three should match (cantonese, sushi, specialty-coffee in tags)
    assert len(scored) == 3
    # Check personalization scores - all should have positive personalization
    for s in scored:
        assert s.candidate.personalization is not None
        assert s.candidate.personalization > 0.5  # weight 0.9 > neutral 0.5


async def test_cuisine_dislike_preference_penalizes_matching_merchant():
    """A cuisine_dislike preference should penalize merchants with that cuisine."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Spicy Hotpot", "display_name_zh": "麻辣火锅",
             "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 10,
             "tags": ["hotpot", "spicy", "sichuan"],
             "attributes": {"data_origin": "demo", "spicy_cuisine": True},
             "kw_score": 0.5, "text_matched": True},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Mild Cafe", "display_name_zh": "清淡咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 20,
             "tags": ["coffee", "light-meal"],
             "attributes": {"data_origin": "demo", "spicy_cuisine": False},
             "kw_score": 0.5, "text_matched": True},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "food", "key": "cuisine_dislike",
             "value": json.dumps({"values": ["spicy"]}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="food", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    # Find the spicy one - should have low personalization (penalty)
    for s in scored:
        row = s.candidate.raw.get("row", {})
        if row.get("display_name_zh") == "麻辣火锅":
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5  # penalty
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5  # no penalty, slight boost from neutral


async def test_budget_preference_within_budget_boosts():
    """Budget preference should boost merchants within budget."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Cheap Eats", "display_name_zh": "平价小吃",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
             "avg_price_hkd": 50,
             "attributes": {"data_origin": "demo"},
             "kw_score": 0.5, "text_matched": True},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Fine Dining", "display_name_zh": "高级餐厅",
             "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 20,
             "avg_price_hkd": 500,
             "attributes": {"data_origin": "demo"},
             "kw_score": 0.5, "text_matched": True},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "budget", "key": "per_person_max_hkd",
             "value": json.dumps({"value": 100, "currency": "HKD"}),
             "weight": 0.95, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="eats", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        if row.get("avg_price_hkd") == 50:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5  # within budget -> boost
        else:
            # Over budget should get penalty (inverted weight)
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_home_district_preference_boosts():
    """Home district preference should boost merchants in that district."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Sha Tin Cafe", "display_name_zh": "沙田咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "district": "Sha Tin",
             "attributes": {"data_origin": "demo"}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Central Bar", "display_name_zh": "中环酒吧",
             "category_primary": "bar", "rating_agg": 4.2, "review_count": 20,
             "district": "Central",
             "attributes": {"data_origin": "demo"}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "location", "key": "home_district",
             "value": json.dumps({"value": "Sha Tin", "lat": 22.3831, "lng": 114.1876}),
             "weight": 1.0, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        if row.get("district") == "Sha Tin":
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5  # district match -> boost
        else:
            assert s.candidate.personalization is None or s.candidate.personalization <= 0.5


async def test_ambience_preference_matches_boolean_attributes():
    """Style/ambience preference should match boolean attributes."""
    # Use a SqlLikeBackend that does not filter on text (like the real SQL backend)
    # Use a SqlLikeBackend that does not filter on text (like the real SQL backend)
    class SqlLikeBackend(S.StaticBackend):
        def __init__(self, *args, user_prefs=None, **kwargs):
            super().__init__(*args, **kwargs)
            self._user_prefs = user_prefs or []

        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

        async def user_preferences(self, user_id: str, kinds=None):
            return [dict(p) for p in self._user_prefs if str(p.get('user_id')) == user_id]

    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"quiet_ambience": True, "lively_ambience": False}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Lively Bar", "display_name_zh": "热闹酒吧",
             "category_primary": "bar", "rating_agg": 4.2, "review_count": 20,
             "attributes": {"quiet_ambience": False, "lively_ambience": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "ambience",
             "value": json.dumps({"value": "quiet"}),
             "weight": 0.7, "source": "inferred", "scope": "long_term"},
        ]
    )

    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")

    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        name = row.get("display_name_zh", "")
        if name == "静谧咖啡":
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5

