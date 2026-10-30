"""The generic shop noun 店 won the filter and stayed in the match text.

Two defects with one cause. `店` is a cue of the RETAIL bucket (`CATEGORY_SYNONYMS['retail']`), and
`match_leaf`'s head rule refused a leaf whose word sits LEFT of a bucket cue - the rule that makes
「拉麵店的咖啡」 a cafe. So a compound whose head is the generic 店 lost its leaf entirely and answered
the retail catalogue; and where the category did resolve (火鍋店), the strip removed 火鍋 and left
the 店, a term **246 of the 470** published rows carry, splitting the pool by whether a name says it.

Measured 2026-10-30 (`tmp/d639_before.txt`):

    火鍋店   category hotpot  match_text 店       (the hotpot pool split by a suffix)
    點心店   category retail  no leaf            (a dim-sum shop answered the retail catalogue)
    壽司店   category retail  no leaf
    拉麵店   category retail  no leaf
    燒味店   category retail  no leaf, match_text 燒味

Two repairs, each needing a different moment. `GENERIC_SHOP_NOUNS` is skipped when `match_leaf`
computes the bucket end, because 店 names no product: 「點心店」 is a dim sum shop, while 「點心餐廳」
still ends on a restaurant noun and still refuses the leaf. And `_strip_surface_spans` ABSORBS a
generic suffix that follows a span it just removed, so 火鍋|店 goes whole; a word with no surface of
its own (燒味店, no leaf in the taxonomy) keeps the 店 its own strip found.

Measured after (`tmp/d639_after.txt`, `tmp/d639_pairs.py`): 點心店/壽司店/拉麵店/火鍋店 each filter the
leaf and reach the lane as nothing, and each answers the SAME ten ids as 點心/壽司/拉麵/火鍋; relevance
is 0.0 on every card of all four; 「平價點心店」 reaches the lane as 平價.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.lexicon import match_leaf
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10


@pytest.mark.parametrize("text,leaf", [
    ("點心店", "dimsum"),
    ("壽司店", "sushi"),
    ("拉麵店", "ramen"),
    ("火鍋店", "hotpot"),
    ("平價點心店", "dimsum"),
    ("燒味店", None),
])
def test_a_generic_shop_suffix_does_not_refuse_the_leaf(text, leaf):
    assert match_leaf(text) == leaf, (text, match_leaf(text))


@pytest.mark.parametrize("text,leaf", [
    ("點心餐廳", None),
    ("拉麵店的咖啡", None),
])
def test_a_real_head_noun_still_refuses_the_leaf(text, leaf):
    """店 names no product, 餐廳 and 咖啡 do - the head rule is unchanged where the head is real."""
    assert match_leaf(text) == leaf, (text, match_leaf(text))


@pytest.mark.parametrize("text,filter_,left,why", [
    ("點心店", "dimsum", "", "the suffix does not steal the filter"),
    ("壽司店", "sushi", "", "the same"),
    ("拉麵店", "ramen", "", "the same"),
    ("火鍋店", "hotpot", "", "the suffix leaves with the surface it follows"),
    ("旺角嘅火鍋店", "hotpot", "", "the district and the compound both leave"),
    ("平價點心店", "dimsum", "平價", "a content word survives"),
    ("寵物店", "pet", "", "店 is the pet bucket's own spelling here, and it leaves with it"),
    ("花店", "retail", "花", "no leaf exists, so the 花 stays content"),
    ("燒味店", "retail", "燒味", "no 燒味 leaf in the taxonomy - filed, not invented"),
])
def test_the_plan_strips_the_suffix_and_keeps_the_content(text, filter_, left, why):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    assert plan.filters.get("category") == filter_, (text, plan.filters)
    assert plan.match_text == left, (text, why, plan.match_text)


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.api.pipeline import run_search
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    pairs = (("點心", "點心店"), ("壽司", "壽司店"), ("拉麵", "拉麵店"), ("火鍋", "火鍋店"))
    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            rows = await db.fetch("select display_name, display_name_zh, description, tags "
                                  "from public.merchants where status='published'")
            out = {"rows": len(rows),
                   "carrying": sum(1 for r in rows if "店" in " ".join([
                       str(r["display_name"] or ""), str(r["display_name_zh"] or ""),
                       str(r["description"] or ""), " ".join(r["tags"] or [])]))}
            pages = {}
            for q in [w for pair in pairs for w in pair]:
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
@pytest.mark.parametrize("plain,compound", [("點心", "點心店"), ("壽司", "壽司店"),
                                            ("拉麵", "拉麵店"), ("火鍋", "火鍋店")])
def test_a_compound_answers_the_page_its_leaf_answers(plane, plain, compound):
    assert plane["pages"][compound]["ids"] == plane["pages"][plain]["ids"], (
        f"「{compound}」 answers {plane['pages'][compound]['ids'][:3]} and 「{plain}」 answers "
        f"{plane['pages'][plain]['ids'][:3]}")
    assert plane["pages"][compound]["rel"] == plane["pages"][plain]["rel"], (
        compound, plane["pages"][compound]["rel"], plane["pages"][plain]["rel"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_no_card_on_a_compound_page_carries_the_suffix_as_a_term(plane):
    """The suffix is a term 246 of the 470 rows carry, so a page that still matched it would show a
    split - relevance 1.0 on the names that say 店 and less on the rest."""
    for q in ("點心店", "壽司店", "拉麵店", "火鍋店"):
        rel = plane["pages"][q]["rel"]
        assert rel and all(r == 0.0 for r in rel), (q, rel, plane["carrying"], plane["rows"])
