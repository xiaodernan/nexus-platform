"""D714 - `access/mtr_near` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `access/mtr_near` for "地鐵" / "mtr" etc. The stored-preference
path reads it against `mtr_near_access` / `mtr_within_5min`, but the transient intent_preferences
path had no branch for it - so a typed "地鐵" produced a preference that scored nothing.

D714 adds the `access/mtr_near` branch to the transient path:
- mtr_near_access: True or mtr_within_5min: True → 1.0 (like) / 0.0 (dislike)
- mtr_near_access: False or mtr_within_5min: False → 0.0 (like) / 1.0 (dislike)
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


class TestMtrNearExtraction:
    """The NLU emits `access/mtr_near` for MTR queries."""

    def test_地鐵_emits_access_mtr_near(self):
        prefs = _prefs("地鐵")
        assert _polarity(prefs, "access", "mtr_near") == 1

    def test_mtr_emits_access_mtr_near(self):
        prefs = _prefs("mtr")
        assert _polarity(prefs, "access", "mtr_near") == 1


class TestMtrNearTransientRanks:
    """End-to-end: `access/mtr_near` in intent_preferences ranks merchants."""

    async def test_mtr_near_prefers_mtr_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "MTR Cafe", "display_name_zh": "地鐵咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"mtr_near_access": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "No MTR Cafe", "display_name_zh": "無地鐵咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"mtr_near_access": False}},
            ],
        )

        ex = extract_intent("地鐵")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        mtr_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        mtr_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert mtr_ok and mtr_no
        assert mtr_ok[0].organic_score > mtr_no[0].organic_score
