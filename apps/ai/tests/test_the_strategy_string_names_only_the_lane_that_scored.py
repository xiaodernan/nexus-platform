"""D593 - the strategy string names the lanes that SCORED, not the lanes that were asked for.

`api/pipeline.py` sets `vector_lane = bool(embedding) and backend.name == "postgres"`, and
`search()` appended `+vector` on that flag alone. Measured on the plane this service reads
(2026-10-28): `chunks` holds 2118 rows and `count(embedding)` is 0, so every candidate's
`vec_score` is 0.0 - and the response still answered `hybrid_v1+postgres+vector`. The string
is the only place a caller can read which lanes produced the ranking, so naming a lane by the
request rather than by its work is the §5 shape (unverifiable rendered as verified) one field
over from the cards.

The rule this file holds: the suffix is earned by a non-zero `vec_score` on a row that was
actually RANKED. Four separations, because three of them are ways the old rule looked right:

    every vec_score 0.0, lane requested       -> no suffix   (the plane's own case)
    one vec_score above 0                     -> +vector
    the lane not requested, a row carries one -> no suffix   (a column is not a lane)
    the scoring row filtered out of the query -> no suffix   (ranked rows, not fetched rows)

The live row reads the plane the service is served from and skips without
`NEXUS_TEST_DATABASE_URL`, the way this lane's other live doors do. Pure and DB-free otherwise.
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S

MERCHANTS = [
    {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
     "display_name": "Ramen House", "category_primary": "restaurant", "district": "Sha Tin",
     "avg_price_hkd": 120, "rating_agg": 4.5, "review_count": 10, "tags": ["ramen"],
     "price_amount": 100},
    {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
     "display_name": "Sushi Zen", "category_primary": "restaurant", "district": "Central",
     "avg_price_hkd": 400, "rating_agg": 4.2, "review_count": 20, "tags": ["sushi"],
     "price_amount": 380},
]


def _rows(*vec_scores: float | None) -> list[dict]:
    out = []
    for row, vec in zip(MERCHANTS, vec_scores):
        copy = dict(row)
        if vec is not None:
            copy["vec_score"] = vec
        out.append(copy)
    return out


async def _strategy(rows: list[dict], *, vector_lane: bool, query: str = "") -> str:
    backend = S.StaticBackend(merchants=rows)
    _cards, resp, _bundle, _scored = await S.search(
        backend=backend, plan=S.SearchPlan(query_text=query, limit=10),
        vector_lane=vector_lane)
    return resp.strategy


class TestTheSuffixIsEarned:
    async def test_a_requested_lane_that_scored_nothing_is_not_named(self):
        strategy = await _strategy(_rows(0.0, 0.0), vector_lane=True)
        assert not strategy.endswith("+vector"), (
            f"the strategy {strategy!r} names a vector lane that scored nothing - the "
            f"plane's own case is 0 of 2118 chunks embedded and every vec_score 0.0")

    async def test_a_row_with_a_non_zero_score_names_the_lane(self):
        strategy = await _strategy(_rows(0.62, 0.0), vector_lane=True)
        assert strategy.endswith("+vector"), strategy

    async def test_a_stray_column_is_not_a_lane(self):
        strategy = await _strategy(_rows(0.62, 0.0), vector_lane=False)
        assert not strategy.endswith("+vector"), (
            f"the strategy {strategy!r} names a vector lane the caller did not ask for")

    async def test_the_rows_that_scored_are_the_ranked_ones(self):
        # m2 owns the non-zero score and the query filters it out; m1 stays at 0.0.
        strategy = await _strategy(_rows(0.0, 0.62), vector_lane=True, query="ramen")
        assert not strategy.endswith("+vector"), (
            f"the strategy {strategy!r} counted a row the query did not rank")

    async def test_a_missing_attribute_is_not_a_score(self):
        strategy = await _strategy(_rows(None, None), vector_lane=True)
        assert not strategy.endswith("+vector"), strategy


@pytest.mark.skipif(not os.environ.get("NEXUS_TEST_DATABASE_URL"),
                    reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_live_plane_does_not_name_a_lane_it_cannot_have_run():
    import asyncio

    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    async def _go() -> None:
        st = Settings(llm_provider="mock", embedding_provider="hashing",
                      database_url=os.environ["NEXUS_TEST_DATABASE_URL"], internal_token="")
        db = await db_pool.connect(st, force_new=True)
        try:
            embedded = await db.fetchval("SELECT count(embedding) FROM chunks")
            if embedded:
                pytest.skip(f"this plane has {embedded} embedded chunk(s) - the row is for "
                            f"the empty plane the defect was measured on")
            backend = S.PostgresBackend(db)
            _cards, resp, _bundle, scored = await S.search(
                backend=backend, plan=S.SearchPlan(query_text="ramen", limit=10),
                embedding=[0.01] * 256, vector_lane=True)
            assert not resp.strategy.endswith("+vector"), (
                f"the strategy {resp.strategy!r} names a vector lane on a plane where "
                f"0 chunks carry an embedding")
            assert all(float((s.candidate.raw.get("row") or {}).get("vec_score") or 0.0) == 0.0
                       for s in scored), "a row scored on a vector the corpus does not hold"
        finally:
            await db_pool.dispose()

    asyncio.run(_go())
