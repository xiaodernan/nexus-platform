"""D710 - `occasion/group` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `occasion/group` for "聚會" / "group" etc. The stored-preference
path reads it against `group_occasion`, but the transient intent_preferences path had no
branch for it - so a typed "聚會" produced a preference that scored nothing.

D710 adds the `occasion/group` branch to the transient path:
- group_occasion: True → 1.0 (like) / 0.0 (dislike)
- group_occasion: False → 0.0 (like) / 1.0 (dislike)
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


class TestOccasionGroupExtraction:
    """The NLU emits `occasion/group` for group queries."""

    def test_聚會_emits_occasion_group(self):
        prefs = _prefs("聚會")
        assert _polarity(prefs, "occasion", "group") == 1

    def test_group_emits_occasion_group(self):
        prefs = _prefs("group")
        assert _polarity(prefs, "occasion", "group") == 1


class TestOccasionGroupTransientRanks:
    """End-to-end: `occasion/group` in intent_preferences ranks merchants."""

    async def test_group_prefers_group_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Group Hall", "display_name_zh": "聚會餐廳",
                 "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["restaurant"],
                 "attributes": {"group_occasion": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Solo Cafe", "display_name_zh": "一人餐廳",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"group_occasion": False}},
            ],
        )

        ex = extract_intent("聚會")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        group_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        group_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert group_ok and group_no
        assert group_ok[0].organic_score > group_no[0].organic_score
