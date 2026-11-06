"""D717 - `style/outdoor` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `style/outdoor` for "戶外" / "outdoor" etc. The stored-preference
path reads it against `outdoor_style`, but the transient intent_preferences path had no
branch for it - so a typed "戶外" produced a preference that scored nothing.

D717 adds the `style/outdoor` branch to the transient path:
- outdoor_style: True → 1.0 (like) / 0.0 (dislike)
- outdoor_style: False → 0.0 (like) / 1.0 (dislike)
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


class TestOutdoorExtraction:
    """The NLU emits `style/outdoor` for outdoor queries."""

    def test_戶外_emits_style_outdoor(self):
        prefs = _prefs("戶外")
        assert _polarity(prefs, "style", "outdoor") == 1

    def test_outdoor_emits_style_outdoor(self):
        prefs = _prefs("outdoor")
        assert _polarity(prefs, "style", "outdoor") == 1


class TestOutdoorTransientRanks:
    """End-to-end: `style/outdoor` in intent_preferences ranks merchants."""

    async def test_outdoor_prefers_outdoor_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Outdoor Cafe", "display_name_zh": "戶外咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"outdoor_style": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Indoor Cafe", "display_name_zh": "室内咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"outdoor_style": False}},
            ],
        )

        ex = extract_intent("戶外")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        outdoor_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        outdoor_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert outdoor_ok and outdoor_no
        assert outdoor_ok[0].organic_score > outdoor_no[0].organic_score
