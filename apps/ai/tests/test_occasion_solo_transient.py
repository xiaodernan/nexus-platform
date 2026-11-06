"""D713 - `occasion/solo` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `occasion/solo` for "一個人" / "solo" etc. The stored-preference
path reads it against `solo_occasion`, but the transient intent_preferences path had no
branch for it - so a typed "一個人" produced a preference that scored nothing.

D713 adds the `occasion/solo` branch to the transient path:
- solo_occasion: True → 1.0 (like) / 0.0 (dislike)
- solo_occasion: False → 0.0 (like) / 1.0 (dislike)
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


class TestOccasionSoloExtraction:
    """The NLU emits `occasion/solo` for solo queries."""

    def test_一個人_emits_occasion_solo(self):
        prefs = _prefs("一個人")
        assert _polarity(prefs, "occasion", "solo") == 1

    def test_solo_emits_occasion_solo(self):
        prefs = _prefs("solo")
        assert _polarity(prefs, "occasion", "solo") == 1


class TestOccasionSoloTransientRanks:
    """End-to-end: `occasion/solo` in intent_preferences ranks merchants."""

    async def test_solo_prefers_solo_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Solo Cafe", "display_name_zh": "一人餐廳",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"solo_occasion": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Family Hall", "display_name_zh": "家庭餐廳",
                 "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["restaurant"],
                 "attributes": {"solo_occasion": False}},
            ],
        )

        ex = extract_intent("一個人")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        solo_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        solo_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert solo_ok and solo_no
        assert solo_ok[0].organic_score > solo_no[0].organic_score
