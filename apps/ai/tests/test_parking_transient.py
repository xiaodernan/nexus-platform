"""D716 - `access/parking` emitted by the NLU is read by the transient intent_preferences
ranking path.

The NLU's PREFERENCE_RULES emits `access/parking` for "停車場" / "parking" etc. The stored-preference
path reads it against `parking_access`, but the transient intent_preferences path had no
branch for it - so a typed "停車場" produced a preference that scored nothing.

D716 adds the `access/parking` branch to the transient path:
- parking_access: True → 1.0 (like) / 0.0 (dislike)
- parking_access: False → 0.0 (like) / 1.0 (dislike)
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


class TestParkingExtraction:
    """The NLU emits `access/parking` for parking queries."""

    def test_停車場_emits_access_parking(self):
        prefs = _prefs("停車場")
        assert _polarity(prefs, "access", "parking") == 1

    def test_parking_emits_access_parking(self):
        prefs = _prefs("parking")
        assert _polarity(prefs, "access", "parking") == 1


class TestParkingTransientRanks:
    """End-to-end: `access/parking` in intent_preferences ranks merchants."""

    async def test_parking_prefers_parking_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Parking Cafe", "display_name_zh": "有停車位咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"parking_access": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "No Parking Cafe", "display_name_zh": "無停車位咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"parking_access": False}},
            ],
        )

        ex = extract_intent("停車場")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        parking_ok = [s for s in scored if s.candidate.subject_id == "m1"]
        parking_no = [s for s in scored if s.candidate.subject_id == "m2"]
        assert parking_ok and parking_no
        assert parking_ok[0].organic_score > parking_no[0].organic_score
