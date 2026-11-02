"""The query text was a WHERE on the degraded lane and a score on the live one.

`build_merchant_query` puts no text predicate in its WHERE at all: the words reach `kw_score` and
the `text_matched` flag and nothing else (`search/sql.py:329-344`, `:423`). `_filter_static` dropped
every row with no keyword hit, so the same plan answered a different question on the two lanes.
Measured on the published plane (`tmp/d658_gap.py`), page rows / total:

    plan                       fixture (before)   live     fixture (after)
    安靜 + cafe                 0 rows / 79         10 / 79   10 / 79
    海景 + restaurant          0 rows / 184        10 / 184  10 / 184
    寵物友善 + pet              0 rows / 10         10 / 10   10 / 10
    素食 + restaurant          3 rows / 184        10 / 184  10 / 184
    xyzzy (no filter)          0 rows / 0          10 / 470  10 / 470

The last row is the shape in one line: a word the corpus does not hold answered NOTHING on the
fixture lane, while the live lane answered the whole published plane ordered by quality - because
text cannot remove a row there at all. D615 had already made the CATEGORY an exception to the veto;
this unit removes the veto, and the category leg stays because it IS a WHERE (`sql.py:449-453`).

`text_matched` moved with it. The flag means "this row mentions the text" on the live SELECT, and
`ranking._has_query_signal` reads it to tell an irrelevant MATCH (dropped by the relevance floor)
from a NON-match (kept, ranked low). The fixture lane set it to `bool(low)` - true on every row of
a texted request - so the floor judged rows by keyword score alone.
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _row(key, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": key, "display_name_zh": key,
           "description": "", "category_primary": "restaurant", "avg_price_hkd": 100.0,
           "rating_agg": 4.0, "review_count": 10, "tags": [], "attributes": {},
           "data_origin": "demo"}
    row.update(over)
    return row


ROWS = [
    _row("hit", description="quiet ramen counter", rating_agg=4.1),
    _row("loud", description="busy sushi bar", rating_agg=4.9),
    _row("silent", description="no words here", rating_agg=4.5),
]


def _answer(rows, plan):
    import asyncio

    backend = S.StaticBackend(merchants=rows)
    _cards, resp, _b, scored = asyncio.run(S.search(backend=backend, plan=plan))
    return scored, getattr(resp, "total_estimate", None)


def test_a_row_that_does_not_mention_the_text_is_still_an_answer():
    scored, total = _answer(ROWS, S.SearchPlan(query_text="ramen", limit=10))
    assert [s.candidate.subject_id for s in scored][0] == "hit",         [s.candidate.subject_id for s in scored]
    assert {s.candidate.subject_id for s in scored} == {"hit", "loud", "silent"}
    assert total == 3


def test_the_row_that_mentions_it_ranks_above_the_rows_that_do_not():
    scored, _total = _answer(ROWS, S.SearchPlan(query_text="ramen", limit=10))
    by_id = {s.candidate.subject_id: s.candidate.relevance for s in scored}
    assert by_id["hit"] > 0.0, by_id
    assert by_id["loud"] == 0.0 and by_id["silent"] == 0.0, by_id
    assert [s.candidate.subject_id for s in scored][0] == "hit"


def test_a_word_no_row_holds_answers_the_whole_filtered_pool():
    scored, total = _answer(ROWS, S.SearchPlan(query_text="xyzzy", limit=10))
    assert total == 3, total
    assert len(scored) == 3, [s.candidate.subject_id for s in scored]
    assert all(s.candidate.relevance == 0.0 for s in scored),         [(s.candidate.subject_id, s.candidate.relevance) for s in scored]


def test_the_matched_flag_is_per_row_not_per_request():
    scored, _total = _answer(ROWS, S.SearchPlan(query_text="ramen", limit=10))
    flags = {s.candidate.subject_id: bool(s.candidate.raw.get("text_matched")) for s in scored}
    assert flags == {"hit": True, "loud": False, "silent": False}, flags


def test_a_hard_filter_still_removes_rows_and_text_does_not():
    rows = [_row("shatin", district="Sha Tin", description="quiet ramen"),
            _row("central", district="Central", description="quiet ramen")]
    scored, total = _answer(rows, S.SearchPlan(query_text="quiet", limit=10,
                                               filters={"district": "Sha Tin"}))
    assert [s.candidate.subject_id for s in scored] == ["shatin"],         [s.candidate.subject_id for s in scored]
    assert total == 1


CASES = [
    ("安靜", "cafe"),
    ("海景", "restaurant"),
    ("xyzzy", None),
]


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = [dict(r) for r in await db.fetch("""
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
                from public.merchants m where m.status = 'published'""")]
            out = {"rows": len(rows), "pools": []}
            for text, category in CASES:
                filters = {"category": category} if category else {}
                pools = {}
                for name, backend in (("fixture", S.StaticBackend(merchants=rows)),
                                      ("live", Deps(st).backend())):
                    plan = S.SearchPlan(query_text=text, filters=dict(filters), limit=10)
                    _c, resp, _b, scored = await S.search(backend=backend, plan=plan)
                    pools[name] = (len(scored), getattr(resp, "total_estimate", None))
                out["pools"].append((text, filters, pools))
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("index", range(3))
def test_the_two_lanes_answer_the_same_pool_and_the_same_page(plane, index):
    text, filters, pools = plane["pools"][index]
    assert pools["fixture"] == pools["live"], (text, filters, pools)
    assert pools["fixture"][0] > 0, (text, filters, pools)      # the defect: this was 0
    assert 0 < pools["fixture"][1] <= plane["rows"], (text, filters, pools)
