"""The words around a budget were left in the match text, and they divided every row's relevance.

Measured 2026-10-30 (`tmp/d633_cues.txt`, `tmp/d633_live_before.txt`): `match_core` removed the
AMOUNT a constraint names but not the words that belong to it, because every budget regex stops at
the digits. So

    最多1000蚊嘅餐廳        -> 「蚊嘅餐廳」      relevance 0.250-0.284
    唔超過1000-2000嘅餐廳   -> 「唔超過 嘅餐廳」  relevance 0.250-0.284
    2至4人嘅餐廳           -> 「2至 餐廳」      relevance 0.250-0.284
    10至20人嘅餐廳         -> 「人嘅餐廳」       relevance 0.250-0.284

and none of those words can find anything: 0 of the 470 published rows carry 蚊, 元, 塊, 最多, 唔超過
or 不超過 anywhere in name, description or tags (`tmp/d633_residue.txt`). The ten-person shape was
the worst of them, because the BUDGET range rule took 「10至20」 out of 「10至20人」 and left the
counter behind - a party range being stripped by the money rule.

Three repairs, each needing the text at a different moment: a unit word goes BEFORE the strips (it
has to follow the digits), a ceiling cue goes AFTER (the budget rule needs it to find the number it
caps, so it is removed where the strip stranded it), and the PARTY span is read FIRST so a party
range is not half-eaten by the money rule.

Measured after (`tmp/d633_live_after.txt`): 「2至4人嘅餐廳」 answers the SAME ten ids as 「4個人嘅餐廳」
and as 「餐廳」 at relevance 1.0, and 「最多1000-2000嘅餐廳」 answers the same ten as 「1000-2000蚊嘅餐廳」
and 「唔超過1000-2000嘅餐廳」.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict, match_core
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

#: the words that only a constraint's own parse produces, in every shape a user writes them
STRIPPED = [
    ("最多1000蚊嘅餐廳", "蚊, a unit word after the number"),
    ("最多 1000蚊嘅餐廳", "the same with a space"),
    ("唔超過1000蚊嘅餐廳", "a ceiling cue and a unit"),
    ("不超過1000蚊嘅餐廳", "the simplified cue"),
    ("最多1000-2000嘅餐廳", "a cue in front of a band"),
    ("唔超過1000-2000嘅餐廳", "a ceiling cue in front of a band"),
    ("不超過1000-2000嘅餐廳", "the simplified cue in front of a band"),
    ("2至4人嘅餐廳", "a party RANGE"),
    ("2-4人嘅餐廳", "a party range with a hyphen"),
    ("2~4人嘅餐廳", "a party range with a tilde"),
    ("4至6位嘅餐廳", "a party range counted in seats"),
    ("2至4個嘅餐廳", "a party range counted in 個"),
    ("10至20人嘅餐廳", "a two-digit party range the money rule used to eat"),
    ("至多1000蚊嘅餐廳", "D636: a ceiling cue the lane did not read until D636"),
    ("頂多1000蚊嘅餐廳", "the other ceiling spelling"),
    ("少於1000蚊嘅餐廳", "a ceiling cue with no rule at all until D636"),
    ("低於1000蚊嘅餐廳", "the same"),
    ("起碼1000蚊嘅餐廳", "a floor cue with no rule until D636"),
    ("多過1000蚊嘅餐廳", "a floor cue the only rule read as nothing"),
    ("貴過1000蚊嘅餐廳", "the same, without a unit either"),
    ("高於1000蚊嘅餐廳", "the same"),
    ("at most 300 restaurants", "a ceiling cue with no rule at all until D636"),
    ("no more than 300 restaurants", "the same"),
    ("up to 300 restaurants", "the same"),
]


@pytest.mark.parametrize("text,why", STRIPPED)
def test_the_words_the_lane_consumed_leave_the_match_text(text, why):
    # D636: three of these are written in English, whose noun is not 餐廳.
    noun = "餐廳" if "餐" in text else "restaurants"
    assert match_core(text) == noun, (
        f"「{text}」 ({why}) still matches {match_core(text)!r} - those words divide every row's "
        "relevance by a term no row carries")


@pytest.mark.parametrize("text", [
    "最多人排隊嘅餐廳",   # 最多 is content here, and nothing was consumed
    "最多人嘅餐廳",
])
def test_a_word_that_no_lane_consumed_stays(text):
    assert match_core(text) == text, (
        f"「{text}」 was stripped to {match_core(text)!r} - no lane read anything out of it")


@pytest.mark.parametrize("text,party", [
    ("2至4人嘅餐廳", 4),
    ("2-4人嘅餐廳", 4),
    ("4至6位嘅餐廳", 6),
    ("10至20人嘅餐廳", 20),
])
def test_a_party_range_is_read_as_a_party_and_the_upper_end_is_kept(text, party):
    """The strip is only free because the party lane DID read these: it keeps the upper end, which is
    the seat count the request has to fit."""
    got = extract_intent_dict(text).get("party_size")
    assert got == party, (text, got)


def test_the_plan_carries_the_party_range_as_a_party():
    q = "2至4人嘅餐廳"
    plan = plan_from_intent(validate_intent(extract_intent_dict(q)), query=q, limit=TOP_K)
    # D635: the bucket word left with its filter as well, so the plan has no term left at all.
    assert plan.party_size == 4 and plan.match_text == "", (plan.party_size, plan.match_text)


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
            out = {}
            rows = await db.fetch("select display_name, display_name_zh, description, tags "
                                  "from public.merchants where status='published'")
            out["rows"] = len(rows)
            out["carrying"] = {}
            for surface in ("蚊", "元", "塊", "最多", "唔超過", "不超過"):
                out["carrying"][surface] = sum(
                    1 for r in rows
                    if surface in " ".join([str(r["display_name"] or ""),
                                            str(r["display_name_zh"] or ""),
                                            str(r["description"] or ""),
                                            " ".join(r["tags"] or [])]))
            pages = {}
            for q in ("餐廳", "2至4人嘅餐廳", "4個人嘅餐廳", "最多1000-2000嘅餐廳",
                      "1000-2000蚊嘅餐廳"):
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
def test_no_published_row_carries_a_word_the_strip_removes(plane):
    """The strip is a no-op for retrieval only while this holds. If a re-seed ever writes 元 into a
    description (or 最多 into one), removing those words can cost a match and this leg must redden."""
    carriers = {k: v for k, v in plane["carrying"].items() if v}
    assert not carriers, (
        f"{carriers} of {plane['rows']} rows now carry a word this strip removes - the strip is no "
        "longer provably free")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_party_range_answers_the_page_a_party_answers(plane):
    """Measured before: relevance 0.250-0.284 on all ten and a different ten from 「餐廳」."""
    pages = plane["pages"]
    assert pages["2至4人嘅餐廳"]["ids"] == pages["4個人嘅餐廳"]["ids"] == pages["餐廳"]["ids"], (
        "the party range still steers retrieval: its ten ids differ from the party's and the plain "
        f"query's ({pages['2至4人嘅餐廳']['ids'][:3]} vs {pages['餐廳']['ids'][:3]})")
    assert pages["2至4人嘅餐廳"]["rel"] == pages["餐廳"]["rel"], (
        pages["2至4人嘅餐廳"]["rel"], pages["餐廳"]["rel"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_cue_written_before_a_band_answers_the_page_the_band_answers(plane):
    pages = plane["pages"]
    with_cue = pages["最多1000-2000嘅餐廳"]
    plain = pages["1000-2000蚊嘅餐廳"]
    assert with_cue["ids"] == plain["ids"], (
        f"the cue still steers retrieval: {with_cue['ids'][:3]} vs {plain['ids'][:3]}")
    assert with_cue["rel"] == plain["rel"], (with_cue["rel"], plain["rel"])
