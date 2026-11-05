"""A cuisine adjective looked like noise in the match text and was the recall.

Measured 2026-11-03 on the published plane (`tmp/d652_counts_parent.txt`, `tmp/d652_after.txt`).
The premise was tempting: 「泰式餐廳」 reads cuisine `thai` and category `restaurant`, the intent carries the
preference, and **0 of the 470 published rows write 泰式, 韓式, 日式 or 料理 anywhere** — so the word
looked like a term no row can meet, and this unit first removed it from the match text. The page
then went red in the other direction:

    泰式餐廳    top-10 thai rows 8    relevance 0.127-0.158
    泰式餐廳    with the word removed, top-10 thai rows 1 (2 with the preference alone)

**D705 corrected the reading of that measurement, not the decision.** The 0.127-0.158 was not
`word_similarity`: with the lane's own verdict honoured (`vector_semantic`), `kw_score` is **0.0000 on
every row of all three pages** (`tmp/d705_d652.py`), and the relevance was the OFFLINE HASHING COSINE
- a signed bag-of-ngrams projection, which shares the one character 泰 between 泰式 and 泰國. The
durable conclusion (the adjective stays in the match text) is unchanged and is still gated here; what
changed is WHY the page carried Thai rows. D705 gave a cuisine the user TYPES request weight -
relevance, not the 0.06 personalization bucket the feedback EMA uses - so the page no longer needs a
cosine to find the cuisine at all, and the same preference with the term taken out answers the same
ten rows (`tmp/d705_prefonly.py`).

So this is a REGRESSION GUARD, not a fix: the adjective stays in the match text, and these legs
redden if a later reader removes it for the reason this unit removed it. The same measurement
closes the PLAN item that called 「點心餐廳」 keeping 點心 a defect — it is the same recall: 9 of the
top 10 answer at relevance 1.000.

Not claimed here: whether the adjective should now be stripped. It is inert (`kw` 0 on every row it
scores) and it is not ours to remove in a lane that is not the NLU's.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10
JAPANESE = {"sushi", "ramen", "izakaya", "teppanyaki", "japanese"}

CUISINE_PAGES = [
    ("泰式餐廳", "泰式", "thai", {"thai"}),
    ("韓式餐廳", "韓式", "korean", {"korean"}),
    ("日式料理", "日式料理", "japanese", JAPANESE),
]


def _plan(text):
    return plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)


@pytest.mark.parametrize("text,kept,cuisine,tags", CUISINE_PAGES)
def test_the_cuisine_adjective_stays_in_the_match_text(text, kept, cuisine, tags):
    plan = _plan(text)
    assert (plan.filters or {}).get("category") == "restaurant", (text, plan.filters)
    assert plan.match_text == kept, (
        f"{text} now matches {plan.match_text!r}: the adjective is the recall (8/7/7 cuisine rows "
        "on the live page) and removing it drops the page to the cuisine preference alone")


@pytest.mark.parametrize("text,kept,cuisine,tags", CUISINE_PAGES)
def test_the_lane_reads_the_adjective_as_a_cuisine_as_well(text, kept, cuisine, tags):
    # This is why the trap exists: the preference lane answers the same word, so a reader can
    # conclude the word is already handled and take it out of the text. It is handled TWICE,
    # on purpose, and the page needs both.
    intent = validate_intent(extract_intent_dict(text))
    assert cuisine in {p.value for p in intent.preferences if p.key == "cuisine"}


def test_a_dim_sum_restaurant_keeps_its_points_as_the_term():
    plan = _plan("點心餐廳")
    assert (plan.filters or {}).get("category") == "restaurant", plan.filters
    assert plan.match_text == "點心", plan.match_text


@pytest.mark.parametrize("text", ["餐廳", "咖啡店"])
def test_a_bare_category_answers_no_term(text):
    assert _plan(text).match_text == "", (text, _plan(text).match_text)


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

    async def _tags(db, ids):
        rows = await db.fetch("select id, tags from public.merchants where id = any($1::uuid[])",
                              ids)
        return {str(r["id"]): set(r["tags"] or []) for r in rows}

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            out = {"rows": 0, "carrying": {}, "pages": {}, "pref_only": None}
            rows = await db.fetch("select display_name, display_name_zh, description, tags::text as tg "
                                  "from public.merchants where status='published'")
            out["rows"] = len(rows)
            for word in ("泰式", "韓式", "日式", "料理", "泰國", "韓國", "點心"):
                out["carrying"][word] = sum(
                    1 for r in rows
                    if word in " ".join([str(r["display_name"] or ""),
                                         str(r["display_name_zh"] or ""),
                                         str(r["description"] or ""), str(r["tg"] or "")]))
            queries = ["餐廳"] + [q for q, _k, _c, _t in CUISINE_PAGES] + ["點心餐廳"]
            for q in queries:
                pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                        query=q, limit=TOP_K)
                ids = [s.candidate.subject_id for s in pack.scored[:TOP_K]]
                out["pages"][q] = dict(ids=ids, tags=await _tags(db, ids),
                                       rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]])
            # The same cuisine preference with the word taken out of the request: what is left
            # when the term goes (the plan's own empty match text is the measured shape).
            intent = validate_intent(extract_intent_dict("泰式餐廳"))
            pack = await run_search(Deps(st), intent, query="餐廳", limit=TOP_K)
            ids = [s.candidate.subject_id for s in pack.scored[:TOP_K]]
            out["pref_only"] = dict(ids=ids, tags=await _tags(db, ids),
                                    rel=[round(s.candidate.relevance, 3) for s in pack.scored[:TOP_K]],
                                    core=pack.plan.match_text)
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _count(page, tags):
    return sum(1 for sid in page["ids"] if page["tags"].get(sid, set()) & tags)


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_corpus_writes_the_near_spelling_and_not_the_adjective(plane):
    # The whole trap in one leg: the adjective itself is written by NO row, and the word the
    # keyword lane actually meets is the near spelling one character away.
    written = {w: plane["carrying"][w] for w in ("泰式", "韓式", "日式", "料理") if plane["carrying"][w]}
    assert not written, f"{written} of {plane['rows']} rows now write it - re-read the strip that this gate forbids"
    for word in ("泰國", "韓國", "點心"):
        assert plane["carrying"][word] > 0, (word, plane["carrying"][word])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("text,kept,cuisine,tags", CUISINE_PAGES)
def test_the_adjective_puts_its_cuisine_rows_on_the_page(plane, text, kept, cuisine, tags):
    page = plane["pages"][text]
    plain = plane["pages"]["餐廳"]
    got, base = _count(page, tags), _count(plain, tags)
    assert got >= 5, (text, got, page["rel"])
    assert got > base, (text, got, base)
    assert sum(1 for r in page["rel"] if r > 0) >= 5, (text, page["rel"])


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_a_dim_sum_restaurant_reads_nine_rows_at_full_relevance(plane):
    page = plane["pages"]["點心餐廳"]
    assert _count(page, {"dimsum"}) >= 8, (page["rel"], page["ids"][:3])
    assert sum(1 for r in page["rel"] if r >= 0.9) >= 8, page["rel"]


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_preference_alone_now_fills_the_page_too(plane):
    # D652 read 2 of 10 here and argued the adjective was the recall. That was the preference
    # being scored at 0.06 (the feedback EMA's weight) while a hashing cosine was scored at
    # 0.34. D705 moved a TYPED cuisine to relevance, so the term changes nothing at all now:
    # the same preference with the row's own text taken out answers the same ten rows.
    assert plane["pref_only"]["core"] == "", plane["pref_only"]["core"]
    alone = _count(plane["pref_only"], {"thai"})
    with_word = _count(plane["pages"]["泰式餐廳"], {"thai"})
    assert alone >= 6, (alone, plane["pref_only"]["rel"])
    assert plane["pref_only"]["ids"] == plane["pages"]["泰式餐廳"]["ids"], (
        plane["pref_only"]["ids"], plane["pages"]["泰式餐廳"]["ids"])
