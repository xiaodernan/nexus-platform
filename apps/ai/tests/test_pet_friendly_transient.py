"""D708 - `access/pet_friendly` emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `access/pet_friendly` for "寵物" / "pet friendly" etc.
The stored-preference path reads it against `pet_friendly_access`, but the transient
intent_preferences path had no branch for it - so a typed "寵物" produced a preference
that scored nothing.

D708 adds the `access/pet_friendly` branch to the transient path:
- pet_friendly_access: True → 1.0 (like) / 0.0 (dislike)
- pet_friendly_access: False → 0.0 (like) / 1.0 (dislike)
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


class TestPetFriendlyExtraction:
    """The NLU emits `access/pet_friendly` for pet-friendly queries."""

    def test_寵物_emits_access_pet_friendly(self):
        prefs = _prefs("寵物")
        assert _polarity(prefs, "access", "pet_friendly") == 1

    def test_pet_friendly_emits_access_pet_friendly(self):
        prefs = _prefs("pet friendly")
        assert _polarity(prefs, "access", "pet_friendly") == 1


class TestPetFriendlyTransientRanks:
    """End-to-end: `access/pet_friendly` in intent_preferences ranks merchants."""

    async def test_pet_friendly_prefers_pet_friendly_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Pet Cafe", "display_name_zh": "可帶寵物咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"pet_friendly_access": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "No Pet Cafe", "display_name_zh": "不可帶寵物咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"pet_friendly_access": False}},
            ],
        )

        ex = extract_intent("寵物")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        pet_friendly = [s for s in scored if s.candidate.subject_id == "m1"]
        not_pet_friendly = [s for s in scored if s.candidate.subject_id == "m2"]
        assert pet_friendly and not_pet_friendly
        assert pet_friendly[0].organic_score > not_pet_friendly[0].organic_score
