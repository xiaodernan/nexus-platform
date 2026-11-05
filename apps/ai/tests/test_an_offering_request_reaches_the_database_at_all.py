"""Every offering request raised before it reached the database.

D692/D693 added a CJK containment boost to the offering lane's `kw_score` (`sql.py:692-699`) behind
two names that exist nowhere in that function: the flag is `cjk`, not `ck`, and the count string is
`contains_count`, not `contains_count_str`. `build_offering_query` is called for EVERY offering
request, so the NameError fires before the SQL is sent, with or without Chinese in the sentence:

    $ python -c "from nexus_ai.search import sql as S; S.build_offering_query(tenant_id='t', text='quiet', filters={})"
    NameError: name 'ck' is not defined

and through the pipeline the same request died the same way (`tmp/d696_raise.txt`). The fixture lane
never builds SQL, so nothing in the suite saw it: the offline answers stayed green while the live
offering plane answered nothing at all.

The repair is not the boost D692 argued for. Its premise - that `contains_frac` was "too small to move
offerings ahead of the rating-ordered default page" - is false on this corpus: the fraction is what the
MERCHANT lane has added since D407, and measured through the offering lane it puts every mentioning row
on the first page (`tmp/d696_measure.py`, 2026-11-05):

    word     offerings mentioning it on page one (of 10)
    咖啡     10   scores 0.6790 .. 0.6634
    拉麵     10   scores 0.7065 .. 0.6881
    甜品     10   scores 0.7223 .. 0.6752
    quiet     0   (no offering states it; the request still answers its filtered pool, D658)

So the leg becomes the merchant lane's own term - `+ contains_frac`, one fraction, two lanes - and the
flat `+ 1.0` goes with the two dead names it arrived with.

What this does NOT claim: the offering lane's ORDER still differs from the fixture lane's (the open
item D658 filed), and a Chinese query still answers the whole filtered offering plane ranked by the
score, not a text-filtered subset.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.search import sql as Q

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


@pytest.mark.parametrize("text", ["咖啡", "拉麵", "甜品", "quiet", None, ""])
def test_the_offering_query_builds_for_every_shape_of_request(text):
    """The regression itself: this raised `NameError: name 'ck' is not defined` on every one of
    these, with no database involved."""
    built = Q.build_offering_query(tenant_id="00000000-0000-0000-0000-000000000000",
                                   text=text, filters={})
    assert built.sql and "kw_score" in built.sql


def test_the_score_adds_the_containment_fraction():
    """The merchant lane's own term (`+ contains_frac`), not a comparison and not a constant."""
    built = Q.build_offering_query(tenant_id="00000000-0000-0000-0000-000000000000",
                                   text="咖啡", filters={})
    score = built.sql.split("AS kw_score", 1)[0]
    assert "strpos(lower(" in score, score[-400:]
    assert "+ ((SELECT count(*)::float8 FROM unnest(" in score, score[-400:]


def test_both_lanes_add_the_same_fraction():
    """One containment leg, two lanes: D407 wrote it for merchants and this unit keeps the offering
    lane on the same shape instead of a second rule."""
    merchant = Q.build_merchant_query(tenant_id="00000000-0000-0000-0000-000000000000",
                                      text="咖啡", filters={}, embedding=None).sql
    offering = Q.build_offering_query(tenant_id="00000000-0000-0000-0000-000000000000",
                                      text="咖啡", filters={}).sql
    assert "strpos(lower(" in merchant and "strpos(lower(" in offering
    assert "+ (" in merchant.split("AS kw_score", 1)[0]
    assert "+ ((SELECT count(*)::float8 FROM unnest(" in offering.split("AS kw_score", 1)[0]


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    import nexus_ai.search.service as S
    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            live = Deps(st).backend()
            out = {"words": {}}
            for word in ("咖啡", "拉麵", "甜品", "xyzzy"):
                plan = S.SearchPlan(query_text=word, filters={}, limit=10,
                                    subject_types=("offering",))
                _cards, resp, _b, scored = await S.search(backend=live, plan=plan)
                rows = await db.fetch(
                    "select id::text as id from offerings where lower(coalesce(name_zh,'')||' '||"
                    "coalesce(description_zh,'')||' '||coalesce(name,'')||' '||"
                    "coalesce(description,'')) like '%'||lower($1)||'%'", word)
                mention = {r["id"] for r in rows}
                ids = [s.candidate.subject_id for s in scored]
                out["words"][word] = {
                    "total": getattr(resp, "total_estimate", None),
                    "page": len(ids),
                    "on_page": sum(1 for sid in ids if sid in mention),
                    "top_is_mention": bool(ids) and ids[0] in mention,
                }
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_a_chinese_offering_request_answers_its_mentioning_rows_first(plane):
    """Measured 10 of 10 on page one for each of the three words (`tmp/d696_measure.py`)."""
    for word in ("咖啡", "拉麵", "甜品"):
        got = plane["words"][word]
        assert got["page"] == 10, (word, got)
        assert got["on_page"] == 10, (word, got)
        assert got["top_is_mention"], (word, got)


def test_a_word_no_offering_states_still_answers_the_pool(plane):
    """D658's rule, on this lane: the text is a score, so a word nobody states answers the filtered
    pool rather than nothing - and the request must not raise to say so."""
    got = plane["words"]["xyzzy"]
    assert got["page"] == 10, got
    assert got["on_page"] == 0, got
