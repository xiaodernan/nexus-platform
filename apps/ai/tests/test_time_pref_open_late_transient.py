"""D701 - `time_pref/open_late` emitted by the NLU is read by the transient
intent_preferences ranking path.

The NLU's PREFERENCE_RULES emits `time_pref/open_late` when a user types "宵夜", "深夜",
"open late" etc. The stored-preference path reads it against `opens_late`, but the
transient intent_preferences path had no branch for it - so a typed "宵夜" produced
a preference that scored nothing.

D701 adds the `time_pref/open_late` branch to the transient path:
- opens_late: True → 1.0, opens_late: False → 0.0, otherwise neutral.

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


class TestOpenLateExtraction:
    """The NLU emits `time_pref/open_late` for late-night queries."""

    def test_宵夜_emits_open_late(self):
        prefs = _prefs("宵夜")
        assert _polarity(prefs, "time_pref", "open_late") == 1

    def test_深夜_emits_open_late(self):
        prefs = _prefs("深夜")
        assert _polarity(prefs, "time_pref", "open_late") == 1

    def test_open_late_emits_open_late(self):
        prefs = _prefs("open late")
        assert _polarity(prefs, "time_pref", "open_late") == 1


class TestOpenLateTransientRanks:
    """End-to-end: `time_pref/open_late` in intent_preferences ranks late-night merchants."""

    async def test_open_late_prefers_late_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Night Cafe", "display_name_zh": "宵夜咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"opens_late": True}},
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Early Cafe", "display_name_zh": "早咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 80, "tags": ["cafe"],
                 "attributes": {"opens_late": False}},
            ],
        )

        ex = extract_intent("宵夜")
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        late = [s for s in scored if s.candidate.subject_id == "m1"]
        early = [s for s in scored if s.candidate.subject_id == "m2"]
        assert late and early
        assert late[0].organic_score > early[0].organic_score
