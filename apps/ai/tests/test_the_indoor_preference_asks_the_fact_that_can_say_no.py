"""A preference for indoor seating was answered by a fact that is true on every row.

`indoor_style` is written True on all 470 published rows ("most HK venues are indoor" - the seed's
own comment), and both readers asked it FIRST: the stored branch at `service.py:1390-1395` and the
typed branch through the derived name `indoor_style`. So an indoor preference scored **184 of 184**
restaurants 1.0 (`tmp/d622_indoor_arms.py`, the "constant (HEAD shape)" reading) - a preference that
cannot change a page, and one that never demoted the 111 places the corpus says seat you outside.

D622 gave the pair one home, `_indoor_evidence`: the outdoor witness (`outdoor_seating` or
`outdoor_style` true) answers False first, and the constant is only the fallback. Both readers ask
it, so the stored declaration and the typed sentence cannot disagree.

Measured on the seeded plane 2026-10-30, a `有室內座位嘅餐廳` request over the 184 restaurants it
filters to:

    reading                        scored 1.0   scored 0.0   outdoor share of the top ten
    constant (HEAD's shape)        184          0            0.20   (= the population's own 0.23)
    this unit                      122          62           0.00

The page moved by two rows of ten; the numbers that move are the 111 merchants that record outdoor
space, which now answer "not what you asked for" instead of "yes".
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


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


SEAT_ONLY = _merchant("seat_only", outdoor_style=False, outdoor_seating=True)
INDOOR_ONLY = _merchant("indoor_only", outdoor_style=False, outdoor_seating=False)
UNSTATED = {"subject_id": "unstated", "merchant_id": "unstated", "subject_type": "merchant",
            "display_name": "unstated", "display_name_zh": "unstated", "category_primary": "cafe",
            "rating_agg": 4.0, "review_count": 10, "avg_price_hkd": 100, "attributes": {},
            "kw_score": 0.5, "text_matched": True}
ROWS = [SEAT_ONLY, INDOOR_ONLY, UNSTATED]


async def _typed(polarity: int) -> dict[str, float | None]:
    plan = S.SearchPlan(query_text="place", limit=10)
    _c, _r, _b, scored = await S.search(
        backend=Backend(merchants=ROWS), plan=plan,
        intent_preferences=[{"key": "style", "value": "indoor", "polarity": polarity}])
    return {str(s.candidate.subject_id): s.candidate.personalization for s in scored}


async def test_a_place_that_seats_you_outside_is_not_what_an_indoor_request_asked_for():
    got = await _typed(1)
    assert got["seat_only"] == 0.0, (
        f"a merchant recording `outdoor_seating: true` scored {got['seat_only']} for a request for "
        "indoor seating - the reader answered from `indoor_style`, which is true on every row")


async def test_a_place_with_no_outdoor_fact_answers_yes():
    got = await _typed(1)
    assert got["indoor_only"] == 1.0, got


async def test_a_place_that_states_nothing_is_left_neutral():
    """Neither attribute: the corpus recorded no seating fact, so nothing may be invented."""
    got = await _typed(1)
    assert got["unstated"] is None, got


async def test_a_refusal_of_indoor_reads_the_same_witness():
    got = await _typed(-1)
    assert got["seat_only"] == 1.0, got
    assert got["indoor_only"] == 0.0, got


async def test_the_stored_reader_answers_the_same_way():
    """The declaration path must not keep the old order - one fact, two readers (D518)."""
    class WithStored(Backend):
        async def user_preferences(self, user_id, kinds=None):
            return [{"user_id": "u1", "kind": "style", "key": "indoor",
                     "value": json.dumps({"value": True}), "weight": 1.0,
                     "source": "declared", "scope": "global"}]

    plan = S.SearchPlan(query_text="place", limit=10)
    _c, _r, _b, scored = await S.search(
        backend=WithStored(merchants=ROWS), plan=plan, user_id="u1")
    got = {str(s.candidate.subject_id): s.candidate.personalization for s in scored}
    # The stored branch demotes the seating witness at 0.8 of the weight (`service.py`, the
    # `_sided(w * 0.8, liked=False)` arm), so it lands on 0.2 rather than the typed reader's 0.0.
    # That is a strength difference the two readers already had; what this leg holds is the
    # DIRECTION, which is the half that was dead.
    assert got["seat_only"] <= 0.2, got
    assert got["indoor_only"] == 1.0, got


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_live_page_stops_showing_outdoor_places_for_an_indoor_request():
    """The live half: 0.20 of the top ten before, 0.00 after (`tmp/d622_indoor_arms.py`)."""
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent_dict

    query = "有室內座位嘅餐廳"
    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            intent = validate_intent(extract_intent_dict(query))
            plan = S.plan_from_intent(intent, query=query, limit=200)
            prefs = [p.model_dump() for p in intent.preferences]
            assert prefs and prefs[0]["key"] == "style" and prefs[0]["value"] == "indoor", prefs
            _c, _r, _b, scored = await S.search(
                backend=backend, plan=plan, intent_preferences=prefs)
            rows = [s.candidate.raw["row"] for s in scored[:10]]
            return sum(1 for r in rows
                       if (r.get("attributes") or {}).get("outdoor_seating") is True) / len(rows)
        finally:
            await db_pool.dispose()

    share = asyncio.run(_go())
    assert share <= 0.10, (
        f"{share:.2f} of the top ten for an indoor request seat you outside (measured 0.20 before "
        "this unit, 0.00 after) - the preference is answering from the constant again")
