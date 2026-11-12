"""An opinion is not a search term.

D650 wrote the interrogative frame (`_QUESTION_FRAME`) and deliberately left 好 out of it, on the
grounds that 好 is "a preference the ranker reads". Measured 2026-11-06 (`tmp/d707_census.py`), the
corpus writes it nowhere: 0 of the 470 published merchants and 0 of the 5,538 offerings carry 好 in
a name, a description or a tag. So in the match text it is not content - it is the word every
Cantonese speaker wraps a request in, and it survived every frame strip:

    request              before this unit
    附近有咩好推介     match 「好」
    有咩好推介         match 「好」 (intent unknown)
    附近有咩好餐廳     match 「好」
    附近有咩好咖啡店   match 「好」
    好味的餐廳         match 「好味」  <- content, must stay
    好嘈的餐廳         match 「好嘈」  <- a preference, must stay

The live lane is silent about the residue today only because no row can meet the term. The moment
a row writes 好 - 好味小館 - a request that said nothing about that restaurant is credited for
the character, and it outranks a row that said nothing at all. That is D705's rule one lane over:
a score that is not meaning may not claim a match.

The rule here: an evaluation cue leaves the match text only when it is the WHOLE remainder, which is
the state its head noun leaves it in once the noun's own filter has answered it (D635). A substring
rule is impossible, not merely undesirable: 好味, 好食, 好正, 好喝 and 好嘈 all OPEN with 好. Each of
them is pinned below as surviving, so a future "simplification" that blanks 好 everywhere reddens.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu import lexicon
from nexus_ai.nlu.understand import extract_intent, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday


# ------------------------------------------------------------------ the table
def test_the_table_carries_the_opinion_and_nothing_else():
    cues = getattr(lexicon, "EVALUATION_CUES", ())
    assert cues == ("好",), cues


# ------------------------------------------------------------------ the reading
@pytest.mark.parametrize("query", [
    "附近有咩好推介",
    "有咩好推介",
    "好推介",
    "附近有咩好的推介",
    "推介好餐廳",
    "附近有咩好餐廳",
    "附近有咩好咖啡店",
])
def test_a_request_that_only_asks_for_something_good_leaves_no_term(query):
    plan = plan_from_intent(extract_intent(query, {"now": NOW}), query=query)
    assert plan.match_text == "", (query, plan.match_text)
    assert plan.query_text == query, "the user's own words stay on the plan"


@pytest.mark.parametrize("query,kept", [
    ("好味", "好味"),
    ("好食", "好食"),
    ("好正", "好正"),
    ("好喝", "好喝"),
    ("好嘈", "好嘈"),                    # the polarity lane reads this one
    ("好味的餐廳", "好味"),
    ("好食的餐廳", "好食"),
    ("好嘈的餐廳", "好嘈"),
])
def test_a_word_that_only_opens_with_the_opinion_is_still_content(query, kept):
    plan = plan_from_intent(extract_intent(query, {"now": NOW}), query=query)
    assert plan.match_text == kept, (query, plan.match_text)


def test_the_rule_is_the_whole_remainder_and_not_a_substring():
    # one sentence, both sides: the opinion goes, the content beside it stays.
    assert match_core("有咩好推介") == ""
    assert match_core("好味的推介") == "好味"


# ------------------------------------------------------------------ the harm
def _row(key, name=None, **over):
    row = {"subject_id": key, "merchant_id": key, "display_name": name or key,
           "display_name_zh": name or key, "category": "cafe", "category_primary": "cafe",
           "avg_price_hkd": 50.0, "rating_agg": 4.2, "review_count": 5, "tags": [],
           "attributes": {}, "data_origin": "demo"}
    row.update(over)
    return row


def _page(rows, query):
    plan = plan_from_intent(extract_intent(query, {"now": NOW}), query=query, limit=10)
    _c, resp, _b, scored = asyncio.run(S.search(backend=S.StaticBackend(merchants=rows), plan=plan))
    return plan, scored


def test_a_row_that_writes_the_opinion_is_not_credited_with_a_match():
    plan, scored = _page([_row("plain", "山水小館"), _row("good", "好味小館")],
                         "附近有咩好推介")
    assert plan.match_text == "", plan.match_text
    by_id = {s.candidate.subject_id: s for s in scored}
    assert set(by_id) == {"plain", "good"}, by_id
    assert by_id["good"].score == pytest.approx(by_id["plain"].score, abs=1e-9), (
        "the row whose NAME writes 好 was credited for a request that only said 'good'",
        {k: v.score for k, v in by_id.items()})
    assert not any(float((s.breakdown or {}).get("kw") or 0) for s in scored), \
        [(s.candidate.subject_id, s.breakdown) for s in scored]


# ------------------------------------------------------------------ the corpus
@pytest.fixture(scope="module")
def census():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            merchants = await db.fetchval(
                "select count(*) from merchants where status = 'published'")
            m_hit = await db.fetchval("""
                select count(*) from merchants where status = 'published' and (
                  display_name ilike '%'||$1||'%' or coalesce(display_name_zh,'') ilike '%'||$1||'%'
                  or coalesce(description,'') ilike '%'||$1||'%' or tags::text ilike '%'||$1||'%')""",
                "好")
            o_hit = await db.fetchval("""
                select count(*) from offerings where (
                  name ilike '%'||$1||'%' or coalesce(name_zh,'') ilike '%'||$1||'%'
                  or coalesce(description,'') ilike '%'||$1||'%')""", "好")
            offerings = await db.fetchval("select count(*) from offerings")
            out = {}
            for query in ("附近有咩好推介", "附近有咩推介"):
                plan = plan_from_intent(extract_intent(query, {"now": NOW}), query=query, limit=8)
                _c, resp, _b, scored = await S.search(backend=Deps(st).backend(), plan=plan)
                out[query] = {"total": resp.total_estimate,
                              "ids": [s.candidate.subject_id for s in scored],
                              "match": plan.match_text}
            return {"merchants": int(merchants), "offerings": int(offerings),
                    "m_hit": int(m_hit), "o_hit": int(o_hit), "pages": out}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_corpus_writes_the_opinion_nowhere(census):
    assert census["merchants"] == 470, census["merchants"]
    assert census["offerings"] == 5534, census["offerings"]
    assert census["m_hit"] == 0, census["m_hit"]
    assert census["o_hit"] == 0, census["o_hit"]


def test_the_opinion_does_not_change_the_page(census):
    with_it = census["pages"]["附近有咩好推介"]
    without = census["pages"]["附近有咩推介"]
    assert with_it["match"] == "" and without["match"] == "", (with_it, without)
    assert with_it["total"] == without["total"], (with_it, without)
    assert with_it["ids"] == without["ids"], (with_it["ids"], without["ids"])
    # a request that names no category, no place it can place and no other constraint answers
    # the whole published plane on the live lane - and the opinion must not shrink it either.
    assert with_it["total"] == census["merchants"], with_it
