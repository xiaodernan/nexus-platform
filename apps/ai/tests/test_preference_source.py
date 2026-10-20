"""D396 - a preference TYPED in this query and one the user DECLARED earlier are
different claims, and the card says which (§18 / §32-33 / §99).

The `user_preferences.source` column already carries the answer (`declared` = the user
told us, `inferred` = the platform's reading of their behaviour, `transaction` = something
they did), and the transient preferences a query carries are typed. The card's reason
bullet has to reflect the difference: "matches your preference" (a standing preference) and
"matches what you asked for" (this turn) are different claims about why the merchant is here.
"""

from __future__ import annotations

import json

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
def test_the_typed_copy_exists_for_every_locale():
    copy = REASON_COPY["preference_typed"]
    assert set(copy) == {"zh-HK", "zh-CN", "en"}
    for text in copy.values():
        assert "{p}" in text


def test_the_two_copies_are_different_claims():
    # The stored and the typed copy must not read the same, or the distinction is theatre.
    assert (REASON_COPY["preference_named"]["en"]
            != REASON_COPY["preference_typed"]["en"])


# --------------------------------------------------------------------------- the reason text
def test_a_declared_preference_says_it_is_a_standing_preference():
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": [{"label": "quiet", "source": "declared"}]})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert "quiet" in text
    assert "what you asked for" not in text


def test_a_typed_preference_says_it_is_this_turn():
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": [{"label": "quiet", "source": "typed"}]})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert "quiet" in text
    assert "what you asked for" in text


def test_both_kinds_are_named_when_both_fired():
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": [{"label": "quiet", "source": "declared"},
                                               {"label": "date", "source": "typed"}]})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert "quiet" in text
    assert "date" in text
    assert "what you asked for" in text


def test_a_legacy_string_label_still_reads_as_the_generic_claim():
    # A label that carries no source is not a claim about anything, so the generic copy
    # is the honest answer rather than an invented one.
    cand = Candidate(subject_type="merchant", subject_id="m1", merchant_id="m1",
                     raw={"preference_labels": ["quiet"]})
    text = _reason_text("preference_match", cand, locale="en", open_state=None, query=None)
    assert text == REASON_COPY["preference_match"]["en"]


# --------------------------------------------------------------------------- end to end
async def test_a_stored_preference_is_labelled_stored():
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
             "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
             "avg_price_hkd": 120, "tags": ["cafe"],
             "attributes": {"quiet_ambience": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "ambience",
             "value": json.dumps({"value": "quiet"}),
             "weight": 0.9, "source": "declared", "scope": "long_term"},
        ],
    )

    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")

    labels = scored[0].candidate.raw.get("preference_labels") or []
    assert labels and labels[0]["source"] == "declared"


async def test_a_typed_preference_is_labelled_typed():
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
             "category_primary": "cafe", "rating_agg": 4.5, "review_count": 30,
             "avg_price_hkd": 120, "tags": ["cafe"],
             "attributes": {"quiet_ambience": True}},
        ],
    )

    from nexus_ai.nlu.understand import extract_intent
    ex = extract_intent("想找個安靜的咖啡店", {"locale": "zh-HK"})
    plan = S.plan_from_intent(ex, query="咖啡店", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan,
                                            intent_preferences=ex.preferences)

    labels = scored[0].candidate.raw.get("preference_labels") or []
    assert labels and labels[0]["source"] == "typed"
