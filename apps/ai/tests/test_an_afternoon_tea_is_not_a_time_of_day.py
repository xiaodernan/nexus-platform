"""An afternoon tea is a category, and the time lane read it as 14:00.

Measured 2026-10-30 (`tmp/d630_census.txt`, `tmp/d630_census2.txt`, `tmp/d630_harm.txt`): the
word 下午 is a part-of-day cue and also the first two characters of 下午茶, which is this
product's `afternoon_tea` CATEGORY (`lexicon.CATEGORY_SYNONYMS`). A CJK cue has no word boundary
(§D478), so `_find_part` read the 下午 inside it and the plan for 「下午茶」 carried
`open_weekday: 5, open_time: 14:00` - a hard SQL constraint on `business_hours` that the user
never stated. 「下午茶餐廳」, 「有咩下午茶好介紹」, 「下午茶自助餐」 and the English `afternoon tea`
(the Latin rule stops a cue being read INSIDE a word, not at the front of a longer phrase) all
carried it too.

The same reading also SHADOWED a part of day the user did state: 「今晚下午茶」 came back as
14:00 with `open_now: True` - the 今晚 was read, and then lost to the 下午 that tied with it.
After the fix it reads the night band (18:00).

Census of the boundary, taken from the vocabulary rather than assumed: of the 37 part-of-day
cues, exactly 2 open a longer word in the 153 category surfaces - 下午 -> 下午茶 and afternoon ->
afternoon tea. A scan of all 1632 string leaves in `nlu.lexicon` finds no other: the only
additional hits are `am` inside `ambience`, which the Latin word rule already refuses.

On today's corpus the dropped filter hid nobody - all 42 tea merchants are open at 14:00 on a
Saturday - but 39 of the 470 published merchants are closed then, so the population that the
unstated constraint could hide is real and is asserted below.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.pipeline import validate_intent
from nexus_ai.nlu.timeparse import _guarded_cues
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search.service import plan_from_intent

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
TOP_K = 10

#: the category surfaces that carry a cue, measured - a third one has to be argued for here
GUARDED = {"下午": ("下午茶",), "afternoon": ("afternoon tea",)}


@pytest.mark.parametrize("text,category", [
    ("下午茶", "afternoon_tea"),
    ("下午茶餐廳", "cafe"),
    ("有咩下午茶好介紹", "afternoon_tea"),
    ("下午茶自助餐", "afternoon_tea"),
    ("afternoon tea", "afternoon_tea"),
    ("high tea", "afternoon_tea"),
])
def test_the_compound_names_the_category_and_no_time(text, category):
    got = extract_intent_dict(text)
    assert got.get("category") == category, got.get("category")
    assert not got.get("time"), (
        f"「{text}」 still carries a time: {got.get('time')} - the cue inside the category name "
        "is not a time the user stated")


@pytest.mark.parametrize("text", ["下午茶", "下午茶餐廳", "afternoon tea"])
def test_the_plan_carries_no_hour_nobody_stated(text):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    filters = dict(plan.filters or {})
    assert "open_time" not in filters and "open_weekday" not in filters, (
        f"「{text}」 filters on an hour nobody stated: {filters} - a merchant must be open at "
        "whatever hour the category is served, which the category filter already says")
    assert filters.get("category") == ("cafe" if text == "下午茶餐廳" else "afternoon_tea"), filters


@pytest.mark.parametrize("text,hour", [
    ("下午嘅餐廳", 14),      # a bare part of day is still a time
    ("下午3點嘅餐廳", 15),   # and a clock beside it is still read
    ("afternoon 3pm", 15),  # the English surface without the word tea
])
def test_the_part_of_day_itself_still_dates_the_sentence(text, hour):
    plan = plan_from_intent(validate_intent(extract_intent_dict(text)), query=text, limit=TOP_K)
    got = (plan.filters or {}).get("open_time")
    assert got is not None and got.hour == hour, (
        f"「{text}」 lost its clock: {dict(plan.filters or {})}")


def test_the_hour_beside_the_compound_keeps_its_meridiem():
    """「下午茶3點」 is three in the afternoon: the cue still says which half of the day the hour
    is in, even when it is also the name of the category."""
    q = "下午茶3點"
    plan = plan_from_intent(validate_intent(extract_intent_dict(q)), query=q, limit=TOP_K)
    got = (plan.filters or {}).get("open_time")
    assert got is not None and got.hour == 15, dict(plan.filters or {})


def test_a_stated_part_of_day_is_no_longer_shadowed():
    """Measured before the fix: 「今晚下午茶」 read 14:00 with `open_now: True` - 今晚 tied with the
    swallowed 下午 and lost."""
    q = "今晚下午茶"
    plan = plan_from_intent(validate_intent(extract_intent_dict(q)), query=q, limit=TOP_K)
    got = (plan.filters or {}).get("open_time")
    assert got is not None and got.hour >= 18, (
        "the night the user named is still losing to the word inside the category: "
        f"{dict(plan.filters or {})}")


def test_the_guard_is_the_category_table_read_not_a_copy_of_it():
    """Two cues of the 37, and both of them name a category. If the lexicon gains a surface that
    opens with a cue, this leg reddens rather than letting the word be read as a time."""
    assert _guarded_cues() == GUARDED, (
        f"the guarded set moved to {_guarded_cues()} - a category surface now opens with a "
        "part-of-day cue, and the plan for it will carry an hour nobody stated")


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
            out["tea"] = await db.fetchval(
                "select count(distinct mc.merchant_id) from merchant_categories mc "
                "join categories c on c.id = mc.category_id "
                "join merchants m on m.id = mc.merchant_id and m.status = 'published' "
                "where c.slug = any(array['tea-house','cha-chan-teng']::text[])")
            out["closed_at_two"] = await db.fetchval(
                "select count(*) from merchants m where m.status = 'published' and not exists ("
                "select 1 from business_hours bh where bh.merchant_id = m.id and bh.weekday = 5 "
                "and ((bh.crosses_midnight = false and bh.opens_at <= time '14:00' "
                "and bh.closes_at > time '14:00') or (bh.crosses_midnight = true "
                "and (bh.opens_at <= time '14:00' or bh.closes_at > time '14:00'))))")
            q = "下午茶"
            pack = await run_search(Deps(st), validate_intent(extract_intent_dict(q)),
                                    query=q, limit=TOP_K)
            out["filters"] = dict(pack.plan.filters or {})
            out["total"] = getattr(pack.response, "total_estimate", None)
            out["ids"] = [s.candidate.subject_id for s in pack.scored[:TOP_K]]
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_page_for_an_afternoon_tea_carries_no_hour(plane):
    assert "open_time" not in plane["filters"] and "open_weekday" not in plane["filters"], (
        f"the page is still cut by an hour nobody stated: {plane['filters']}")
    assert plane["total"] == plane["tea"] == 42, (
        f"the page returned {plane['total']} of the {plane['tea']} tea merchants - the category "
        "is what the query names, and it has to be answered whole")
    assert len(plane["ids"]) == TOP_K, plane["ids"]


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_hour_that_was_dropped_had_a_population_to_hide(plane):
    """39 of 470 published merchants are not open at 14:00 on a Saturday (`tmp/d630_harm.txt`).
    A re-seed that moves this number means the constraint the reader removed has to be weighed
    again - the point is that it never had zero rows to hide."""
    assert plane["closed_at_two"] == 39, (
        f"{plane['closed_at_two']} published merchants are closed at 14:00 on a Saturday, not 39")
