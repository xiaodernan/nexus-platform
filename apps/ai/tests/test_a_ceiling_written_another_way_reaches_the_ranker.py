"""A ceiling or a floor written another way reached no budget at all.

Measured 2026-10-31 on the building plane (`tmp/d636_before.txt`, `.env`-free probe):

    至多1000蚊 / 頂多1000蚊 / 不多過1000蚊 / 少於1000蚊 / 低於1000蚊      budget = None
    多過1000蚊 / 貴過1000蚊 / 起碼1000蚊 / 高於1000蚊                    budget = None
    at most 300 / no more than 300 / up to 300                          budget = None

while 最多1000蚊, 唔多過1000蚊, 1000蚊以下, under 300 and over 1000 all read their band. So a
user who capped the price the way Cantonese actually writes it - 至多, 頂多, 少於, 低於 - got the
unfiltered catalogue and a keyword term no row carries (0 of the 470 published rows carry 至多,
頂多, 不多過, 少於, 低於, 多過, 貴過, 起碼, 高於, `at most`, `no more than`, `up to` or
`more than` anywhere in name, description or tags - `tmp/d636_live2.txt`). A user who floored it
at 起碼1000 got the CHEAPEST rows, because the floor lane never saw the sentence at all.

The repair is a cue table, not a list of shapes: `BUDGET_CEILING_CUE_RE` and
`BUDGET_FLOOR_CUE_RE` read both families, and the CJK ones require the amount to be marked as
money on one side of the digits, because these cues count things that are not money:

    至多40人    a party        (the ceiling lane read HK$40 before - `tmp/d636_party.txt`)
    唔多過12人  a party        (read HK$12)
    少於10分鐘  a wait
    低於30度    a temperature
    up to 12pm  a time         (already `before:1200` - `tmp/d636_collide.txt`)

Measured after (`tmp/d636_live.py`, `tmp/d636_live2.py`): 至多/頂多/不多過/少於/低於 answer the
SAME ten ids at the SAME relevance as 最多1000蚊, 起碼/高於/貴過/多過 the same ten as each other,
and the cap still moves the page - 至多100 answers a different ten from 至多1000, as 最多100 does
from 最多1000 - so the number reaches the ranker rather than merely agreeing with another spelling.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

#: every spelling of "at most 1000", in the order a HK user reaches for them
CEILINGS = [
    ("最多1000蚊嘅餐廳", "the canonical cue"),
    ("唔多過1000蚊嘅餐廳", "the other canonical cue"),
    ("不超過1000蚊嘅餐廳", "the simplified cue"),
    ("1000蚊以下嘅餐廳", "the amount-first shape"),
    ("至多1000蚊嘅餐廳", "D636: read as nothing before"),
    ("頂多1000蚊嘅餐廳", "the same"),
    ("不多過1000蚊嘅餐廳", "the simplified form of 唔多過, which the lane already read"),
    ("少於1000蚊嘅餐廳", "read as nothing before"),
    ("低於1000蚊嘅餐廳", "the same"),
    ("at most 1000蚊嘅餐廳", "the Latin cue, read as nothing before"),
    ("no more than 1000蚊嘅餐廳", "the same"),
    ("up to 1000蚊嘅餐廳", "the same"),
]

#: and every spelling of "at least 1000"
FLOORS = [
    ("超過1000蚊嘅餐廳", "the canonical cue"),
    ("至少1000蚊嘅餐廳", "the same"),
    ("1000蚊以上嘅餐廳", "the amount-first shape"),
    ("多過1000蚊嘅餐廳", "D636: read as nothing before"),
    ("貴過1000蚊嘅餐廳", "read as nothing before"),
    ("起碼1000蚊嘅餐廳", "the same"),
    ("高於1000蚊嘅餐廳", "the same"),
    ("more than 1000蚊嘅餐廳", "the Latin cue, read as nothing before"),
]


@pytest.mark.parametrize("text,why", CEILINGS)
def test_every_ceiling_spelling_reaches_the_budget_lane(text, why):
    got = extract_intent_dict(text).get("budget")
    assert got and got["max"] == 1000 and got["min"] is None, (
        f"「{text}」 ({why}) read budget={got} - a stated price ceiling that never reaches the "
        "ranker answers the unfiltered catalogue")


@pytest.mark.parametrize("text,why", FLOORS)
def test_every_floor_spelling_reaches_the_budget_lane(text, why):
    got = extract_intent_dict(text).get("budget")
    assert got and got["min"] == 1000 and got["max"] is None, (
        f"「{text}」 ({why}) read budget={got} - a stated price floor that never reaches the "
        "ranker answers the cheapest rows in the corpus")


@pytest.mark.parametrize("text,why", CEILINGS + FLOORS)
def test_the_cue_leaves_the_match_text(text, why):
    got = match_core(text)
    assert got == "餐廳", (
        f"「{text}」 ({why}) still matches {got!r} - the cue divides every row's relevance by a "
        "term no row carries")


@pytest.mark.parametrize("text,party", [
    ("至多40人嘅餐廳", 40),      # 至多 is a party cap far more often than a price cap
    ("頂多12人嘅餐廳", 12),
    ("唔多過12人嘅餐廳", 12),    # the ceiling lane read HK$12 here before
    ("不超過12位嘅餐廳", 12),
    ("最多40人嘅餐廳", 40),
    ("少過12個人嘅餐廳", 12),
    ("多過12人嘅餐廳", 12),      # the floor lane read HK$12 here before
    ("高於12人嘅餐廳", 12),
    ("起碼12人嘅餐廳", 12),
    ("more than 12 people", 12),
    ("at most 12 people", 12),
])
def test_a_cue_over_a_party_stays_a_party(text, party):
    got = extract_intent_dict(text)
    assert got.get("budget") is None, (
        f"「{text}」 read budget={got.get('budget')} - those digits count people, so the page is "
        "filtered by a price nobody stated")
    assert got.get("party_size") == party, (text, got.get("party_size"))


@pytest.mark.parametrize("text,why", [
    ("少於10分鐘嘅餐廳", "a wait, not a price"),
    ("低於30度嘅餐廳", "a temperature"),
    ("起碼30分鐘嘅餐廳", "a wait"),
    ("高於平均嘅餐廳", "not even a number"),
    ("至多1000嘅餐廳", "an unmarked number - 至多4人 is a party, so the unit decides"),
    ("少於1000嘅餐廳", "the same"),
])
def test_a_ceiling_over_something_that_is_not_money_reads_no_budget(text, why):
    assert extract_intent_dict(text).get("budget") is None, (
        f"「{text}」 ({why}) read a budget - the cue alone does not make an amount a price")


@pytest.mark.parametrize("text", [
    "up to 7pm restaurants",
    "up to 12pm restaurants",
])
def test_up_to_a_clock_is_still_a_time(text):
    """`up to` is a time cue (`timeparse.EARLY_CUES`) before it is a ceiling cue."""
    got = extract_intent_dict(text)
    assert got.get("budget") is None, (text, got.get("budget"))
    assert got.get("time"), (text, got.get("time"))


def test_the_plan_carries_the_cap():
    for text, cap in (("至多1000蚊嘅餐廳", ("max", 1000.0)), ("起碼1000蚊嘅餐廳", ("min", 1000.0))):
        plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
        # D635: the bucket word left with its filter, so no term is left behind either.
        assert getattr(plan, f"budget_{cap[0]}") == cap[1] and plan.match_text == "", (
            text, plan.budget_max, plan.budget_min, plan.match_text)


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
    queries = ("最多1000蚊嘅餐廳", "至多1000蚊嘅餐廳", "頂多1000蚊嘅餐廳",
               "不多過1000蚊嘅餐廳", "少於1000蚊嘅餐廳", "低於1000蚊嘅餐廳",
               "最多100蚊嘅餐廳", "至多100蚊嘅餐廳",
               "超過1000蚊嘅餐廳", "多過1000蚊嘅餐廳", "貴過1000蚊嘅餐廳",
               "起碼1000蚊嘅餐廳", "高於1000蚊嘅餐廳", "起碼100蚊嘅餐廳",
               "40個人嘅餐廳", "最多40人嘅餐廳", "12個人嘅餐廳", "唔多過12人嘅餐廳")

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = await db.fetch("select display_name, display_name_zh, description, tags "
                                  "from public.merchants where status='published'")
            cues = ("至多", "頂多", "不多過", "少於", "低於", "多過", "貴過", "起碼", "高於")
            out = {"rows": len(rows),
                   "carrying": {c: sum(1 for r in rows if c in " ".join([
                       str(r["display_name"] or ""), str(r["display_name_zh"] or ""),
                       str(r["description"] or ""), " ".join(r["tags"] or [])])) for c in cues}}
            pages = {}
            for q in queries:
                pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                        query=q, limit=TOP_K)
                pages[q] = dict(ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                                rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
            out["pages"] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_published_row_carries_a_word_the_cue_table_reads(plane):
    """The strip is free for retrieval only while this holds: if a re-seed ever writes 起碼 into a
    description, removing the cue can cost a match and this leg must redden."""
    carriers = {k: v for k, v in plane["carrying"].items() if v}
    assert not carriers, (
        f"{carriers} of {plane['rows']} rows carry a word this strip removes - the strip is no "
        "longer provably free")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text", ["至多1000蚊嘅餐廳", "頂多1000蚊嘅餐廳", "不多過1000蚊嘅餐廳",
                                  "少於1000蚊嘅餐廳", "低於1000蚊嘅餐廳"])
def test_a_ceiling_written_another_way_answers_the_page_最多_answers(plane, text):
    page = plane["pages"][text]
    canonical = plane["pages"]["最多1000蚊嘅餐廳"]
    assert page["ids"] == canonical["ids"], (
        f"「{text}」 answers {page['ids'][:3]} and 最多1000蚊 answers {canonical['ids'][:3]}")
    assert page["rel"] == canonical["rel"], (text, page["rel"], canonical["rel"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text", ["多過1000蚊嘅餐廳", "貴過1000蚊嘅餐廳", "起碼1000蚊嘅餐廳",
                                  "高於1000蚊嘅餐廳"])
def test_a_floor_written_another_way_answers_the_page_超過_answers(plane, text):
    page = plane["pages"][text]
    canonical = plane["pages"]["超過1000蚊嘅餐廳"]
    assert page["ids"] == canonical["ids"], (
        f"「{text}」 answers {page['ids'][:3]} and 超過1000蚊 answers {canonical['ids'][:3]}")
    assert page["rel"] == canonical["rel"], (text, page["rel"], canonical["rel"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_amount_still_moves_the_page(plane):
    """Two spellings agreeing proves nothing on its own - two UNREAD cues agree too. The cap has to
    change the answer: 100 and 1000 bracket 188 and 410 of the 470 rows."""
    assert plane["pages"]["至多100蚊嘅餐廳"]["ids"] == plane["pages"]["最多100蚊嘅餐廳"]["ids"], (
        "the two spellings of a 100 cap answer different pages")
    assert plane["pages"]["至多100蚊嘅餐廳"]["ids"] != plane["pages"]["至多1000蚊嘅餐廳"]["ids"], (
        "a cap of 100 answers the page a cap of 1000 answers - the number never reached the ranker")
    assert plane["pages"]["起碼100蚊嘅餐廳"]["ids"] != plane["pages"]["起碼1000蚊嘅餐廳"]["ids"], (
        "a floor of 100 answers the page a floor of 1000 answers")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text", ["最多40人嘅餐廳", "唔多過12人嘅餐廳"])
def test_a_ceiling_over_a_party_answers_the_party_page(plane, text):
    """Before D636 the ceiling lane read HK$40 / HK$12 out of these and filtered the page by it."""
    party = "40個人嘅餐廳" if "40" in text else "12個人嘅餐廳"
    assert plane["pages"][text]["ids"] == plane["pages"][party]["ids"], (
        f"「{text}」 answers {plane['pages'][text]['ids'][:3]} and 「{party}」 answers "
        f"{plane['pages'][party]['ids'][:3]} - a party cap was read as a price")
