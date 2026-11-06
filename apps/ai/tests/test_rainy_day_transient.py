"""D703 - `weather/rainy_day` emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `weather/rainy_day` when a user types "下雨", "rainy",
"颱風" etc. The stored-preference path reads it against `indoor_style`/`outdoor_style`,
but the transient intent_preferences path had no branch for it - so a typed "下雨"
produced a preference that scored nothing.

D703 adds the `weather/rainy_day` branch to the transient path:
- indoor_style: True → 1.0 (like), outdoor_style: True → 0.0 (dislike)
- indoor_style: False → 0.0 (like), outdoor_style: False → 1.0 (dislike)
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


class TestRainyDayExtraction:
    """The NLU emits `weather/rainy_day` for rainy queries."""

    def test_下雨_emits_rainy_day(self):
        prefs = _prefs("下雨")
        assert _polarity(prefs, "weather", "rainy_day") == 1

    def test_rainy_emits_rainy_day(self):
        prefs = _prefs("rainy")
        assert _polarity(prefs, "weather", "rainy_day") == 1


class TestRainyDayTransientRanks:
    """End-to-end: `weather/rainy_day` in intent_preferences ranks merchants."""

    async def test_rainy_prefers_indoor_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Indoor Cafe", "display_name_zh": "室内咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"indoor_style": True, "outdoor_style": False}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Outdoor Cafe", "display_name_zh": "露天咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"indoor_style": False, "outdoor_style": True}},
            ],
        )

        ex = extract_intent("下雨")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        indoor = [s for s in scored if s.candidate.subject_id == "m1"]
        outdoor = [s for s in scored if s.candidate.subject_id == "m2"]
        assert indoor and outdoor
        assert indoor[0].organic_score > outdoor[0].organic_score
