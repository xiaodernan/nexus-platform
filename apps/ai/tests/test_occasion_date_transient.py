"""D709 - `occasion/date` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `occasion/date` for "約會" / "date" etc. The stored-preference
path reads it against `date_occasion`, but the transient intent_preferences path had no
branch for it - so a typed "約會" produced a preference that scored nothing.

D709 adds the `occasion/date` branch to the transient path:
- date_occasion: True → 1.0 (like) / 0.0 (dislike)
- date_occasion: False → 0.0 (like) / 1.0 (dislike)
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


class TestOccasionDateExtraction:
    """The NLU emits `occasion/date` for date queries."""

    def test_約會_emits_occasion_date(self):
        prefs = _prefs("約會")
        assert _polarity(prefs, "occasion", "date") == 1

    def test_date_emits_occasion_date(self):
        prefs = _prefs("date")
        assert _polarity(prefs, "occasion", "date") == 1


class TestOccasionDateTransientRanks:
    """End-to-end: `occasion/date` in intent_preferences ranks merchants."""

    async def test_date_prefers_date_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Date Spot", "display_name_zh": "約會餐廳",
                 "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["restaurant"],
                 "attributes": {"date_occasion": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Fast Food", "display_name_zh": "快餐店",
                 "category_primary": "fast_food", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["fast_food"],
                 "attributes": {"date_occasion": False}},
            ],
        )

        ex = extract_intent("約會")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        date_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        date_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert date_ok and date_no
        assert date_ok[0].organic_score > date_no[0].organic_score
