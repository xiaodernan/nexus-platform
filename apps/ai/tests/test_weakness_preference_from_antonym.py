"""D695 - a refused antonym surface produces a `weakness` preference alongside
the inverted ambience preference, so the ranking lane can demote merchants weak
at that aspect (`weak_aspects` LIST).

The quiet row carries 嘈 (noisy) in its token list ("嘈的餐廳" matched it and
inherited +1 before D582/D582). D570 wrote the REFUSAL direction ("唔好嘈" wants
quiet -> ambience/quiet +1). D695 writes the PRODUCTION direction: the same
refusal also emits `weakness:noise` so the ranking lane demotes merchants whose
`weak_aspects` names noise, on top of the ambience boost.

Four readings an antonym surface carries (from test_a_like_of_an_antonym_refuses_the_value):
    唔好嘈 / 唔想嘈     a refusal of it      ->  ambience/quiet +1, weakness:noise +1
    有冇嘈 / 有無嘈     a question about it  ->  ambience/quiet +1, no weakness (D533)
    嘈的餐廳            asks for it         ->  ambience/quiet -1, weakness:noise -1
    太嘈 / 好嘈          a bare mention     ->  ambience/quiet +1, no weakness (no frame)

Pure and DB-free for the polarity part; DB-backed for the ranking part.
"""

from __future__ import annotations


from nexus_ai.nlu.polarity import apply_polarity
from nexus_ai.nlu.understand import extract_intent


def _prefs(text: str) -> list[dict]:
    return extract_intent(text).preferences


def _polarity(prefs: list[dict], key: str, value: str) -> int | None:
    for p in prefs:
        if p.get("key") == key and p.get("value") == value:
            return int(p.get("polarity", 0))
    return None


class TestAntonymProducesWeaknessPreference:
    """`apply_polarity` appends a `weakness:<aspect>` preference when an antonym
    surface inverts the ambience preference."""

    def test_refusal_of_noise_produces_weakness_noise(self):
        # "唔好嘈" refuses noise -> wants quiet: ambience/quiet +1 AND weakness:noise +1
        prefs = _prefs("唔好嘈")
        assert _polarity(prefs, "ambience", "quiet") == 1
        assert _polarity(prefs, "weakness", "noise") == 1

    def test_question_about_noise_produces_no_weakness(self):
        # "有冇嘈" asks, does not want -> no weakness preference (D533)
        prefs = _prefs("有冇嘈")
        assert _polarity(prefs, "ambience", "quiet") == 1
        assert _polarity(prefs, "weakness", "noise") is None

    def test_want_of_noise_produces_weakness_noise_disliked(self):
        # "嘈的餐廳" asks for noise -> ambience/quiet -1, weakness:noise -1
        prefs = _prefs("嘈的餐廳")
        assert _polarity(prefs, "ambience", "quiet") == -1
        assert _polarity(prefs, "weakness", "noise") == -1

    def test_bare_mention_produces_no_weakness(self):
        # "太嘈" is a bare mention, no frame -> no weakness (D533)
        prefs = _prefs("太嘈")
        assert _polarity(prefs, "ambience", "quiet") == 1
        assert _polarity(prefs, "weakness", "noise") is None

    def test_weakness_preference_not_duplicated(self):
        # "唔好嘈，唔好嘈" should not produce two weakness preferences
        prefs = _prefs("唔好嘈，唔好嘈")
        noise_prefs = [p for p in prefs if p.get("key") == "weakness" and p.get("value") == "noise"]
        assert len(noise_prefs) == 1

    def test_apply_polarity_appends_weakness_directly(self):
        # Calling apply_polarity directly with a token map
        out = apply_polarity(
            [{"key": "ambience", "value": "quiet", "polarity": 1}],
            "唔好嘈",
            {("ambience", "quiet"): "嘈"},
        )
        keys = {(p["key"], p["value"]) for p in out}
        assert ("weakness", "noise") in keys
        weakness = [p for p in out if p.get("key") == "weakness"][0]
        assert weakness["polarity"] == 1


class TestWeaknessPreferenceRanksDemotively:
    """End-to-end: `weakness:noise` in intent_preferences demotes merchants weak
    at noise and boosts merchants not weak at noise."""

    async def test_weakness_noise_demotes_weak_merchants(self):
        import nexus_ai.search.service as S

        class StaticLikeBackend(S.StaticBackend):
            async def merchant_candidates(self, *, text=None, filters=None, **_kw):
                return [dict(r) for r in self.merchants]

        backend = StaticLikeBackend(
            merchants=[
                # m1: NOT quiet, weak at noise - worst match for "not noisy"
                {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
                 "display_name": "Loud Cafe", "display_name_zh": "熱鬧咖啡",
                 "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 120, "tags": ["cafe"],
                 "attributes": {"quiet_ambience": False, "weak_aspects": ["noise"]}},
                # m2: quiet, NOT weak at noise - best match for "not noisy"
                {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
                 "display_name": "Quiet Bar", "display_name_zh": "靜謐酒吧",
                 "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
                 "avg_price_hkd": 120, "tags": ["bar"],
                 "attributes": {"quiet_ambience": True, "weak_aspects": []}},
            ],
        )

        # "唔好嘈" -> ambience/quiet +1, weakness:noise +1
        ex = extract_intent("唔好嘈", {"locale": "zh-HK"})
        plan = S.plan_from_intent(ex, query="店", limit=10)
        cards, resp, _, scored = await S.search(
            backend=backend, plan=plan, intent_preferences=ex.preferences)

        assert len(scored) == 2
        quiet = [s for s in scored if s.candidate.raw.get("row", {}).get("subject_id") == "m2"]
        loud = [s for s in scored if s.candidate.raw.get("row", {}).get("subject_id") == "m1"]
        assert quiet and loud
        # Both preferences favor m2: quiet AND not weak at noise
        assert quiet[0].organic_score > loud[0].organic_score
