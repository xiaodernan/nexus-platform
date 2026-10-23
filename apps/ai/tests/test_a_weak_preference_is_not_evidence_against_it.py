"""D527 - a weight below 0.5 is weak evidence FOR, never evidence AGAINST.

Every boolean preference matcher in the ranker read its weight the same way:

    return w if v else (1.0 - w)

That is only correct while `w > 0.5`. Below it the two sides CROSS: the outcome the user
asked for is scored BELOW the outcome they did not ask for. Measured, `access/accessible`
at the weight the seed itself declares (0.4):

    w=0.4:  accessible=0.4   not-accessible=0.6

A user who says "step-free access matters a little" was served the merchants that have
none above the merchants that have it - the D522 inversion, one signal over. It was
invisible because every weight in the demo corpus happens to sit above 0.5 (0.9, 0.8,
0.95, 0.6) except the one row the ranker could not read at all (D527's other half).

The fix reflects the weight at 0.5: the distance from neutral carries the strength, the
side of neutral carries the sign. A weight above 0.5 is untouched - `w=0.9` still answers
0.9 - so only the inverted half of the range moves.

This gate walks every boolean matcher the ranker has, at weights across the whole range,
and holds the ordering: the outcome the user asked for always scores above the one they
did not. It was **proved to fail**: restoring `w if v else (1.0 - w)` reddens every
sub-0.5 case here (the probe was put back).
"""

from __future__ import annotations

import asyncio
import json

import pytest

import nexus_ai.search.service as S

#: (kind, key, the preference value, the attrs that SATISFY it, the attrs that do not)
BOOLEAN_PREFERENCES = [
    ("access", "accessible", True,
     {"accessible_access": True, "wheelchair_access": True},
     {"accessible_access": False, "wheelchair_access": False}),
    ("access", "mtr_near", True,
     {"mtr_near_access": True, "mtr_within_5min": True},
     {"mtr_near_access": False, "mtr_within_5min": False}),
    ("access", "parking", True,
     {"parking_access": True}, {"parking_access": False}),
    ("access", "pet_friendly", True,
     {"pet_friendly_access": True}, {"pet_friendly_access": False}),
    ("view", "scenic", True,
     {"scenic_view": True}, {"scenic_view": False}),
    ("cuisine", "spicy", True,
     {"spicy_cuisine": True}, {"spicy_cuisine": False}),
    ("weather", "rainy_day", True,
     {"indoor_style": True}, {"outdoor_style": True}),
    ("time_pref", "open_late", True,
     {"opens_late": True}, {"opens_late": False}),
    ("style", "ambience", "quiet",
     {"quiet_ambience": True}, {"lively_ambience": True}),
    ("style", "ambience", "lively",
     {"lively_ambience": True}, {"quiet_ambience": True}),
    ("style", "outdoor", True,
     {"outdoor_style": True}, {"indoor_style": True}),
    ("style", "indoor", True,
     {"indoor_style": True}, {"outdoor_style": True}),
    # D528: the occasion matcher used to answer a hardcoded 1.0 / 0.0 and never read the
    # weight at all, so an occasion the user cares about a little swung the signal over
    # its whole range and one they care about a great deal swung it no further.
    ("occasion", "date", "date", {"date_occasion": True}, {"date_occasion": False}),
    ("occasion", "group", "group", {"group_occasion": True}, {"group_occasion": False}),
    ("occasion", "family", "family", {"family_occasion": True}, {"family_occasion": False}),
    ("occasion", "business", "business",
     {"business_occasion": True}, {"business_occasion": False}),
    ("occasion", "solo", "solo", {"solo_occasion": True}, {"solo_occasion": False}),
]

#: every weight the product's own data uses, plus the ones that used to invert
WEIGHTS = [0.2, 0.4, 0.5, 0.6, 0.8, 0.9, 0.95]

_IDS = [f"{kind}/{key}={value!r}" for kind, key, value, _y, _n in BOOLEAN_PREFERENCES]

#: `style/ambience` is a string enum ("quiet"/"lively"), not a boolean, so it has no
#: "refused" direction to check - a refusal of quiet IS a request for lively, and the
#: matcher already reads it that way.
_REFUSABLE = [row for row in BOOLEAN_PREFERENCES if isinstance(row[2], bool)]
_REFUSABLE_IDS = [f"{kind}/{key}" for kind, key, _v, _y, _n in _REFUSABLE]


class _Backend(S.StaticBackend):
    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id, kinds=None):
        return [dict(p) for p in self.prefs if str(p.get("user_id")) == user_id]


def _row(attrs):
    return {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
            "display_name": "Test Place", "display_name_zh": "測試場所",
            "category_primary": "Cantonese", "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": 100, "tags": ["cantonese"], "attributes": attrs,
            "kw_score": 0.5, "text_matched": True}


def _score(kind, key, value, weight, attrs):
    async def go():
        backend = _Backend(merchants=[_row(attrs)])
        backend.prefs = [{"user_id": "u1", "kind": kind, "key": key,
                          "value": json.dumps({"value": value}), "weight": weight,
                          "source": "declared", "scope": "long_term"}]
        plan = S.SearchPlan(query_text="place", limit=10)
        _cards, _resp, _bundle, scored = await S.search(backend=backend, plan=plan,
                                                        user_id="u1")
        return scored[0].candidate.personalization

    return asyncio.run(go())


@pytest.mark.parametrize("kind,key,value,yes,no", BOOLEAN_PREFERENCES, ids=_IDS)
@pytest.mark.parametrize("weight", WEIGHTS, ids=[f"w={w}" for w in WEIGHTS])
def test_the_outcome_the_user_asked_for_scores_above_the_one_they_did_not(
        kind, key, value, yes, no, weight):
    liked = _score(kind, key, value, weight, yes)
    avoided = _score(kind, key, value, weight, no)
    assert liked is not None and avoided is not None, (
        f"{kind}/{key} at weight {weight} answered {liked} / {avoided} - one side of the "
        f"preference is not read at all")
    # a weight of exactly 0.5 IS neutral, so it may answer the same number on both sides;
    # every other weight must put the satisfying merchant strictly ahead.
    assert liked >= avoided, (
        f"{kind}/{key}={value!r} at weight {weight} scores the merchant that SATISFIES it "
        f"at {liked} and the merchant that does not at {avoided} - a weak preference has "
        f"become evidence against the thing the user asked for")
    if weight != 0.5:
        assert liked > avoided, (
            f"{kind}/{key}={value!r} at weight {weight} answered {liked} on both sides - "
            f"the preference no longer separates anything")


@pytest.mark.parametrize("kind,key,value,yes,no", BOOLEAN_PREFERENCES, ids=_IDS)
def test_a_strong_preference_answers_the_number_it_always_answered(kind, key, value, yes, no):
    """The reflection must not move the half of the range that was already right."""
    assert _score(kind, key, value, 0.9, yes) == 0.9, (
        f"{kind}/{key} at weight 0.9 used to answer 0.9 for the satisfying merchant; it now "
        f"answers {_score(kind, key, value, 0.9, yes)}")
    assert _score(kind, key, value, 0.9, no) == pytest.approx(0.1), (
        f"{kind}/{key} at weight 0.9 used to answer 0.1 for the non-satisfying merchant")


@pytest.mark.parametrize("kind,key,value,yes,no", _REFUSABLE, ids=_REFUSABLE_IDS)
def test_a_refused_boolean_prefers_the_merchant_without_it(kind, key, value, yes, no):
    """The other direction: `{"value": false}` is a refusal, not a request."""
    liked = _score(kind, key, False, 0.4, no)
    avoided = _score(kind, key, False, 0.4, yes)
    assert liked > avoided, (
        f"{kind}/{key}=false at weight 0.4 scores the merchant WITHOUT it at {liked} and "
        f"the merchant WITH it at {avoided} - the refusal is inverted too")
