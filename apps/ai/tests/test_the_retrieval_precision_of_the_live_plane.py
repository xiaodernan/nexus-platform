"""The retrieval precision of the live plane, measured on words whose answer the taxonomy knows.

Every other live door asks whether a FILTER was honoured or a field carried the row's fact. This
one asks the question a user asks: when they name a kind of place, are the places in front of them
that kind? The judge is the taxonomy itself - the door reads each merchant's own leaf/parent slug
set straight from `merchant_categories`/`categories`, never from the query's filter, so a plan that
widened the filter cannot also widen what counts as right.

Baseline, measured on the seeded plane 2026-10-29 (470 published merchants, 0 of 2118 chunks
embedded, `strategy=hybrid_v1+postgres`), top-10 precision per case:

    query    leaf the corpus holds   p@10
    拉麵     ramen                  0.8
    火鍋     hotpot                 1.0
    咖啡     cafe                   1.0
    酒吧     bar                    1.0
    點心     dimsum                 0.9
    壽司     sushi                  0.5
    甜品     bakery-dessert         1.0
    按摩     spa-massage            0.3
    髮型屋   hair-salon             0.4

Mean 0.733, and in every case the first row is right. The weak three are why this door exists:
壽司 is answered through `category=restaurant` plus a soft `cuisine=japanese` preference, and
按摩/髮型屋 are answered through `category=beauty`, a ROOT that admits all six beauty leaves.
Precision cannot improve by ranking alone once the filter admits every nail salon for a massage
query - that is a lane question, and this door is the instrument that will say so.

The gate is deliberately coarse: the mean stays at or above 0.70 and no case falls below 0.30, so
a change that trades one case for another reddens, while ordinary re-seeding noise does not.
"""

from __future__ import annotations

import asyncio
import os

import pytest

import nexus_ai.search.service as S

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: (query the user types, the leaf the corpus files that answer under)
CASES = [
    ("拉麵", "ramen"),
    ("火鍋", "hotpot"),
    ("咖啡", "cafe"),
    ("酒吧", "bar"),
    ("點心", "dimsum"),
    ("壽司", "sushi"),
    ("甜品", "bakery-dessert"),
    ("按摩", "spa-massage"),
    ("髮型屋", "hair-salon"),
]

TOP_K = 10
MEAN_FLOOR = 0.70
CASE_FLOOR = 0.30

SLUG_MIRROR = """
SELECT mc.merchant_id::text AS merchant_id, array_agg(DISTINCT s.slug) AS slugs
FROM merchant_categories mc
JOIN categories c ON c.id = mc.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
CROSS JOIN LATERAL (VALUES (c.slug), (pc.slug)) AS s(slug)
WHERE s.slug IS NOT NULL
GROUP BY mc.merchant_id
"""


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.nlu.understand import extract_intent_dict

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            slugs = {r["merchant_id"]: {str(x) for x in (r["slugs"] or [])}
                     for r in await db.fetch(SLUG_MIRROR)}
            backend = S.PostgresBackend(db)
            out = {}
            for query, leaf in CASES:
                intent = validate_intent(extract_intent_dict(query))
                plan = S.plan_from_intent(intent, query=query, limit=TOP_K)
                _cards, resp, _bundle, scored = await S.search(backend=backend, plan=plan)
                rows = [s.candidate.raw["row"] for s in scored[:TOP_K]]
                hits = [leaf in slugs.get(str(r.get("id")), set()) for r in rows]
                first = hits.index(True) + 1 if any(hits) else None
                out[query] = {"hits": hits, "first": first, "plan": dict(plan.filters or {}),
                              "strategy": resp.strategy}
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _precision(result):
    hits = result["hits"]
    return (sum(hits) / len(hits)) if hits else 0.0


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_every_case_puts_a_right_answer_first(plane):
    wrong = {q: r["first"] for q, r in plane.items() if r["first"] != 1}
    plans = {q: plane[q]["plan"] for q in wrong}
    assert not wrong, (
        f"the first row is not the kind of place the user named: {wrong} (plans: {plans})")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_case_falls_below_the_floor(plane):
    low = {q: round(_precision(r), 3) for q, r in plane.items() if _precision(r) < CASE_FLOOR}
    assert not low, (
        f"p@{TOP_K} below {CASE_FLOOR}: {low} - the filter admits a kind of place the user did "
        f"not name, and ranking cannot repair a widened filter")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_mean_precision_holds_the_recorded_baseline(plane):
    scores = {q: _precision(r) for q, r in plane.items()}
    mean = sum(scores.values()) / len(scores)
    per_case = {q: round(v, 3) for q, v in scores.items()}
    assert mean >= MEAN_FLOOR, (
        f"mean p@{TOP_K} fell to {mean:.3f} from the recorded 0.733 baseline; per case "
        f"{per_case}")
