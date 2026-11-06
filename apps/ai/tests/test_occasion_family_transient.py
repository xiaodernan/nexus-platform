"""D711 - `occasion/family` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `occasion/family` for "親子" / "family" etc. The stored-preference
path reads it against `family_occasion`, but the transient intent_preferences path had no
branch for it - so a typed "親子" produced a preference that scored nothing.

D711 adds the `occasion/family` branch to the transient path:
- family_occasion: True → 1.0 (like) / 0.0 (dislike)
- family_occasion: False → 0.0 (like) / 1.0 (dislike)
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


class TestOccasionFamilyExtraction:
    """The NLU emits `occasion/family` for family queries."""

    def test_親子_emits_occasion_family(self):
        prefs = _prefs("親子")
        assert _polarity(prefs, "occasion", "family") == 1

    def test_family_emits_occasion_family(self):
        prefs = _prefs("家庭")
        assert _polarity(prefs, "occasion", "family") == 1


class TestOccasionFamilyTransientRanks:
    """End-to-end: `occasion/family` in intent_preferences ranks merchants."""

    async def test_family_prefers_family_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Family Hall", "display_name_zh": "家庭餐廳",
                 "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["restaurant"],
                 "attributes": {"family_occasion": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Solo Cafe", "display_name_zh": "一人餐廳",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"family_occasion": False}},
            ],
        )

        ex = extract_intent("親子")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        family_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        family_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert family_ok and family_no
        assert family_ok[0].organic_score > family_no[0].organic_score
