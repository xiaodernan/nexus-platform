"""D594 - a fact written on every row answers for every row, and the specific fact loses.

`generate.py` writes `indoor_style: True` on every merchant ("most HK venues are indoor" - its
own comment) and `outdoor_seating` on about a fifth of them. The outdoor matcher asked
`outdoor_style`, then `indoor_style`, then `outdoor_seating`, so the constant answered before
the specific fact: measured on the live plane, an outdoor preference at weight 0.5 scored **all
470** merchants 0.5 - the carriers and the rest were indistinguishable, and the live door
`test_the_outdoor_preference_scores_the_merchants_that_carry_it` was red at HEAD.

The order is the fix - the seating fact is read before the default - and this file pins the
three cells that make the order visible at a weight where each leg has a distinct answer
(0.9):

    outdoor_seating only      0.72   (the half-strength leg, w * 0.8)
    outdoor_style             0.90   (the full leg, and it wins over seating)
    neither                   0.10   (the indoor fallback, now genuinely a fallback)

Pure and DB-free except the last row, which reads the plane the service is served from and
skips without `NEXUS_TEST_DATABASE_URL`.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

import nexus_ai.search.service as S

WEIGHT = 0.9


def _merchant(sid: str, **attrs) -> dict:
    attributes = {"data_origin": "demo"}
    attributes.update(attrs)
    return {"subject_id": sid, "merchant_id": sid, "subject_type": "merchant",
            "display_name": sid, "category_primary": "restaurant", "district": "Central",
            "avg_price_hkd": 120, "rating_agg": 4.2, "review_count": 10, "tags": [],
            "attributes": attributes}


class Backend(S.StaticBackend):
    async def merchant_candidates(self, *, text=None, filters=None, **_kw):
        return [dict(r) for r in self.merchants]

    async def user_preferences(self, user_id, kinds=None):
        return [{"user_id": user_id, "kind": "style", "key": "outdoor",
                 "value": json.dumps({"value": True}), "weight": WEIGHT,
                 "source": "declared", "scope": "long_term"}]


async def _scores_async(rows: list[dict]) -> dict[str, float]:
    _cards, _resp, _bundle, scored = await S.search(
        backend=Backend(merchants=rows), plan=S.SearchPlan(query_text="", limit=100_000),
        user_id="u1")
    return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}


def _scores(rows: list[dict]) -> dict[str, float]:
    return asyncio.run(_scores_async(rows))


def test_a_seating_only_merchant_is_not_answered_by_the_corpus_default():
    got = _scores([_merchant("seating", indoor_style=True, outdoor_seating=True),
                   _merchant("indoor", indoor_style=True)])
    assert got["seating"] == pytest.approx(0.72), (
        f"the seating-only merchant scored {got['seating']} - the default `indoor_style` "
        f"answered for it before its own fact did")
    assert got["seating"] > got["indoor"], got


def test_the_style_fact_wins_over_the_weaker_seating_fact():
    got = _scores([_merchant("both", indoor_style=True, outdoor_seating=True,
                             outdoor_style=True)])
    assert got["both"] == pytest.approx(0.9), got


def test_the_rows_with_neither_fact_still_answer_on_the_far_side():
    got = _scores([_merchant("indoor", indoor_style=True)])
    assert got["indoor"] == pytest.approx(0.1), got


@pytest.mark.skipif(not os.environ.get("NEXUS_TEST_DATABASE_URL"),
                    reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_live_plane_now_separates_the_two_halves():
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    async def _go() -> None:
        st = Settings(llm_provider="mock", embedding_provider="hashing",
                      database_url=os.environ["NEXUS_TEST_DATABASE_URL"], internal_token="")
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = await db.readonly(
                "select slug, attributes from merchants where status='published' "
                "and tenant_id=$1 order by slug", S.DEFAULT_TENANT_ID)
        finally:
            await db_pool.dispose()

        def carries(r):
            a = r["attributes"] if isinstance(r["attributes"], dict) else json.loads(r["attributes"])
            return (a.get("outdoor_seating") is True or a.get("outdoor_style") is True)

        shaped = [dict(r, subject_id=r["slug"], merchant_id=r["slug"],
                       subject_type="merchant", display_name=r["slug"]) for r in rows]
        got = await _scores_async(shaped)
        carrier = [v for r in shaped if carries(r) for v in [got[str(r["subject_id"])]]
                   if v is not None]
        rest = [v for r in shaped if not carries(r) for v in [got[str(r["subject_id"])]]
                if v is not None]
        assert carrier and rest, (len(carrier), len(rest))
        assert min(carrier) > max(rest), (
            f"a carrier scored {min(carrier)} and a non-carrier {max(rest)} - the outdoor "
            f"preference still answers the corpus default instead of the fact")

    asyncio.run(_go())
