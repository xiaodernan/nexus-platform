"""The mean a quality is shrunk toward was a constant on one lane and the tenant's own on the other.

`bayesian_quality` shrinks a rating toward the tenant mean by n/(n+K) with K=15, so for a shop with a
handful of reviews that mean is most of the score. The live SELECT computes it from the tenant's
published merchants (`sql.py:524-528`, and the offering SELECT at `:815-818`); the fixture backend never
stated it, so `candidates_from_rows` fell back to its 3.5 constant (`service.py:1257`) for every fixture
row. One row, one rating, two quality scores - measured (`tmp/d708_order.py`, 11:00 HKT Thursday):

    row        rating  reviews  quality on the fixture lane   quality on the live lane
    9c7d5b7e   4.53    6        0.7939                        0.8542

The tenant mean is 3.8278 over the 470 published rows, and the difference was not cosmetic: the two
lanes answered the same ten-row page in a different ORDER on 8 of 8 censused queries
(`tmp/d658_gap.py`). With the mean supplied, 5 of 8 agree exactly - 拉麵, 安靜, 寵物友善, 咖啡 and 火鍋
(`tmp/d708_mean.py`).

The decision this file holds: a lane that was handed a merchant set was handed the mean too. It is
`avg(rating_agg)` over the rows with a positive rating, the shape the live subquery uses, and it is
stated on the row only when the row does not state its own - a caller that computed a mean keeps it.
The 3.5 in `candidates_from_rows` stays what it was: the value for a ROW that says nothing, which is a
different question from the value for a SET.

The three queries that still disagree are filed, not claimed: 素食 and 海景 differ because the live
keyword score is a fuzzy similarity (trigram credit for a shared character) while the fixture's is exact
substring counting, and xyzzy differs because the live candidate CUT is ordered by rating while the
scorer weights eight features (`docs/PLAN.md`).
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu.understand import extract_intent
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _mean(rows):
    fn = getattr(S, "_tenant_mean_rating", None)
    assert fn is not None, (
        "the fixture lane has no reader for the mean its quality is shrunk toward")
    return fn(rows)


# ------------------------------------------------------------------ the reader
def test_the_mean_is_the_row_sets_own():
    rows = [{"rating_agg": 4.0}, {"rating_agg": 5.0}]
    assert _mean(rows) == pytest.approx(4.5), _mean(rows)


def test_a_row_with_no_rating_does_not_vote():
    rows = [{"rating_agg": 4.0}, {"rating_agg": 5.0}, {"rating_agg": None}, {"rating_agg": 0}]
    assert _mean(rows) == pytest.approx(4.5), _mean(rows)


def test_an_empty_set_keeps_the_prior():
    assert _mean([]) == pytest.approx(3.5), _mean([])
    assert _mean([{"rating_agg": 0}]) == pytest.approx(3.5), _mean([{"rating_agg": 0}])


# ------------------------------------------------------------------ the lane
def _row(key, rating, reviews, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "category": "cafe", "category_primary": "cafe", "avg_price_hkd": 50.0,
           "rating_agg": rating, "review_count": reviews, "popularity_score": 0.5,
           "tags": [], "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _page(rows, query=""):
    plan = S.SearchPlan(query_text=query, filters={}, limit=10,
                        subject_types=("merchant",))
    _c, _r, _b, scored = asyncio.run(
        S.search(backend=S.StaticBackend(merchants=rows), plan=plan))
    return scored


def test_a_row_the_set_states_a_mean_for_is_scored_with_it():
    got = _page([_row("a", 4.0, 10), _row("b", 5.0, 10)])
    by_id = {s.candidate.subject_id: s for s in got}
    assert by_id["a"].candidate.tenant_mean_rating == pytest.approx(4.5), by_id["a"].candidate
    assert set(by_id) == {"a", "b"}, by_id


def test_a_row_that_states_its_own_mean_keeps_it():
    got = _page([_row("a", 4.0, 10, tenant_mean_rating=4.1), _row("b", 5.0, 10)])
    by_id = {s.candidate.subject_id: s for s in got}
    assert by_id["a"].candidate.tenant_mean_rating == pytest.approx(4.1), by_id["a"].candidate


def test_the_mean_the_set_states_changes_which_row_leads():
    # A has the best rating and one review; B has a strong rating and twenty, three times over.
    # Shrunk toward 3.5 B leads (4.071 against 3.588); shrunk toward the set's own 4.6 A leads
    # (4.619 against 4.543). Both rows are otherwise identical, so the mean is the only difference.
    rows = [_row("a", 4.9, 1), _row("b", 4.5, 20), _row("c", 4.5, 20), _row("d", 4.5, 20)]
    got = _page(rows)
    assert [s.candidate.subject_id for s in got][0] == "a", [
        (s.candidate.subject_id, round(s.score, 4)) for s in got]
    cold = [dict(r, tenant_mean_rating=3.5) for r in rows]
    assert [s.candidate.subject_id for s in _page(cold)][0] == "b", (
        "the control: at the old constant the same rows lead with B")


# ------------------------------------------------------------------ the planes
@pytest.fixture(scope="module")
def orders():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    CASES = ["拉麵", "安靜", "寵物友善", "咖啡", "火鍋"]
    MSQL = """
        select m.id::text as subject_id, m.id::text as merchant_id, m.display_name,
               m.display_name_zh, m.description, m.category_primary, m.avg_price_hkd,
               m.rating_agg, m.review_count, m.popularity_score, m.tags, m.attributes,
               m.data_origin, m.images, m.plan, m.ai_agent_enabled,
               coalesce((SELECT array_agg(DISTINCT s.slug)
                         FROM merchant_categories mc2
                         JOIN categories c2 ON c2.id = mc2.category_id
                         LEFT JOIN categories pc2 ON pc2.id = c2.parent_id
                         CROSS JOIN LATERAL (VALUES (c2.slug), (pc2.slug)) AS s(slug)
                         WHERE mc2.merchant_id = m.id AND s.slug IS NOT NULL),
                        '{}'::text[]) as category_slugs
        from public.merchants m where m.status = 'published'"""

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = [dict(r) for r in await db.fetch(MSQL)]
            out = {}
            for query in CASES:
                plan = plan_from_intent(extract_intent(query), query=query, limit=10)
                _c, _r, _b, fixture = await S.search(
                    backend=S.StaticBackend(merchants=rows), plan=plan)
                _c2, _r2, _b2, live = await S.search(backend=Deps(st).backend(), plan=plan)
                out[query] = ([s.candidate.subject_id for s in fixture],
                              [s.candidate.subject_id for s in live])
            out["mean"] = float(await db.fetchval(
                "select avg(rating_agg)::float8 from merchants "
                "where status = 'published' and rating_agg > 0"))
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.parametrize("query", ["拉麵", "安靜", "寵物友善", "咖啡", "火鍋"])
def test_the_lane_that_was_handed_the_set_answers_the_same_order(orders, query):
    fixture, live = orders[query]
    assert fixture == live, (query, fixture, live)


def test_the_mean_the_live_lane_uses_is_the_one_the_rows_state(orders):
    assert orders["mean"] == pytest.approx(3.8278, abs=1e-4), orders["mean"]
