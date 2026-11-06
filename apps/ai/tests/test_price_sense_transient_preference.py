"""D700 - `price_sense` (cheap/premium) emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `price_sense/cheap` when a user types "平", "cheap",
"便宜" etc. and `price_sense/premium` when a user types "貴", "premium", "米芝蓮" etc.
The stored-preference path (search/service.py line ~1790) reads it against
`avg_price_hkd`, but the transient intent_preferences path had no branch for it -
so a typed "平" produced a preference that scored nothing.

D700 adds the `price_sense` branch to the transient path:
- cheap: price <= 100 → 1.0, price <= 200 → 0.5, otherwise 0.0
- premium: price >= 400 → 1.0, price >= 200 → 0.5, otherwise 0.0

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


class TestPriceSenseExtraction:
    """The NLU emits `price_sense` for cheap/premium queries."""

    def test_cheap_emits_price_sense_cheap(self):
        prefs = _prefs("平")
        assert _polarity(prefs, "price_sense", "cheap") == 1

    def test_premium_emits_price_sense_premium(self):
        prefs = _prefs("高級")
        assert _polarity(prefs, "price_sense", "premium") == 1

    def test_negated_cheap_negates(self):
        prefs = _prefs("唔好平")
        assert _polarity(prefs, "price_sense", "cheap") == -1


class TestPriceSenseTransientRanks:
    """End-to-end: `price_sense` in intent_preferences ranks merchants by price."""

    async def test_cheap_prefers_cheap_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Cheap Cafe", "display_name_zh": "平咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"avg_price_hkd": 80, "tags": ["cafe"]}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Pricey Cafe", "display_name_zh": "貴咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 500, "tags": ["cafe"],
                 "attributes": {"avg_price_hkd": 500, "tags": ["cafe"]}},
            ],
        )

        ex = extract_intent("平")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        cheap = [s for s in scored if s.candidate.subject_id == "m1"]
        pricey = [s for s in scored if s.candidate.subject_id == "m2"]
        assert cheap and pricey
        assert cheap[0].organic_score > pricey[0].organic_score

    async def test_premium_prefers_premium_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Cheap Cafe", "display_name_zh": "平咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"avg_price_hkd": 80, "tags": ["cafe"]}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Pricey Cafe", "display_name_zh": "貴咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 500, "tags": ["cafe"],
                 "attributes": {"avg_price_hkd": 500, "tags": ["cafe"]}},
            ],
        )

        ex = extract_intent("貴")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        cheap = [s for s in scored if s.candidate.subject_id == "m1"]
        pricey = [s for s in scored if s.candidate.subject_id == "m2"]
        assert cheap and pricey
        assert pricey[0].organic_score > cheap[0].organic_score
