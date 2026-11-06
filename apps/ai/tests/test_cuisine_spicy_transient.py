"""D704 - `cuisine/spicy` emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `cuisine/spicy` when a user types "辣", "spicy",
"香辣" etc. The stored-preference path reads it against `spicy_cuisine`, but the
transient intent_preferences path used `cuisine_matches("spicy", ...)` which checks
for a "spicy" tag that no merchant carries - so it scored nothing.

D704 adds the `cuisine/spicy` branch to the transient path:
- spicy_cuisine: True → 1.0 (like) / 0.0 (dislike)
- spicy_cuisine: False → 0.0 (like) / 1.0 (dislike)
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


class TestCuisineSpicyExtraction:
    """The NLU emits `cuisine/spicy` for spicy queries."""

    def test_辣_emits_cuisine_spicy(self):
        prefs = _prefs("辣")
        assert _polarity(prefs, "cuisine", "spicy") == 1

    def test_spicy_emits_cuisine_spicy(self):
        prefs = _prefs("spicy")
        assert _polarity(prefs, "cuisine", "spicy") == 1


class TestCuisineSpicyTransientRanks:
    """End-to-end: `cuisine/spicy` in intent_preferences ranks merchants."""

    async def test_spicy_prefers_spicy_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Spicy Cafe", "display_name_zh": "辣咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"spicy_cuisine": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Mild Cafe", "display_name_zh": "淡咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"spicy_cuisine": False}},
            ],
        )

        ex = extract_intent("辣")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        spicy = [s for s in scored if s.candidate.subject_id == "m1"]
        mild = [s for s in scored if s.candidate.subject_id == "m2"]
        assert spicy and mild
        assert spicy[0].organic_score > mild[0].organic_score

    async def test_negated_spicy_prefers_non_spicy_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Spicy Cafe", "display_name_zh": "辣咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"spicy_cuisine": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Mild Cafe", "display_name_zh": "淡咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"spicy_cuisine": False}},
            ],
        )

        ex = extract_intent("唔食辣")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        spicy = [s for s in scored if s.candidate.subject_id == "m1"]
        mild = [s for s in scored if s.candidate.subject_id == "m2"]
        assert spicy and mild
        assert mild[0].organic_score > spicy[0].organic_score
