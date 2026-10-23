"""D522 - the intent's cuisine preference was read out of a JSONB key that is not there.

A merchant's `category_primary` and `tags` are COLUMNS on its row. The `attributes` JSONB
carries the booleans - `quiet_ambience`, `wheelchair_access`, `opens_late` - and never the
category, never the tags (measured on this corpus: `select attributes from merchants`).
The stored-preference path knew that and folded the row's columns in before matching; the
transient path - the one that serves the preferences the user typed in THIS query - read
`attrs.get("category_primary")` and `attrs.get("tags")` straight out of the JSONB, so both
were empty for every merchant in the corpus.

An empty category and an empty tag list never match a cuisine, so every cuisine preference
fell to the non-matching branch:

    a cuisine the user LIKED    -> 0.5
    a cuisine the user DISLIKED -> 1.0   (the maximum)

Measured on the live corpus before the fix - `query="\u7d20\u98df\u5514\u597d"` (not vegetarian):

    personalization = 1.0 on every Vegetarian merchant, and they ranked 1, 2, 3, 4

and `query="\u60f3\u98df\u7d20\u98df"` (I want vegetarian):

    personalization = 0.5 on every Vegetarian merchant

The polarity was inverted AND the match never fired: the platform scored the thing the user
refused above the thing they asked for. This is the D518 shape again - one fact, two readers,
and the copy serving the live query was the broken one.

It was **proved to fail**: reading `attrs` instead of `_enriched_attrs(r, attrs)` in the
intent block reddens every check here (the probe was put back).
"""

from __future__ import annotations

import inspect

import pytest

import nexus_ai.search.service as S


class SqlLikeBackend(S.StaticBackend):
    """The corpus as the SQL lane returns it: the row's columns beside the JSONB."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]


def _merchant(category: str, tags: list[str]) -> dict:
    return {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
            "display_name": "Test Place", "display_name_zh": "\u6e2c\u8a66\u5834\u6240",
            "category_primary": category, "rating_agg": 4.0, "review_count": 10,
            "avg_price_hkd": 100, "tags": tags,
            # the JSONB as the seed writes it: booleans, never the category or the tags
            "attributes": {"data_origin": "demo", "quiet_ambience": True},
            "kw_score": 0.5, "text_matched": True}


async def _score_for(pref_value: str, tags: list[str], category: str,
                     polarity: int = 1) -> float | None:
    backend = SqlLikeBackend(merchants=[_merchant(category, tags)])
    plan = S.SearchPlan(query_text="place", limit=10)
    _, _, _, scored = await S.search(
        backend=backend, plan=plan,
        intent_preferences=[{"key": "cuisine", "value": pref_value, "polarity": polarity}])
    return scored[0].candidate.personalization


# ------------------------------------------------------------------ the match fires
@pytest.mark.parametrize("pref_value,tags,category", [
    ("vegetarian", ["vegetarian"], "Vegetarian"),
    ("japanese", ["sushi"], "Sushi & Sashimi"),
    ("japanese", ["ramen"], "Ramen & Noodles"),
    ("dim_sum", ["dimsum"], "Dim Sum"),
    ("seafood", ["seafood-grill"], "Seafood & BBQ"),
])
async def test_a_cuisine_the_query_names_fires_on_the_merchant(pref_value, tags, category):
    """The preference the user typed in THIS query must read the row's own columns."""
    assert await _score_for(pref_value, tags, category) == 1.0, (
        f"the query's cuisine {pref_value!r} did not fire on a merchant the corpus tags "
        f"{tags} - the reader is looking where the fact is not written")


async def test_a_cuisine_that_does_not_match_does_not_fire():
    assert await _score_for("thai", ["sushi"], "Sushi & Sashimi") == 0.5


# ------------------------------------------------------------------ the polarity
async def test_a_disliked_cuisine_demotes_the_merchant_that_carries_it():
    """The inversion, measured: a refused cuisine used to score the maximum."""
    assert await _score_for("vegetarian", ["vegetarian"], "Vegetarian", polarity=-1) == 0.0


async def test_a_liked_cuisine_boosts_the_merchant_that_carries_it():
    assert await _score_for("vegetarian", ["vegetarian"], "Vegetarian", polarity=1) == 1.0


async def test_a_disliked_cuisine_leaves_the_merchant_that_does_not_carry_it_neutral():
    """D529 corrected this row. It used to assert 1.0 - "the merchant is not the refused
    cuisine, therefore a perfect match" - and that answer is the maximum, so a refusal
    became evidence FOR everything else at full strength. Because the aggregation across
    preferences is a maximum (D397), one typed refusal erased every other preference the
    user had: measured on the live corpus, a declared `quiet` at 0.9 plus a typed refusal
    of Japanese left all 442 non-Japanese merchants at 1.0, quiet and loud alike. A LIKE
    already answers neutral for a non-match; a DISLIKE now does too. The cuisine the user
    refused is still demoted to 0.0 - see the row above."""
    assert await _score_for("vegetarian", ["sushi"], "Sushi & Sashimi", polarity=-1) == 0.5


async def test_the_card_names_the_preference_that_fired():
    """D392: the card must say WHICH preference matched - and a match that never fires
    names nothing."""
    backend = SqlLikeBackend(merchants=[_merchant("Vegetarian", ["vegetarian"])])
    plan = S.SearchPlan(query_text="place", limit=10)
    _, _, _, scored = await S.search(
        backend=backend, plan=plan,
        intent_preferences=[{"key": "cuisine", "value": "vegetarian", "polarity": 1}])
    labels = scored[0].candidate.raw.get("preference_labels") or []
    assert labels, "the cuisine preference fired and the card named nothing"
    assert labels[0]["source"] == "typed", labels


# ------------------------------------------------------------------ the coupling
def test_the_intent_block_reads_the_rows_own_columns():
    """One reader of one fact: the intent path folds the row's columns in, exactly as the
    stored path does (the D518 lesson - a copy that drifts is a copy that breaks)."""
    source = inspect.getsource(S.search)
    intent_at = source.find("Transient NLU intent_preferences")
    assert intent_at > 0, "the intent-preference block is gone"
    block = source[intent_at:]
    assert "_enriched_attrs(r, merchant_attrs[mid])" in block, (
        "the intent-preference block reads the JSONB without the row's own columns, so a "
        "cuisine the user typed is matched against an empty category and no tags")


def test_the_row_fields_are_the_ones_the_jsonb_does_not_carry():
    assert "category_primary" in S._ROW_FIELDS
    assert "tags" in S._ROW_FIELDS
