"""One fact, two spellings: `outdoor_style: false` must not overrule `outdoor_seating: true`.

The typed-preference reader (``service.py``, the ``intent_preferences`` branch) derives the
attribute names a preference could be written under and then asks the merchant's JSONB. Its first
version stopped at the first name that was *present* - true OR false - so a corpus that writes the
same fact twice scored the merchant on whichever spelling came first. Measured on the seeded plane
2026-10-30: `outdoor_style` is present on all 470 published rows (63 true, 407 false) and
`outdoor_seating` on all of them (111 true, 359 false); **37 of the 184 restaurants record
`outdoor_style: false` with `outdoor_seating: true`**, and those 37 were answered "you do not have
outdoor space" for a request that asked for exactly that.

The fix is D527's lesson on the other side: ANY witness of the fact beats a sibling spelling that
says no. `any(...) is True` first, `any(...) is False` only when nothing says true.

Measured live through `run_search` before -> after (`tmp/d621_vector_pref.py`, `tmp/d621_rank.py`):

    query               lift before   lift after   rows whose score changed
    有戶外座位的餐廳    1.75          3.50         37 (each 0.0 -> 1.0)
    the other five      2.32 / 4.04 / 1.00 / 2.89 / 3.01   unchanged

and the best seat-only merchant moved from rank 13 to rank 2 while 170 of the 184 rows changed
rank (only 14 kept theirs) - so the correction reached the page, not just the score.

This file holds the unit-level half: four merchants, one preference, the exact attribute shapes the
seed writes. The live half is D620's lift door, whose outdoor floor is raised to the new number.
"""

from __future__ import annotations

import pytest

import nexus_ai.search.service as S


class Backend(S.StaticBackend):
    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]


def _merchant(sid: str, **attrs) -> dict:
    base = {"data_origin": "demo", "indoor_style": True}
    base.update(attrs)
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": sid, "display_name_zh": sid, "category_primary": "cafe",
            "rating_agg": 4.0, "review_count": 10, "avg_price_hkd": 100,
            "attributes": base, "kw_score": 0.5, "text_matched": True}


#: the four shapes the corpus writes, measured 2026-10-30 (470 published rows)
SEAT_ONLY = _merchant("seat_only", outdoor_style=False, outdoor_seating=True)
STYLE_ONLY = _merchant("style_only", outdoor_style=True, outdoor_seating=False)
NEITHER = _merchant("neither", outdoor_style=False, outdoor_seating=False)
UNSTATED = _merchant("unstated")
ROWS = [SEAT_ONLY, STYLE_ONLY, NEITHER, UNSTATED]


async def _scores(polarity: int) -> dict[str, float | None]:
    plan = S.SearchPlan(query_text="place", limit=10)
    _cards, _resp, _bundle, scored = await S.search(
        backend=Backend(merchants=ROWS), plan=plan,
        intent_preferences=[{"key": "style", "value": "outdoor", "polarity": polarity}])
    return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}


async def test_a_merchant_whose_seating_says_yes_is_not_read_through_its_style_flag():
    """The measured defect: `outdoor_style: false` came first and the seating fact was never asked."""
    got = await _scores(1)
    assert got["seat_only"] == 1.0, (
        f"a merchant recording `outdoor_seating: true` scored {got['seat_only']} for a request "
        "for outdoor space - the reader stopped at the first spelling that was present")


async def test_a_merchant_whose_style_says_yes_still_scores_yes():
    """The other spelling keeps working - this is a widening, not a replacement."""
    got = await _scores(1)
    assert got["style_only"] == 1.0, got


async def test_a_merchant_that_says_no_twice_is_still_demoted():
    """The control: the fix must not turn "no outdoor space" into a match."""
    got = await _scores(1)
    assert got["neither"] == 0.0, (
        f"a merchant recording both spellings false scored {got['neither']} - the preference "
        "stopped discriminating")


async def test_a_merchant_that_states_neither_is_left_neutral():
    """Silence is neutral, not evidence: nothing may be invented for a fact nobody wrote."""
    got = await _scores(1)
    assert got["unstated"] is None, (
        f"a merchant with neither attribute scored {got['unstated']} - the reader answered a "
        "question the corpus never recorded")


async def test_a_refusal_of_outdoor_space_reads_the_same_witness():
    """Polarity -1 asks the same fact the other way, so it must see the same 37 rows."""
    got = await _scores(-1)
    assert got["seat_only"] == 0.0, (
        f"a merchant with outdoor seating scored {got['seat_only']} under a refusal of outdoor "
        "space - the refusal is reading the sibling spelling")
    assert got["neither"] == 1.0, got
