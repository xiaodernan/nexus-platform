"""The time a user states has its own lane - and it was also matched as text.

Measured 2026-10-30 (`tmp/d629_time.py`): of the 470 published merchants, **0** carry 今晚, 7點, 下午,
晚上, 明晚, 中午 or 朝早 anywhere in their name, description or tags - the only rows containing
點 hold 點心. So the words a time phrase contributes cannot find anything: they only divide every
row's `kw_score` by a term nobody can meet (measured 0.143 for 「今晚7點嘅餐廳」 against 1.00 for
「餐廳」), and they steer the candidate pool, which is ordered by that score.

The time lane is not idle: 「今晚7點嘅餐廳」 still carries `open_now: True`, `open_weekday: 4` and
`open_time: 19:00` in the plan's filters (`tmp/d629_live.txt`). The constraint keeps working; only its
words leave the match text.

Two guards, both measured rather than assumed: the strip runs ONLY when the time lane parsed a time
(a cue word can be content - 下午 is part of 下午茶, which this product answers as a cafe), and 下午 is
guarded with `(?!茶)` inside the span itself so the compound survives either way.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,core", [
    ("今晚7點嘅餐廳", "餐廳"),
    ("7點嘅餐廳", "餐廳"),
    ("今晚嘅餐廳", "餐廳"),
    ("明日中午嘅餐廳", "餐廳"),
    ("19:00嘅餐廳", "餐廳"),
])
def test_a_parsed_time_leaves_the_match_text(text, core):
    assert match_core(text, strip_time=True) == core


def test_the_time_is_only_stripped_when_the_lane_parsed_one():
    # The default must not touch a cue word: 下午 is part of 下午茶 in this product's own vocabulary.
    assert match_core("今晚7點嘅餐廳") == "今晚7點嘅餐廳"


@pytest.mark.parametrize("text", [
    "下午茶餐廳",   # a category, not a time
    "點心餐廳",       # a counter that is content
    "銅鑼灾嘅餐廳",   # district: filed, not stripped
])
def test_a_word_that_is_content_survives_the_time_strip(text):
    assert match_core(text, strip_time=True) == text


def test_the_plan_keeps_the_time_as_a_filter_and_drops_its_words():
    q = "今晚7點嘅餐廳"
    plan = plan_from_intent(validate_intent(extract_intent_dict(q)), query=q, limit=TOP_K)
    assert plan.match_text == "餐廳", f"the plan matched {plan.match_text!r}"
    assert plan.filters.get("open_time") is not None, (
        f"the time lane's filter was lost too: {dict(plan.filters or {})} - the strip is for the "
        "MATCH text, not for the constraint")


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = await db.fetch("select display_name, display_name_zh, description, tags "
                                  "from public.merchants where status='published'")
            out = {"rows": len(rows)}
            out["carrying"] = {}
            for surface in ("今晚", "7點", "下午", "晚上", "中午", "朝早"):
                out["carrying"][surface] = sum(
                    1 for r in rows
                    if surface in " ".join([str(r["display_name"] or ""),
                                            str(r["display_name_zh"] or ""),
                                            str(r["description"] or ""),
                                            " ".join(r["tags"] or [])]))
            pages = {}
            for q in ("餐廳", "今晚7點嘅餐廳"):
                intent = validate_intent(extract_intent_dict(q))
                pack = await run_search(Deps(st), intent, query=q, limit=TOP_K)
                pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                rel=[s.candidate.relevance for s in pack.scored[:TOP_K]],
                                total=getattr(pack.response, "total_estimate", None))
            out["pages"] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_published_row_carries_a_time_surface(plane):
    """The strip is a no-op for retrieval only while this holds.

    If a re-seed ever writes 下午 or 晚上 into a description, removing those words can cost a match
    and this leg must redden rather than let the assumption go stale.
    """
    carriers = {k: v for k, v in plane["carrying"].items() if v}
    assert not carriers, (
        f"{carriers} of {plane['rows']} rows now carry a time surface - the strip is no longer "
        "provably free, so the reader has to weigh it again")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_stating_a_time_no_longer_answers_a_different_ten(plane):
    """Measured 2026-10-30: relevance 0.143 for every row of the time page, now 1.00."""
    got = plane["pages"]["今晚7點嘅餐廳"]
    plain = plane["pages"]["餐廳"]
    assert got["ids"] == plain["ids"], (
        "the time phrase still steers the retrieval: its ten subject ids differ from 「餐廳」's")
    assert all(r >= 0.9 for r in got["rel"]), f"the page carries no real match: {got['rel']}"
    assert got["total"] == plain["total"] == 184, (got["total"], plain["total"])
