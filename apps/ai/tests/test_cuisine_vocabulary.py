"""D394 - the cuisine vocabulary the NLU uses and the one the seed writes must meet.

The NLU's `CUISINE_TERMS` keys are user-facing ("dim_sum", "japanese"), while the seeded
merchant's `tags` carry the taxonomy leaf ("dimsum", "sushi"). A cuisine preference that
cannot match a leaf is a preference that never fires, so the matcher normalizes both sides
before it compares.
"""

from __future__ import annotations

import json

import nexus_ai.search.service as S


class SqlLikeBackend(S.StaticBackend):
    def __init__(self, *args, user_prefs=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._user_prefs = user_prefs or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id: str, kinds=None):
        return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]


async def _score_for(pref_value: str, tags: list[str], category: str) -> float | None:
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Test Place", "display_name_zh": "測試場所",
             "category_primary": category, "rating_agg": 4.0, "review_count": 10,
             "avg_price_hkd": 100, "tags": tags,
             "attributes": {"data_origin": "demo"},
             "kw_score": 0.5, "text_matched": True},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "food", "key": "cuisine_like",
             "value": json.dumps({"values": [pref_value]}),
             "weight": 0.9, "source": "declared", "scope": "long_term"},
        ],
    )
    plan = S.SearchPlan(query_text="place", limit=10)
    _, _, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    return scored[0].candidate.personalization


async def test_a_cuisine_matching_the_tag_exactly_fires():
    assert await _score_for("cantonese", ["cantonese", "dimsum"], "Cantonese") == 0.9


async def test_the_underscore_spelling_matches_the_leaf():
    # NLU says "dim_sum", the seed writes "dimsum".
    assert await _score_for("dim_sum", ["dimsum"], "Dim Sum") == 0.9


async def test_a_cuisine_spanning_several_leaves_fires():
    # NLU says "japanese"; the seed has three Japanese leaves (sushi, ramen, izakaya).
    assert await _score_for("japanese", ["sushi"], "Sushi & Sashimi") == 0.9
    assert await _score_for("japanese", ["ramen"], "Ramen & Noodles") == 0.9
    assert await _score_for("japanese", ["izakaya"], "Izakaya") == 0.9


async def test_a_cuisine_that_does_not_match_does_not_fire():
    assert await _score_for("thai", ["sushi"], "Sushi & Sashimi") == 0.5


async def test_a_cuisine_matching_the_category_fires():
    # "Seafood & BBQ" carries the word, and the leaf is "seafood-grill".
    assert await _score_for("seafood", ["seafood-grill"], "Seafood & BBQ") == 0.9
