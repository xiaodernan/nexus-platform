"""The locative frame was searched as content, and the degraded lane answered nothing for it.

`_QUESTION_FRAME` carried 有冇/有沒有/有咩/邊間/哪間/邊度/哪裡/邊個/邊區/推介/推薦 - and not the
word that asks for a POSITION, nor the auxiliary that follows the interrogative. Measured
(`tmp/d657_residue.py`), before this unit:

    附近嘅咖啡店      match 「附近」
    附近的咖啡店      match 「附近」
    附近有咩餐廳      match 「附近」
    邊度有咖啡店      match 「有」
    哪里有咖啡店      match 「哪里有」
    近我嘅咖啡店      match 「近我」

A frame is not a search term: 0 of 470 published merchants and 0 of 5,538 offerings write 附近,
近我, 哪里 or 有得食 in a name or a description (`tmp/d657_census.py`). And the residue was not
merely wasteful - a non-empty match text is a HARD predicate on the fixture lane
(`_filter_static` drops every row with no hit and no name hit), so all four sentences answered
ZERO rows there while the live lane answered 10 of 79 (`tmp/d657_pool.py`). 79 is the whole cafe
pool; the live WHERE ORs the keyword leg with the bucket legs, the fixture lane does not.

The repair adds the locative tokens (附近/近我/我附近) to the frame table and a COMPOUND rule that
takes the auxiliary with the interrogative (邊度有得食, 哪里有, 邊間可以). The compound runs before
the vocabulary spans, not after: the retail category's own surface is the verb 買, so the span
strip blanked it first and 「邊度有得買手信」 came back as `得 手信` - a lone 得 to search for. A
BARE 有 is deliberately in neither table: 有機 (organic) is content and would lose its first
character, which is why the compound needs the interrogative in front of it.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.nlu.understand import extract_intent
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _plan(query):
    return plan_from_intent(extract_intent(query), query=query, limit=10)


@pytest.mark.parametrize("query", [
    "附近嘅咖啡店",
    "附近的咖啡店",
    "附近有咩餐廳",
    "附近嘅麵包舖",
    "邊度有咖啡店",
    "哪里有咖啡店",
    "近我嘅咖啡店",
    "尖沙咀附近嘅咖啡店",        # the district leaves with its own filter (D637)
])
def test_a_frame_leaves_no_search_term(query):
    plan = _plan(query)
    assert plan.match_text == "", (query, plan.match_text)
    assert plan.query_text == query, "the user's own words stay on the plan"


@pytest.mark.parametrize("query,kept", [
    ("附近有咩素食餐廳", "素食"),          # the preference stays
    ("附近有冇海景酒店", "海景"),
    ("近我嘅有機cafe", "有機"),
    ("邊度有得買手信", "手信"),            # the auxiliary goes, the noun stays
    ("有機食品", "有機食品"),              # a bare 有 is NOT a frame
])
def test_content_next_to_a_frame_still_survives(query, kept):
    assert _plan(query).match_text == kept, (query, _plan(query).match_text)


def test_a_named_category_still_takes_its_word_with_it():
    # 拉麵 names the bucket, so the filter answers it and the term leaves (D635).
    plan = _plan("邊度有得食拉麵")
    assert plan.match_text == "", plan.match_text
    assert plan.filters.get("category") == "ramen", plan.filters


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    import nexus_ai.search.service as S

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
            out = {}
            for query in ("附近嘅咖啡店", "邊度有咖啡店"):
                pools = {}
                for name, backend in (("fixture", S.StaticBackend(merchants=rows)),
                                      ("live", Deps(st).backend())):
                    plan = plan_from_intent(extract_intent(query), query=query, limit=10)
                    _c, resp, _b, scored = await S.search(backend=backend, plan=plan)
                    pools[name] = (len(scored), getattr(resp, "total_estimate", None))
                out[query] = pools
            out["rows"] = len(rows)
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("query", ["附近嘅咖啡店", "邊度有咖啡店"])
def test_both_lanes_answer_the_frame_only_sentences(plane, query):
    pools = plane[query]
    assert pools["fixture"] == pools["live"], (query, pools)
    assert pools["live"][1] and pools["live"][1] < plane["rows"], (query, pools)
    assert pools["fixture"][0] > 0, (query, pools)     # the defect: this was 0
