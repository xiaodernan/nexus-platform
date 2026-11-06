"""D719 - `view/scenic` also matches merchants whose name/description contains
scenic-related keywords, not just those with `scenic_view: True`.

The seed writes `scenic_view` on only 10 of 520 merchants (1.9%), so a typed
"海景" (sea view) previously matched almost nothing. D707 added the transient
handler, but it only checked `scenic_view: True`. D719 also matches merchants
whose name or description contains scenic keywords (海景, 維港, 景觀, rooftop,
etc.) - the same words the NLU reads as scenic cues.

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
    """End-to-end: `view/scenic` in intent_preferences ranks scenic merchants,
    including those whose name/description contains scenic keywords but whose
    `scenic_view` attribute is not set."""

    async def test_scenic_prefers_scenic_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Harbor View Hotel", "display_name_zh": "維港景觀酒店",
                 "category_primary": "hotel", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 500, "tags": ["hotel"],
                 "attributes": {"scenic_view": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Sea View Restaurant", "display_name_zh": "海景餐廳",
                 "category_primary": "restaurant", "rating_agg": 4.0, "review_count": 20,
                 "avg_price_hkd": 300, "tags": ["seafood"],
                 "attributes": {}},  # no scenic_view attribute, but name contains 海景
                {"subject_id": "m3", "merchant_id": "m3", "subject_type": "merchant",
                 "display_name": "Plain Cafe", "display_name_zh": "普通咖啡",
                 "category_primary": "cafe", "rating_agg": 4.0, "review_count": 15,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {}},  # no scenic_view, no scenic keywords
            ],
        )

        ex = extract_intent("海景")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 3
        scenic = [s for s in scored if s.candidate.subject_id == "m1"]
        sea_view = [s for s in scored if s.candidate.subject_id == "m2"]
        plain = [s for s in scored if s.candidate.subject_id == "m3"]
        assert scenic and sea_view and plain
        # Both scenic_view=True and name-containing-海景 should rank above plain
        assert scenic[0].organic_score > plain[0].organic_score
        assert sea_view[0].organic_score > plain[0].organic_score
