"""D397 - the better evidence wins: a declared preference is not diluted by a weak history.

The preference signal and the feedback signal answer the SAME question ("does this fit
this user") from two different kinds of evidence: one is what the user SAID, the other is
what they DID. Averaging them let a weak click history (0.4) pull a preference the user
declared at 0.95 down to 0.675, which is the platform saying "you told us you want quiet,
but we think you do not" - a claim it has no standing to make.

The rule is a maximum: both signals are on the same 0..1 scale, and the best evidence
about a question is the strongest answer to it.
"""

from __future__ import annotations

import json

import nexus_ai.search.service as S


class B(S.StaticBackend):
    def __init__(self, *a, user_prefs=None, feedback=None, **k):
        super().__init__(*a, **k)
        self._p = user_prefs or []
        self._f = feedback or []

    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id, kinds=None):
        return [dict(p) for p in self._p if str(p.get("user_id")) == user_id]

    async def feedback(self, user_id, subject_ids):
        return [dict(f) for f in self._f
                if str(f.get("user_id")) == user_id
                and str(f.get("subject_id")) in {str(s) for s in subject_ids}]


MERCHANTS = [
    {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
     "display_name": "Quiet", "display_name_zh": "静", "category_primary": "cafe",
     "rating_agg": 4.5, "review_count": 30, "avg_price_hkd": 100, "tags": ["cafe"],
     "attributes": {"quiet_ambience": True},
     "kw_score": 0.5, "text_matched": True},
]

PREF = [{"user_id": "u1", "kind": "style", "key": "ambience",
          "value": json.dumps({"value": "quiet"}), "weight": 0.95,
          "source": "declared", "scope": "long_term"}]


def _fb(value: float, n: int) -> list[dict]:
    return [{"user_id": "u1", "subject_id": "m1", "signal": "click",
             "value": {"score": value}} for _ in range(n)]


async def _score(prefs, feedback) -> float | None:
    backend = B(merchants=MERCHANTS, user_prefs=prefs, feedback=feedback)
    plan = S.SearchPlan(query_text="cafe", limit=10)
    _, _, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    return scored[0].candidate.personalization


# --------------------------------------------------------------------------- the rule
async def test_a_declared_preference_is_not_diluted_by_a_weak_history():
    # The measurement that started this unit: 0.95 averaged with 0.4 gave 0.675.
    got = await _score(PREF, _fb(0.4, 3))
    assert got == 0.95


async def test_a_strong_history_still_wins_over_a_weak_preference():
    # The other direction: a preference the user holds at 0.5 is weaker evidence than a
    # 0.9 history, and the maximum keeps the 0.9.
    weak_pref = [dict(PREF[0], weight=0.5)]
    got = await _score(weak_pref, _fb(0.9, 3))
    assert got == 0.9


async def test_the_preference_alone_is_unchanged():
    assert await _score(PREF, []) == 0.95


async def test_the_feedback_alone_is_unchanged():
    assert await _score([], _fb(0.9, 3)) == 0.9


async def test_a_history_below_the_minimum_signals_is_not_a_signal():
    # One click is not a pattern (min_signals=3), so it is not evidence and must not
    # become one by being averaged in.
    assert await _score(PREF, _fb(0.1, 1)) == 0.95
    assert await _score([], _fb(0.1, 1)) is None


async def test_no_signal_at_all_stays_none():
    assert await _score([], []) is None
