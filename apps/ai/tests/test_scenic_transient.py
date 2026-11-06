"""D707 - `view/scenic` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `view/scenic` for "海景" / "維港" / "景觀" / "rooftop" etc.
The stored-preference path reads it against `scenic_view`, but the transient
intent_preferences path had no branch for it - so a typed "海景" produced a preference
that scored nothing.

D707 adds the `view/scenic` branch to the transient path:
- scenic_view: True → 1.0 (like) / 0.0 (dislike)
- scenic_view: False → 0.0 (like) / 1.0 (dislike)
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


class TestScenicExtraction:
    """The NLU emits `view/scenic` for scenic queries."""

    def test_海景_emits_view_scenic(self):
        prefs = _prefs("海景")
        assert _polarity(prefs, "view", "scenic") == 1

    def test_rooftop_emits_view_scenic(self):
        prefs = _prefs("rooftop")
        assert _polarity(prefs, "view", "scenic") == 1


class TestScenicTransientRanks:
    """End-to-end: `view/scenic` in intent_preferences ranks scenic merchants."""

    async def test_scenic_prefers_scenic_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Harbor View", "display_name_zh": "維港景觀",
                 "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["restaurant"],
                 "attributes": {"scenic_view": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Street Cafe", "display_name_zh": "街头咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"scenic_view": False}},
            ],
        )

        ex = extract_intent("海景")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        scenic = [s for s in scored if s.candidate.subject_id == "m1"]
        nonscenic = [s for s in scored if s.candidate.subject_id == "m2"]
        assert scenic and nonscenic
        assert scenic[0].organic_score > nonscenic[0].organic_score
