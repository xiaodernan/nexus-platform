"""D529 - a refusal was evidence FOR everything else, at full strength.

The transient path - the one that serves the preferences the user typed in THIS query -
answered a cuisine preference it could not match with the side of neutral the user was
NOT on:

    a cuisine the user LIKED    -> 0.5   (no evidence either way)
    a cuisine the user DISLIKED -> 1.0   (the maximum)

"The merchant is not the refused cuisine, therefore a perfect match." It is not a match.
The merchant simply is not the thing the user turned down, and the user said nothing
about how well it fits them. Answering the maximum there made a refusal evidence FOR
everything else at full strength - and because the aggregation across preferences is a
maximum (D397), one typed refusal erased every other preference the user had.

Measured on the live corpus (470 published merchants), a declared `quiet` at weight 0.9
plus a typed refusal of Japanese:

    before:  the 188 quiet merchants  -> 0.9000
             the 282 loud merchants   -> 1.0000     <- every one of them, the maximum
    after:   the 188 quiet merchants  -> 0.9000
             the 282 loud merchants   -> 0.5000     <- neutral, as a non-match should be

Before the fix the personalization lane was FLAT: 470 merchants, one value, and the
preference the user had declared had no effect on the order they were served in. The
cuisine the user refused is still demoted to 0.0 - refusing something still excludes it.
What changed is that refusing something no longer promotes everything else.

It was **proved to fail**: restoring `0.5 if polarity > 0 else 1.0` reddens the checks
below (the probe was put back)."""

from __future__ import annotations

import json

import nexus_ai.search.service as S


class Backend(S.StaticBackend):
    def __init__(self, *a, stored=None, **k):
        super().__init__(*a, **k)
        self._stored = stored or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id, kinds=None):
        return [dict(p) for p in self._stored]


def _merchant(sid: str, *, quiet: bool, category: str, tags: list[str]) -> dict:
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": sid, "display_name_zh": sid,
            "category_primary": category, "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": 100, "tags": tags,
            "attributes": {"data_origin": "demo", "quiet_ambience": quiet},
            "kw_score": 0.5, "text_matched": True}


#: the corpus writes only `quiet_ambience`, never `lively_ambience` - measured on the live
#: database, so a merchant the corpus calls loud answers None to the stored matcher and
#: carries no stored preference score at all. That is the half a refusal used to fill.
QUIET_JAPANESE = _merchant("quiet-japanese", quiet=True,
                           category="Sushi & Sashimi", tags=["sushi"])
QUIET_THAI = _merchant("quiet-thai", quiet=True, category="Thai", tags=["thai"])
LOUD_THAI = _merchant("loud-thai", quiet=False, category="Thai", tags=["thai"])

#: what the user declared before this turn: "I want quiet", at the seed's own strength.
STORED_QUIET = [{"user_id": "u1", "kind": "style", "key": "ambience",
                 "value": json.dumps({"value": "quiet"}), "weight": 0.9,
                 "source": "declared", "scope": "long_term"}]

REFUSE_JAPANESE = [{"key": "cuisine", "value": "japanese", "polarity": -1}]
LIKE_JAPANESE = [{"key": "cuisine", "value": "japanese", "polarity": 1}]


async def _scores(intent_prefs, *, stored=()):
    backend = Backend(merchants=[QUIET_JAPANESE, QUIET_THAI, LOUD_THAI], stored=list(stored))
    plan = S.SearchPlan(query_text="place", limit=10)
    _cards, _resp, _bundle, scored = await S.search(
        backend=backend, plan=plan, user_id="u1", intent_preferences=intent_prefs)
    return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}


# --------------------------------------------------------------- the refusal still refuses
async def test_the_refused_cuisine_is_still_demoted_to_the_floor():
    """Refusing something still excludes it. Only the promotion of everything else moved."""
    got = await _scores(REFUSE_JAPANESE)
    assert got["quiet-japanese"] == 0.0, (
        f"a merchant carrying the cuisine the user refused scored {got['quiet-japanese']} "
        f"- the refusal demotes nothing")


async def test_a_liked_cuisine_still_boosts_the_merchant_that_carries_it():
    got = await _scores(LIKE_JAPANESE)
    assert got["quiet-japanese"] == 1.0, got


# ------------------------------------------------- the refusal no longer promotes the rest
async def test_a_refusal_does_not_promote_what_it_did_not_name():
    """The core of it: "not Japanese" is not evidence that a Thai place fits."""
    got = await _scores(REFUSE_JAPANESE)
    for sid in ("quiet-thai", "loud-thai"):
        assert got[sid] == 0.5, (
            f"{sid} scored {got[sid]} for a cuisine the user never mentioned - a refusal "
            f"has become evidence FOR everything else at full strength")


async def test_a_refusal_leaves_the_lane_able_to_tell_the_two_halves_apart():
    """The measurement that names the unit: before the fix the lane was FLAT - 470 live
    merchants, one value, and the preference the user had declared had no effect on the
    order they were served in."""
    got = await _scores(REFUSE_JAPANESE, stored=STORED_QUIET)
    assert got["quiet-thai"] > got["loud-thai"], (
        f"the quiet merchant scored {got['quiet-thai']} and the loud one "
        f"{got['loud-thai']} - the personalization lane cannot separate them")
    assert got["quiet-thai"] == 0.9 and got["loud-thai"] == 0.5, (
        f"the lane carries {sorted(set(got.values()))} - a lane with one value in it "
        f"cannot order anything")


# ------------------------------------------- a declared preference survives a typed refusal
async def test_a_declared_preference_survives_a_refusal_typed_in_the_same_turn():
    """D397 takes the better of two answers. A maximum produced by the ABSENCE of a
    mismatch is not the better answer - it is not an answer at all."""
    got = await _scores(REFUSE_JAPANESE, stored=STORED_QUIET)
    assert got["quiet-thai"] == 0.9, (
        f"the user declared quiet at 0.9 and the turn left the quiet merchant at "
        f"{got['quiet-thai']} - the typed refusal overwrote what they declared")
    assert got["loud-thai"] == 0.5, (
        f"the loud merchant scored {got['loud-thai']} with no stored preference and no "
        f"typed one that names it")


async def test_without_a_refusal_the_declared_preference_is_unchanged():
    """The fix must not move the lane when nobody refuses anything."""
    got = await _scores(None, stored=STORED_QUIET)
    assert got["quiet-thai"] == 0.9 and got["loud-thai"] is None, got
