"""D392 (addendum) - the transient (query-borne) preference also names itself on the card.

The stored-preference path names the preference that fired; the transient one (a preference the
user typed in THIS query) must do the same, or the card would say "matches your preferences"
for a query preference and "matches your preference: quiet" for a stored one, with no way to
tell which was which.
"""

from __future__ import annotations

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


async def test_the_transient_preference_names_itself_on_the_card():
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Date Cafe", "display_name_zh": "静谧约会咖啡",
             "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
             "avg_price_hkd": 120, "tags": ["cafe"],
             "attributes": {"quiet_ambience": True, "date_occasion": True}},
        ],
    )

    ex = extract_intent("想找個安靜的咖啡店", {"locale": "zh-HK"})
    plan = S.plan_from_intent(ex, query="咖啡店", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan,
                                            intent_preferences=ex.preferences)

    assert len(cards) == 1
    labels = scored[0].candidate.raw.get("preference_labels") or []
    assert labels, "the transient preference produced no label"
    assert "安靜" in "、".join(labels)


async def test_a_transient_preference_that_did_not_match_names_nothing():
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Loud Bar", "display_name_zh": "热闹酒吧",
             "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
             "avg_price_hkd": 120, "tags": ["bar"],
             "attributes": {"quiet_ambience": False, "lively_ambience": True}},
        ],
    )

    ex = extract_intent("想找個安靜的咖啡店", {"locale": "zh-HK"})
    plan = S.plan_from_intent(ex, query="咖啡店", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan,
                                            intent_preferences=ex.preferences)

    assert len(cards) == 1
    labels = scored[0].candidate.raw.get("preference_labels") or []
    assert labels == []
