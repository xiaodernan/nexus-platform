"""The question a user wraps a request in was searched as content.

A Cantonese request arrives inside a frame - 「有冇…」, 「邊間…好」, 「推介…」 - and no lane answers
that frame, so the words reached the keyword lane as terms. Measured 2026-11-02 on the published
plane (`tmp/d650_census2.py`, `tmp/d650_page.py`): **0 of the 470 rows** carry 有冇, 有沒有, 有咩,
邊間, 哪間, 邊度, 哪裡, 邊個, 邊區, 推介 or 推薦 anywhere in name, description or tags, and

    咖啡店         match text ""       every card relevance 0.000
    有冇咖啡店     match text "有冇"   every card relevance 0.100   (the page order changed)
    邊間咖啡店好   match text "邊間 好"

A term no row can meet does not find anything - it divides every row's score by itself, which is the
same arithmetic D628, D633 and D644 each closed in a different lane.

The strip is `_QUESTION_FRAME`, applied where the other consumed cues are (`_match_core`), and it is
deliberately narrow. NOT stripped, each for a measured reason:

- 好 - it is a preference the ranker reads (「邊間咖啡店好」 keeps `好`).
- 附近 - it is a location a lane should answer; stripping it would delete the request's geography.
- 搵 / 找 / 有 - verbs; 有 especially, because 有機 (organic) is content.
- 安靜 - a preference that IS content (`有冇安靜嘅咖啡店` keeps `安靜`).

The gate walks the same eighteen words against the live corpus, in the shape D629's time-surface leg
uses: if a re-seed ever writes one of them into a description, the strip is no longer provably free
and the leg reddens rather than letting the assumption go stale.

D789 added the Mandarin twin 有什么 to the frame table (`_QUESTION_FRAME`), with the same
measurement: 附近有什么好吃的 etc. Measured 2026-11-09 at HEAD after the repair -
`有什么推荐`, `有什么推介`, `有什么好咖啡店`, `有什么拉麵馆`, `吃什么拉麵` answer with an empty
match text; `附近有什么好吃的` keeps 好吃; `有什么热饭` keeps 热饭; 「什么」 alone is NOT a frame
and leaves with whatever follows it.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

FRAME = ["有冇", "有沒有", "有咩", "有什么", "邊間", "哪間", "邊度", "哪裡",
         "邊個", "邊區", "推介", "推薦",
         "吗", "啊", "呢", "咯", "嘛", "請問"]


def _plan(text):
    return plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)


@pytest.mark.parametrize("text", [
    "有冇咖啡店", "有沒有咖啡店", "有咩咖啡店", "邊間咖啡店", "哪間咖啡店", "邊個咖啡店",
    "邊區咖啡店", "推介咖啡店", "推薦咖啡店", "有冇推介嘅咖啡店",
    # D789: the Mandarin twin, blanking at the same words.
    "有什么推荐", "有什么推介", "有什么好推介", "有什么好推荐", "有什么好咖啡店",
    "有什么餐厅", "有什么拉麵馆", "有什么推介咖啡店", "吃什么拉麵", "附近有什么好推介",
    # D790: the discourse particles and the opening formula - measured 0 of 520 merchants and
    # 0 of 5,538 offerings carry them; the question frame blanks them (`tmp`-free live census
    # 2026-11-09, read-only).
    "有没有拉麵馆吗", "请问有没有拉麵",
])
def test_the_frame_leaves_the_match_text(text):
    assert _plan(text).match_text == "", (text, _plan(text).match_text)


def test_the_frame_leaves_the_category_it_framed():
    plan = _plan("有冇咖啡店")
    assert (plan.filters or {}).get("category") == "cafe", plan.filters
    assert _plan("有冇餐廳").match_text == "", _plan("有冇餐廳").match_text


@pytest.mark.parametrize("text,left", [
    ("有冇安靜嘅咖啡店", "安靜"),
    # D707 superseded the D650 expectation: a whole-remainder evaluation word is not a search
    # term at all, and 0 of the 470 published merchants / 5,538 offerings carry one. The
    # question-frame leg filed this row open, and D707 closed it as residue.
    ("邊間咖啡店好", ""),
    # D789: the Simplified twin keeps content the same way - the evaluation word survives as a
    # term, the hot-food word does too. The user's own spelling is what the residue keeps (D635).
    ("附近有什么好吃的", "好吃"),
    ("有什么好吃的", "好吃"),
    ("附近有什么好吃的餐厅", "好吃"),
    ("有什么热饭", "热饭"),
    # D790: the discourse particle leaves, the word in front of it keeps its spelling.
    ("有什么好吃的吗", "好吃"),
    ("有没有早茶吗", "早茶"),
    ("有早茶吗", "有早茶"),
    ("有早茶啊", "有早茶"),
    ("有早茶呢", "有早茶"),
    ("有早茶咯", "有早茶"),
    ("有早茶嘛", "有早茶"),
    ("好吃的呢", "好吃"),
    ("有什么热饭吗", "热饭"),
    ("请问哪里有吃饭的地方", "地方"),
])
def test_a_word_this_unit_does_not_own_survives(text, left):
    # D657 (§654) took two of the four rows this leg shipped with: 附近 and 有 are the LOCATIVE
    # frame and the auxiliary after it, and its own gate reads "" for both
    # (`test_a_locative_frame_is_not_a_search_term.py`). 安靜 is a preference and stays. 好 was
    # an evaluation word with no owner when D650 wrote this leg; D707 later filed it as residue,
    # not content - the whole remainder is not searched, by its own gate.
    assert _plan(text).match_text == left, (text, _plan(text).match_text)


def test_a_party_inside_the_frame_still_reads():
    intent = extract_intent_dict("有冇2人嘅咖啡店")
    assert intent.get("party_size") == 2, intent.get("party_size")
    assert _plan("有冇2人嘅咖啡店").match_text == "", _plan("有冇2人嘅咖啡店").match_text


PAIRS = [("咖啡店", "有冇咖啡店"), ("咖啡店", "有沒有咖啡店"), ("咖啡店", "推介咖啡店"),
         ("咖啡店", "有冇推介嘅咖啡店")]


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
            out = {"rows": len(rows), "carrying": {}}
            for word in FRAME:
                out["carrying"][word] = sum(
                    1 for r in rows
                    if word in " ".join([str(r["display_name"] or ""),
                                         str(r["display_name_zh"] or ""),
                                         str(r["description"] or ""),
                                         " ".join(r["tags"] or [])]))
            pages = {}
            for plain, framed in PAIRS:
                pack_pages = {}
                for q in (plain, framed):
                    pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                            query=q, limit=TOP_K)
                    pack_pages[q] = dict(
                        ids=[s.candidate.subject_id for s in pack.scored[:TOP_K]],
                        rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]],
                        total=getattr(pack.response, "total_estimate", None))
                pages[(plain, framed)] = pack_pages
            out["pages"] = pages
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_published_row_carries_a_frame_word(plane):
    carriers = {k: v for k, v in plane["carrying"].items() if v}
    assert not carriers, (
        f"{carriers} of {plane['rows']} rows now carry a question-frame word - the strip is no "
        "longer provably free, so the reader has to weigh it again")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("plain,framed", PAIRS)
def test_a_framed_request_answers_the_page_its_content_answers(plane, plain, framed):
    pages = plane["pages"][(plain, framed)]
    assert pages[framed]["ids"] == pages[plain]["ids"], (
        f"{framed} answers {pages[framed]['ids'][:3]} and {plain} answers {pages[plain]['ids'][:3]}")
    assert pages[framed]["rel"] == pages[plain]["rel"], (framed, pages[framed]["rel"], pages[plain]["rel"])
    assert pages[framed]["total"] == pages[plain]["total"], (framed, pages[framed]["total"])
