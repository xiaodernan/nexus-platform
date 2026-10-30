"""The strip undid eight of the twenty-three ways the time lane writes a part of the day.

Measured 2026-10-30 (`tmp/d634_carriers.txt`): 22 of the 23 CJK `PART_OF_DAY` spellings appear in
**0** of the 470 published rows' name, description or tags. The one that does is 午市 (115 rows -
the lunch set), so no row can answer a part of the day as a TEXT: those words only divide every
row's `kw_score`. `tmp/d634_cards.txt` shows what that looked like: 「深夜嘅餐廳」 scored exactly
0.25 on all ten cards and every one of them printed 符合「深夜嘅餐廳」.

D629 took the price, the party and the clock out of the match text and left this list to undo the
rest by hand. A hand list beside a table drifts (§D438): 上午, 下午, 下晝, 今夜, 傍晚, 午市, 午後,
夜間, 宵夜, 早上, 早晨, 晚間, 晚黑, 正午, 深夜, 清晨, 黃昏 and 黄昏 were all missing. `TIME_SPAN_RE` is
now BUILT from the lane's own tables by `timeparse.cue_alternation()`, and the legs below walk
those tables, so a cue the lane learns is stripped the day it is written and this gate reddens if
the two fall out of step again.

Three things must survive the strip, and are pinned here: 下午茶 is a CATEGORY this product answers
(§D630), a 午市套餐 still names its set after the hour is gone, and 點心 is a counter, not 7 o'clock.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu import timeparse as T
from nexus_ai.nlu.understand import TIME_SPAN_RE, extract_intent_dict, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

#: Every spelling the date lane reads, taken from its tables rather than written here (§D477).
PART_OF_DAY_CUES = tuple(c for _label, spellings, _s, _e in T.PART_OF_DAY for c in spellings)
DATE_CUES = tuple(c for table in T._STRIP_TABLES for c in table) + tuple(T.WEEKDAY_TOKENS)
ALL_CUES = PART_OF_DAY_CUES + DATE_CUES


@pytest.mark.parametrize("cue", PART_OF_DAY_CUES)
def test_a_part_of_the_day_leaves_only_the_noun(cue):
    got = match_core(f"{cue}嘅餐廳", strip_time=True)
    assert got == "餐廳", f"{cue!r} survived the strip: {got!r}"


@pytest.mark.parametrize("cue", DATE_CUES)
def test_a_day_leaves_only_the_noun(cue):
    got = match_core(f"{cue}嘅餐廳", strip_time=True)
    assert got == "餐廳", f"{cue!r} survived the strip: {got!r}"


@pytest.mark.parametrize("cue", ALL_CUES)
def test_the_span_consumes_every_cue_the_lane_reads(cue):
    """The compiled span, not just the strip: `TIME_SPAN_RE` must know the cue at position 0.

    A date cue that reaches the match text is the same defect one lane over, so the pattern a
    caller can use on its own is checked here too.
    """
    assert TIME_SPAN_RE.match(cue), f"TIME_SPAN_RE does not read {cue!r}"


def test_the_strip_covers_every_cue_table_the_lane_reads():
    """A table added to the lane must reach the strip: the census walks the module itself.

    The modules cue tables are read by name (`WEEKDAY_TOKENS` is a dict of spellings, the six
    date tables and `PART_OF_DAY` are tuples), so a table written next year is walked here the
    day it lands and its cues have to reach `_strip_cues()`.
    """
    tables = {name: tuple(val) for name, val in vars(T).items()
              if name.endswith("_TOKENS") and isinstance(val, (tuple, dict))
              and all(isinstance(x, str) for x in tuple(val))}
    assert len(tables) >= 7, f"the cue tables moved: {sorted(tables)}"
    stripped = set(T._strip_cues())
    missed = {name: [c for c in table if c not in stripped] for name, table in tables.items()}
    missed = {name: cues for name, cues in missed.items() if cues}
    assert not missed, f"a cue table the strip does not undo: {missed}"


@pytest.mark.parametrize("text,core", [
    ("下午茶", "下午茶"),                 # a category (§D630)
    ("下午茶餐廳", "下午茶餐廳"),
    ("下午3點去食下午茶", "去食下午茶"),     # the clock is read, the category survives
    ("點心餐廳", "點心餐廳"),             # a counter, not 7 o'clock
])
def test_a_word_that_opens_with_a_cue_survives(text, core):
    assert match_core(text, strip_time=True) == core


@pytest.mark.parametrize("text,core", [
    ("午市套餐", "套餐"),
    ("午市嘅餐廳", "餐廳"),
])
def test_the_set_named_after_the_hour_survives(text, core):
    """午市 is the one cue a published row carries - as its own lunch set, which stays."""
    assert match_core(text, strip_time=True) == core


def test_the_plan_keeps_the_time_as_a_filter_and_drops_the_cue():
    q = "深夜嘅餐廳"
    plan = plan_from_intent(validate_intent(extract_intent_dict(q)), query=q, limit=TOP_K)
    assert plan.match_text == "餐廳", f"the plan matched {plan.match_text!r}"
    assert plan.filters.get("open_time") is not None, (
        f"the time lane's filter was lost too: {dict(plan.filters or {})}")


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

    class KeywordOnly(Deps):
        """The lane D634 changed. The vector lane embeds the whole sentence (filed), and a
        cosine on 深夜嘅餐廳 versus 餐廳 would report that difference instead of this one."""

        def embeddings(self):
            raise RuntimeError("this reading is the keyword lane")

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = await db.fetch("select display_name, display_name_zh, description, tags "
                                  "from public.merchants where status='published'")
            hay = [" ".join([str(r["display_name"] or ""), str(r["display_name_zh"] or ""),
                             str(r["description"] or ""), " ".join(r["tags"] or [])])
                   for r in rows]
            carriers = {}
            for _label, spellings, _s, _e in T.PART_OF_DAY:
                for cue in spellings:
                    if cue.isascii():
                        continue
                    carriers[cue] = sum(1 for h in hay if cue in h)
            pages = {}
            for q in ("餐廳", "深夜嘅餐廳"):
                intent = validate_intent(extract_intent_dict(q))
                pack = await run_search(KeywordOnly(st), intent, query=q, limit=60)
                pages[q] = {s.candidate.subject_id: round(s.candidate.relevance, 6)
                            for s in pack.scored}
            return {"rows": len(rows), "carriers": carriers, "pages": pages}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_published_row_answers_a_part_of_the_day_as_text(plane):
    """The census the strip leans on, walked over the lane's own table.

    If a re-seed ever writes 深夜 or 早上 into a description, removing the cue can cost a match
    and this leg must redden rather than let the assumption go stale (午市 already does, and the
    strip takes it because the hour is the filter and 套餐 is the noun).
    """
    answering = {c: n for c, n in plane["carriers"].items() if n}
    assert answering == {"午市": answering.get("午市")}, (
        f"{answering} of {plane['rows']} rows carry a part of the day - the strip is no longer "
        "provably free, so the reader has to weigh it again")
    assert answering["午市"] > 0, "午市 stopped appearing - re-read whether it still needs the note"


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_part_of_the_day_no_longer_divides_the_page(plane):
    """Measured 2026-10-30: 0.25 flat on every card; the shared rows now score as 餐廳 does."""
    got, plain = plane["pages"]["深夜嘅餐廳"], plane["pages"]["餐廳"]
    shared = sorted(set(got) & set(plain))
    assert len(shared) >= 20, f"the two pools lost their overlap: {len(shared)} shared row(s)"
    differing = {i: (plain[i], got[i]) for i in shared if got[i] != plain[i]}
    assert not differing, (
        "the cue still divides the relevance of rows both pages hold: "
        f"{list(differing.items())[:5]}")
    assert len(set(got.values())) > 1, (
        "every card on the page scores the same - that is a flat cue score, not a match")
