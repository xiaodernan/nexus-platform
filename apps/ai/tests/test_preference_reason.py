"""D392 - the card names the preference that matched (search/cards, §18 / §99).

`preference_match` existed as a reason label, but its text was the bare claim
"matches your preferences" — a bullet that said something happened without saying what. The
label now carries the preference that actually fired, so the bullet is checkable against the
user's own stated preference.
"""

from __future__ import annotations

import json

import pytest

import nexus_ai.search.service as S
from nexus_ai.search.cards import REASON_COPY, _reason_text
from nexus_ai.search.ranking import Candidate


class SqlLikeBackend(S.StaticBackend):
    def __init__(self, *args, user_prefs=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._user_prefs = user_prefs or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id: str, kinds=None):
        return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]


# --------------------------------------------------------------------------- the copy
def test_the_named_preference_copy_exists_for_every_locale():
    copy = REASON_COPY["preference_named"]
    assert set(copy) == {"zh-HK", "zh-CN", "en"}
    for text in copy.values():
        assert "{p}" in text


# --------------------------------------------------------------------------- the reason text
def test_a_named_preference_is_named_in_the_reason():
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": [{"label": "安靜", "source": "declared"}]})
    text = _reason_text("preference_match", cand, locale="zh-HK", open_state=None, query=None)
    assert "安靜" in text
    assert "偏好" in text


def test_english_names_the_preference_too():
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": [{"label": "quiet", "source": "declared"}]})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert "quiet" in text


def test_without_a_name_the_bullet_stays_the_generic_claim():
    # A preference the pipeline could not name must not invent a name for it.
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1", raw={})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert text == REASON_COPY["preference_match"]["en"]


def test_duplicate_names_are_collapsed():
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": [{"label": "quiet", "source": "declared"},
                                               {"label": "quiet", "source": "declared"},
                                               {"label": "near the MTR", "source": "declared"}]})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert text.count("quiet") == 1
    assert "near the MTR" in text


# --------------------------------------------------------------------------- end to end
async def test_the_card_names_the_preference_that_matched():
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Date Cafe", "display_name_zh": "静谧约会咖啡",
             "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
             "avg_price_hkd": 120, "tags": ["cafe"],
             "attributes": {"quiet_ambience": True, "date_occasion": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "ambience",
             "value": json.dumps({"value": "quiet"}),
             "weight": 0.9, "source": "inferred", "scope": "long_term"},
        ],
    )

    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")

    assert len(cards) == 1
    reasons = [r for r in (cards[0].ai_match.reasons if cards[0].ai_match else [])
               if r.label == "preference_match"]
    assert reasons, "the preference match produced no bullet"
    assert reasons[0].text != REASON_COPY["preference_match"]["zh-HK"], \
        "the bullet is still the generic claim"
    assert "安靜" in reasons[0].text
    # §18: every bullet must carry a fact id.
    assert reasons[0].fact_id is not None


async def test_a_preference_that_did_not_match_produces_no_name():
    # The merchant is loud, the user wants quiet: the score is a penalty, so the card must
    # not claim a preference match.
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Loud Bar", "display_name_zh": "热闹酒吧",
             "category_primary": "bar", "rating_agg": 4.5, "review_count": 30,
             "avg_price_hkd": 120, "tags": ["bar"],
             "attributes": {"quiet_ambience": False, "lively_ambience": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "ambience",
             "value": json.dumps({"value": "quiet"}),
             "weight": 0.9, "source": "inferred", "scope": "long_term"},
        ],
    )

    plan = S.SearchPlan(query_text="bar", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")

    assert len(cards) == 1
    labels = scored[0].candidate.raw.get("preference_labels") or []
    assert labels == []
