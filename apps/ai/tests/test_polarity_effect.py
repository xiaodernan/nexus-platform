"""D393 - the negated preference's effect end to end (nlu/understand + search/service).

The polarity is only worth having if it changes the ranking: a user who says "唔好安靜" wants
the LOUD place, and the pipeline must demote the quiet one rather than boost it.
"""

from __future__ import annotations

import json

import nexus_ai.search.service as S
from nexus_ai.nlu.understand import extract_intent


class SqlLikeBackend(S.StaticBackend):
    def __init__(self, *args, user_prefs=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._user_prefs = user_prefs or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id: str, kinds=None):
        return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]


def test_a_negated_preference_does_not_infer_a_category_from_it():
    ex = extract_intent("唔好安靜的地方", {"locale": "zh-HK"})
    prefs = {p["key"]: p for p in ex.preferences}
    assert prefs["ambience"]["polarity"] == -1
    # The inference reads the polarity: a dislike contributes -0.5, so the score never
    # reaches the threshold and the category stays null.
    assert ex.category is None


async def test_the_negated_preference_demotes_rather_than_boosts():
    backend = SqlLikeBackend(
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

    # The query says "not quiet": the loud place is the match.
    ex = extract_intent("唔好安靜的店", {"locale": "zh-HK"})
    plan = S.plan_from_intent(ex, query="店", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan,
                                            intent_preferences=ex.preferences)

    assert len(scored) == 2
    quiet = [s for s in scored if s.candidate.raw.get("row", {}).get("subject_id") == "m1"]
    loud = [s for s in scored if s.candidate.raw.get("row", {}).get("subject_id") == "m2"]
    assert quiet and loud
    # The quiet place is ranked BELOW the loud one, because the user asked for the opposite.
    assert loud[0].organic_score > quiet[0].organic_score
