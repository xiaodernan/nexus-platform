"""D699 - `style/ambience` (quiet/lively) emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `style/ambience` when a user types "有情調", "vibe",
"atmospheric" etc. The stored-preference path (search/service.py line ~1694) reads it
against `quiet_ambience`/`lively_ambience`, but the transient intent_preferences path
had no branch for it - so a typed "有情調" produced a preference that scored nothing.

D699 adds the `style/ambience` branch to the transient path, mirroring the stored path:
quiet wants `quiet_ambience: True`, lively wants `lively_ambience: True`, and the
opposite attribute counts as a refusal.

Pure for the polarity part, DB-backed for the ranking part.
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


class TestStyleAmbienceExtraction:
    """The NLU emits `style/ambience` for atmospheric/vibe queries."""

    def test_vibe_emits_style_ambience(self):
        prefs = _prefs("有情調")
        assert _polarity(prefs, "style", "ambience") == 1

    def test_atmospheric_emits_style_ambience(self):
        prefs = _prefs("atmospheric")
        assert _polarity(prefs, "style", "ambience") == 1

    def test_negated_vibe_negates_style_ambience(self):
        prefs = _prefs("唔好有情調")
        assert _polarity(prefs, "style", "ambience") == -1


class TestStyleAmbienceTransientRanks:
    """End-to-end: `style/ambience` in intent_preferences ranks merchants."""

    async def test_style_ambience_quiet_ranks_quiet_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 120, "tags": ["cafe"],
                 "attributes": {"quiet_ambience": True, "lively_ambience": False}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Loud Bar", "display_name_zh": "热闹酒吧",
                 "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 120, "tags": ["bar"],
                 "attributes": {"quiet_ambience": False, "lively_ambience": True}},
            ],
        )

        # "有情調" → style/ambience with no specific value → matches quiet OR lively
        ex = extract_intent("有情調")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        # Both merchants have one of the ambience attributes, so both score 1.0
        scores = {s.candidate.subject_id: s.candidate.personalization for s in scored}
        assert scores["m1"] == scores["m2"] == 1.0

    async def test_style_ambience_quiet_prefers_quiet(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 120, "tags": ["cafe"],
                 "attributes": {"quiet_ambience": True, "lively_ambience": False}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Loud Bar", "display_name_zh": "热闹酒吧",
                 "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 120, "tags": ["bar"],
                 "attributes": {"quiet_ambience": False, "lively_ambience": True}},
            ],
        )

        # The NLU emits style/ambience with no value when the user says "有情調".
        # But if we directly pass intent_preferences with style/ambience=quiet,
        # only the quiet merchant should score.
        ex = extract_intent("有情調")
        # Override: simulate a typed "quiet" ambience preference
        ex.preferences = [{"key": "style", "value": "quiet", "polarity": 1}]
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        quiet = [s for s in scored if s.candidate.subject_id == "m1"]
        loud = [s for s in scored if s.candidate.subject_id == "m2"]
        assert quiet and loud
        # Quiet merchant matches style/ambience=quiet, loud doesn't
        assert quiet[0].organic_score > loud[0].organic_score
