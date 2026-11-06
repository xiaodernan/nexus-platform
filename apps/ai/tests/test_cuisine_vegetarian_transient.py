"""D702 - `cuisine/vegetarian` emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `cuisine/vegetarian` when a user types "素食", "vegetarian"
etc. The stored-preference path reads it against `cuisine_vegetarian`, but the transient
intent_preferences path used `cuisine_matches("vegetarian", ...)` which checks for a
"vegetarian" tag that no merchant carries - so it scored nothing.

D702 adds the `cuisine/vegetarian` branch to the transient path:
- cuisine_vegetarian: True → 1.0 (like) / 0.0 (dislike)
- cuisine_vegetarian: False → 0.0 (like) / 1.0 (dislike)
- otherwise → neutral

Pure for the extraction part, DB-backed for the ranking part.
"""

from __future__ import annotations

from nexus_ai.nlu.understand import extract_intent


def _prefs(text: str) -> list[dict]:
    return extract_intent(text).preferences


def _polarity(prefs: list[dict], key: str, value: str) -> int | None:
    for p in prefs:
        if p.get("key") == key and p.get("value") == value:
            return int(p.get("polarity", 0))
    return None


class TestCuisineVegetarianExtraction:
    """The NLU emits `cuisine/vegetarian` for vegetarian queries."""

    def test_素食_emits_cuisine_vegetarian(self):
        prefs = _prefs("素食")
        assert _polarity(prefs, "cuisine", "vegetarian") == 1

    def test_vegan_emits_cuisine_vegetarian(self):
        prefs = _prefs("vegan")
        assert _polarity(prefs, "cuisine", "vegetarian") == 1


class TestCuisineVegetarianTransientRanks:
    """End-to-end: `cuisine/vegetarian` in intent_preferences ranks merchants."""

    async def test_vegetarian_prefers_vegetarian_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Veggie Cafe", "display_name_zh": "素食咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"cuisine_vegetarian": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Meat Cafe", "display_name_zh": "肉咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"cuisine_vegetarian": False}},
            ],
        )

        ex = extract_intent("素食")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        veg = [s for s in scored if s.candidate.subject_id == "m1"]
        meat = [s for s in scored if s.candidate.subject_id == "m2"]
        assert veg and meat
        assert veg[0].organic_score > meat[0].organic_score

    async def test_negated_vegetarian_prefers_non_vegetarian(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Veggie Cafe", "display_name_zh": "素食咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"cuisine_vegetarian": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Meat Cafe", "display_name_zh": "肉咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"cuisine_vegetarian": False}},
            ],
        )

        ex = extract_intent("唔好素食")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        veg = [s for s in scored if s.candidate.subject_id == "m1"]
        meat = [s for s in scored if s.candidate.subject_id == "m2"]
        assert veg and meat
        assert meat[0].organic_score > veg[0].organic_score
