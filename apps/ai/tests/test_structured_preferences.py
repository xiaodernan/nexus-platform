"""Test structured preference value matching (D384)."""

from __future__ import annotations

import json
from typing import Sequence

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


# Test occasion preferences (date, group, family, business, solo)
async def test_occasion_date_preference_boosts_date_venues():
    """Occasion=date preference should boost merchants with date_occasion=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Date Cafe", "display_name_zh": "约会咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"date_occasion": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Regular Cafe", "display_name_zh": "普通咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"date_occasion": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "occasion", "key": "date",
             "value": json.dumps({"value": "date"}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("date_occasion") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5  # date_occasion=true -> boost
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5  # date_occasion=false -> penalty


async def test_occasion_group_preference_boosts_group_venues():
    """Occasion=group preference should boost merchants with group_occasion=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Party Place", "display_name_zh": "聚会场所",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"group_occasion": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Quiet Place", "display_name_zh": "安静场所",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"group_occasion": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "occasion", "key": "group",
             "value": json.dumps({"value": "group"}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="restaurant", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("group_occasion") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_view_scenic_preference_boosts_scenic_venues():
    """View=scenic preference should boost merchants with scenic_view=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Scenic View Cafe", "display_name_zh": "景观咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"scenic_view": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Regular Cafe", "display_name_zh": "普通咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"scenic_view": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "view", "key": "scenic",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("scenic_view") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_access_mtr_near_preference_boosts_mtr_venues():
    """Access=mtr_near preference should boost merchants with mtr_near_access=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "MTR Cafe", "display_name_zh": "港铁咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"mtr_near_access": True, "mtr_within_5min": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Far Cafe", "display_name_zh": "远处咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"mtr_near_access": False, "mtr_within_5min": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "access", "key": "mtr_near",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("mtr_near_access") is True or attrs.get("mtr_within_5min") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_access_accessible_preference_boosts_accessible_venues():
    """Access=accessible preference should boost merchants with accessible_access=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Accessible Place", "display_name_zh": "无障碍场所",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"accessible_access": True, "wheelchair_access": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Stairs Only", "display_name_zh": "仅楼梯",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"accessible_access": False, "wheelchair_access": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "access", "key": "accessible",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="restaurant", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("accessible_access") is True or attrs.get("wheelchair_access") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_access_parking_preference_boosts_parking_venues():
    """Access=parking preference should boost merchants with parking_access=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Parking Mall", "display_name_zh": "有停车商场",
             "category_primary": "mall", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"parking_access": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "No Parking", "display_name_zh": "无停车",
             "category_primary": "mall", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"parking_access": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "access", "key": "parking",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="mall", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("parking_access") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_access_pet_friendly_preference_boosts_pet_venues():
    """Access=pet_friendly preference should boost merchants with pet_friendly_access=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Pet Cafe", "display_name_zh": "宠物咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"pet_friendly_access": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "No Pets", "display_name_zh": "禁宠",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"pet_friendly_access": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "access", "key": "pet_friendly",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("pet_friendly_access") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_price_sense_cheap_preference_boosts_cheap_venues():
    """Price_sense=cheap preference should boost merchants with low prices."""
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
            {"user_id": "u1", "kind": "price_sense", "key": "cheap",
             "value": json.dumps({"value": "cheap"}),
             "weight": 0.9, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="eats", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        price = row.get("avg_price_hkd")
        if price == 50:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5  # within cheap range -> boost
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5  # expensive -> penalty


async def test_price_sense_premium_preference_boosts_premium_venues():
    """Price_sense=premium preference should boost merchants with high prices."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Fine Dining", "display_name_zh": "高级餐厅",
             "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 20,
             "avg_price_hkd": 500,
             "attributes": {"data_origin": "demo"},
             "kw_score": 0.5, "text_matched": True},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Cheap Eats", "display_name_zh": "平价小吃",
             "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 10,
             "avg_price_hkd": 50,
             "attributes": {"data_origin": "demo"},
             "kw_score": 0.5, "text_matched": True},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "price_sense", "key": "premium",
             "value": json.dumps({"value": "premium"}),
             "weight": 0.9, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="dining", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        price = row.get("avg_price_hkd")
        if price == 500:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5  # premium price -> boost
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5  # cheap -> penalty


async def test_weather_rainy_day_preference_boosts_indoor_venues():
    """Weather=rainy_day preference should boost indoor venues."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Indoor Mall", "display_name_zh": "室内商场",
             "category_primary": "mall", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"indoor_style": True, "outdoor_style": False}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Outdoor Park", "display_name_zh": "户外公园",
             "category_primary": "park", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"indoor_style": False, "outdoor_style": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "weather", "key": "rainy_day",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="place", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("indoor_style") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_time_pref_open_late_preference_boosts_late_venues():
    """Time_pref=open_late preference should boost merchants that open late."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Late Bar", "display_name_zh": "深夜酒吧",
             "category_primary": "bar", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"opens_late": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Early Cafe", "display_name_zh": "早起咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"opens_late": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "time_pref", "key": "open_late",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="drink", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("opens_late") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_cuisine_spicy_preference_boosts_spicy_venues():
    """Cuisine=spicy preference should boost merchants with spicy_cuisine=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Spicy Hotpot", "display_name_zh": "麻辣火锅",
             "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 10,
             "attributes": {"spicy_cuisine": True},
             "kw_score": 0.5, "text_matched": True},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Mild Cafe", "display_name_zh": "清淡咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 20,
             "attributes": {"spicy_cuisine": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "cuisine", "key": "spicy",
             "value": json.dumps({"value": True}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="food", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("spicy_cuisine") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_style_outdoor_preference_boosts_outdoor_venues():
    """Style=outdoor preference should boost merchants with outdoor_style=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Outdoor Cafe", "display_name_zh": "户外咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"outdoor_style": True, "indoor_style": False}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Indoor Cafe", "display_name_zh": "室内咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"outdoor_style": False, "indoor_style": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "outdoor",
             "value": json.dumps({"value": "outdoor"}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("outdoor_style") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


async def test_style_indoor_preference_boosts_indoor_venues():
    """Style=indoor preference should boost merchants with indoor_style=true."""
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Indoor Cafe", "display_name_zh": "室内咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"indoor_style": True, "outdoor_style": False}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Outdoor Cafe", "display_name_zh": "户外咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"indoor_style": False, "outdoor_style": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "indoor",
             "value": json.dumps({"value": "indoor"}),
             "weight": 0.8, "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        attrs = row.get("attributes", {})
        if attrs.get("indoor_style") is True:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5


if __name__ == "__main__":
    import asyncio
    asyncio.run(test_cuisine_like_preference_matches_merchant_category())
    asyncio.run(test_cuisine_dislike_preference_penalizes_matching_merchant())
    asyncio.run(test_budget_preference_within_budget_boosts())
    asyncio.run(test_home_district_preference_boosts())
    asyncio.run(test_ambience_preference_matches_boolean_attributes())
    asyncio.run(test_accessibility_preference_matches_boolean())
    asyncio.run(test_occasion_date_preference_boosts_date_venues())
    asyncio.run(test_occasion_group_preference_boosts_group_venues())
    asyncio.run(test_view_scenic_preference_boosts_scenic_venues())
    asyncio.run(test_access_mtr_near_preference_boosts_mtr_venues())
    asyncio.run(test_access_accessible_preference_boosts_accessible_venues())
    asyncio.run(test_access_parking_preference_boosts_parking_venues())
    asyncio.run(test_access_pet_friendly_preference_boosts_pet_venues())
    asyncio.run(test_price_sense_cheap_preference_boosts_cheap_venues())
    asyncio.run(test_price_sense_premium_preference_boosts_premium_venues())
    asyncio.run(test_weather_rainy_day_preference_boosts_indoor_venues())
    asyncio.run(test_time_pref_open_late_preference_boosts_late_venues())
    asyncio.run(test_cuisine_spicy_preference_boosts_spicy_venues())
    asyncio.run(test_style_outdoor_preference_boosts_outdoor_venues())
    asyncio.run(test_style_indoor_preference_boosts_indoor_venues())
    print("All tests passed!")