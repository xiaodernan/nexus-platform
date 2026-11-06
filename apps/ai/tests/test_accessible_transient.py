"""D715 - `access/accessible` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `access/accessible` for "輪椅" / "accessible" etc. The stored-preference
path reads it against `accessible_access` / `wheelchair_access`, but the transient intent_preferences
path had no branch for it - so a typed "輪椅" produced a preference that scored nothing.

D715 adds the `access/accessible` branch to the transient path:
- accessible_access: True or wheelchair_access: True → 1.0 (like) / 0.0 (dislike)
- accessible_access: False or wheelchair_access: False → 0.0 (like) / 1.0 (dislike)
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


class TestAccessibleExtraction:
    """The NLU emits `access/accessible` for accessible queries."""

    def test_輪椅_emits_access_accessible(self):
        prefs = _prefs("輪椅")
        assert _polarity(prefs, "access", "accessible") == 1

    def test_accessible_emits_access_accessible(self):
        prefs = _prefs("accessible")
        assert _polarity(prefs, "access", "accessible") == 1


class TestAccessibleTransientRanks:
    """End-to-end: `access/accessible` in intent_preferences ranks merchants."""

    async def test_accessible_prefers_accessible_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Accessible Cafe", "display_name_zh": "無障礙咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"accessible_access": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "No Access Cafe", "display_name_zh": "無障礙咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"accessible_access": False}},
            ],
        )

        ex = extract_intent("輪椅")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        accessible_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        accessible_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert accessible_ok and accessible_no
        assert accessible_ok[0].organic_score > accessible_no[0].organic_score
