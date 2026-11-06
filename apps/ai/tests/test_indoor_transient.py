"""D718 - `style/indoor` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `style/indoor` for "室內" / "indoor" etc. The stored-preference
path reads it against `outdoor_style` (inverse: not outdoor = indoor), but the transient
intent_preferences path had no branch for it - so a typed "室內" produced a preference
that scored nothing.

D718 adds the `style/indoor` branch to the transient path:
- outdoor_style: False → 1.0 (like indoor) / 0.0 (dislike indoor)
- outdoor_style: True → 0.0 (like indoor) / 1.0 (dislike indoor)
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


class TestIndoorExtraction:
    """The NLU emits `style/indoor` for indoor queries."""

    def test_室內_emits_style_indoor(self):
        prefs = _prefs("室內")
        assert _polarity(prefs, "style", "indoor") == 1

    def test_indoor_emits_style_indoor(self):
        prefs = _prefs("indoor")
        assert _polarity(prefs, "style", "indoor") == 1


class TestIndoorTransientRanks:
    """End-to-end: `style/indoor` in intent_preferences ranks merchants."""

    async def test_indoor_prefers_indoor_merchants(self):
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
                 "attributes": {"outdoor_style": False}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Outdoor Cafe", "display_name_zh": "戶外咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"outdoor_style": True}},
            ],
        )

        ex = extract_intent("室內")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        indoor_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        indoor_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert indoor_ok and indoor_no
        assert indoor_ok[0].organic_score > indoor_no[0].organic_score
