"""D706 - `ambience/quiet` and `ambience/lively` emitted by the NLU are read by the
transient intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `ambience/quiet` for "安靜" etc. and `ambience/lively`
for "熱鬧" etc. The stored-preference path reads them against `quiet_ambience` /
`lively_ambience`, but the transient intent_preferences path only handled `style/ambience`
(D699) - a typed "安靜" produced a preference that scored nothing.

D706 adds the `ambience/quiet` / `ambience/lively` branch to the transient path:
- quiet_ambience: True → 1.0 (like quiet) / 0.0 (dislike quiet)
- lively_ambience: True → 1.0 (like lively) / 0.0 (dislike lively)
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


class TestAmbienceExtraction:
    """The NLU emits `ambience/quiet` and `ambience/lively` for ambience queries."""

    def test_安靜_emits_ambience_quiet(self):
        prefs = _prefs("安靜")
        assert _polarity(prefs, "ambience", "quiet") == 1

    def test_熱鬧_emits_ambience_lively(self):
        prefs = _prefs("熱鬧")
        assert _polarity(prefs, "ambience", "lively") == 1

    def test_quiet_emits_ambience_quiet(self):
        prefs = _prefs("quiet")
        assert _polarity(prefs, "ambience", "quiet") == 1


class TestAmbienceTransientRanks:
    """End-to-end: `ambience/quiet` / `ambience/lively` in intent_preferences ranks merchants."""

    async def test_quiet_prefers_quiet_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"quiet_ambience": True, "lively_ambience": False}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Loud Bar", "display_name_zh": "热闹酒吧",
                 "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["bar"],
                 "attributes": {"quiet_ambience": False, "lively_ambience": True}},
            ],
        )

        ex = extract_intent("安靜")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        quiet = [s for s in scored if s.candidate.subject_id == "m1"]
        lively = [s for s in scored if s.candidate.subject_id == "m2"]
        assert quiet and lively
        assert quiet[0].organic_score > lively[0].organic_score

    async def test_lively_prefers_lively_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"quiet_ambience": True, "lively_ambience": False}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Loud Bar", "display_name_zh": "热闹酒吧",
                 "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["bar"],
                 "attributes": {"quiet_ambience": False, "lively_ambience": True}},
            ],
        )

        ex = extract_intent("熱鬧")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        quiet = [s for s in scored if s.candidate.subject_id == "m1"]
        lively = [s for s in scored if s.candidate.subject_id == "m2"]
        assert quiet and lively
        assert lively[0].organic_score > quiet[0].organic_score
