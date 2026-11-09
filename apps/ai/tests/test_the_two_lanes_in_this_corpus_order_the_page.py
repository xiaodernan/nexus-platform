"""D814 evidence — the two candidate lanes, the same corpus, the same eight queries.

docs/PLAN.md parks the ORDER question with named ownership and keeps asking for
"its own census of the two sequences". This file IS that census; it deliberately
asserts NOTHING about which order the product should serve. The fixture lane and the
live lane see the same published corpus (the rows are fetched once, as in
`test_a_price_floor_is_read_by_both_lanes.py`), through the same `search()` entry, so
the only remaining difference between them is the kw_score the lane itself computes —
which is exactly the difference the census exists to measure.

Read it with `pytest -s`. The verdict on which lane should win is the ranking owner's,
not this file's.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

pytestmark = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

QUERIES = [
    "安靜 cafe",
    "海景",
    "寵物友善",
    "素食",
    "適合約會的餐廳",
    "週末約會",
    "週末找一個適合情侶約會的地方",
    "幫我找附近適合約會的餐廳",
]

ROWS_SQL = """
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
    from public.merchants m where m.status = 'published'
"""

HOURS_SQL = """
    select merchant_id::text as merchant_id, weekday, opens_at, closes_at,
           coalesce(crosses_midnight, false) as crosses_midnight
    from business_hours
"""


@pytest.fixture(scope="module")
def plane():
    import nexus_ai.search.service as S
    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent_dict

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go() -> dict[str, Any]:
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = [dict(r) for r in await db.fetch(ROWS_SQL)]
            hours = [dict(h) for h in await db.fetch(HOURS_SQL)]
            live = Deps(st).backend()
            out: dict[str, Any] = {"rows": len(rows), "lanes": {}}
            for query in QUERIES:
                intent = validate_intent(extract_intent_dict(query))
                sequences: dict[str, list[str]] = {}
                for name, backend in (("fixture", S.StaticBackend(merchants=rows, hours=hours)),
                                      ("live", live)):
                    plan = S.plan_from_intent(intent, query=query, filters={}, limit=10)
                    _cards, _resp, _b, scored = await S.search(backend=backend, plan=plan)
                    sequences[name] = [s.candidate.subject_id for s in scored[:10]]
                out["lanes"][query] = sequences
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_eight_queries_measure_as_the_two_lanes_answer_them(plane, capsys):
    lines = [f"seeded corpus: {plane['rows']} published merchants"]
    for query, sequences in plane["lanes"].items():
        fixture, live = sequences["fixture"], sequences["live"]
        member = [s for s in fixture if s in set(live)]
        prefix = next((i for i, (a, b) in enumerate(zip(fixture, live)) if a != b),
                      min(len(fixture), len(live)))
        lines.append(f"query: {query}")
        lines.append(f"  fixture ({len(fixture):2d}): {fixture}")
        lines.append(f"  live    ({len(live):2d}): {live}")
        lines.append(f"  same membership: {set(fixture) == set(live)}; same order: {fixture == live}; "
                     f"shared prefix: {prefix}; shared set size: {len(set(member))}")
    print()
    print("\n".join(lines))
    # Evidence only: nothing about which order the product should serve is asserted here.
    assert lines
