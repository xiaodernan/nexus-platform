"""The search's ANSWER, measured against the contract — on the live plane.

The lane's gates were mostly about the INTENT (what the service understood ✓); this one is
about the ANSWER (what it served ✗) — the properties the contract asks of the cards:

* the caller's EXPLICIT filters are hard (§7.1: the intent's preferences are soft ✗ and the
  request's filters are hard ✓) — §381 fixed the case where a soft preference became a
  hard filter ✗, and nothing checked the other direction ✓;
* every card says whether it is open (§2: never guessed ✗ — and D422 made "closed" say so ✓);
* every rendered number is backed by a fact (§18/§19: the facts list backs every number ✓);
* with a point to measure from, the distance is there (§37's grid ✗ — and D401 added the row ✓).

These are the checks a consumer would make against the response, so they are written the way a
consumer would: send the request, look at the cards.
"""

from __future__ import annotations

import os

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

QUERY = "\u9910\u5ef3"          # 餐廳
SHA_TIN = {"lat": 22.3809, "lng": 114.1861}


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _search(settings, **body):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/search", json={"query": QUERY, "limit": 8, **body})
        assert r.status_code == 200, r.text
        return r.json()


def _published(settings) -> int:
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(settings, force_new=True)
        try:
            rows = await db.readonly(
                "select count(*) as n from merchants where status = 'published'")
            return int(rows[0]["n"])
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_explicit_max_price_is_hard(live_settings):
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    body = _search(live_settings, filters={"max_price": 60})
    items = body.get("items") or []
    assert items, "the corpus has restaurants and the filter emptied the answer"
    for it in items:
        amount = (it.get("price") or {}).get("amount")
        if amount is not None:
            assert float(amount) <= 60.0, f"{it.get('slug')} is over the caller's max price"


def test_the_explicit_min_rating_is_hard(live_settings):
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    body = _search(live_settings, filters={"min_rating": 4.5})
    for it in body.get("items") or []:
        value = (it.get("rating") or {}).get("value")
        if value is not None:
            assert float(value) >= 4.5, f"{it.get('slug')} is under the caller's min rating"


def test_the_explicit_district_is_hard(live_settings):
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    body = _search(live_settings, filters={"district": "Sha Tin"})
    items = body.get("items") or []
    assert items, "the corpus has restaurants and the district filter emptied the answer"
    for it in items:
        subtitle = str(it.get("subtitle") or "")
        assert "Sha Tin" in subtitle, f"{it.get('slug')} is not in the caller's district"


def test_every_card_says_whether_it_is_open(live_settings):
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    body = _search(live_settings)
    items = body.get("items") or []
    assert items
    for it in items:
        open_state = it.get("open") or {}
        assert open_state.get("text"), f"{it.get('slug')} says nothing about being open"
        assert open_state.get("is_open") is not None, (
            f"{it.get('slug')} has no open state at all")


def test_every_rendered_number_is_backed_by_a_fact(live_settings):
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    body = _search(live_settings, geo=SHA_TIN)
    items = body.get("items") or []
    assert items
    for it in items:
        facts = {f.get("attribute"): f for f in (it.get("facts") or [])}
        assert facts, f"{it.get('slug')} renders numbers with no fact behind them"
        if (it.get("price") or {}).get("amount") is not None:
            assert facts.get("price") is not None, "the price has no fact"
        if (it.get("rating") or {}).get("value") is not None:
            assert facts.get("rating") is not None, "the rating has no fact"
        assert facts.get("open_state") is not None, "the open state has no fact"


def test_the_explicit_tag_filter_speaks_the_stored_spelling(live_settings):
    """D516: the same tag, spelled two ways, must reach the same rows.

    The seed writes every tag as a lowercase hyphen slug and the SQL tag filter is an exact
    array overlap, so the caller's spelling has to be folded before it reaches the
    predicate. Measured on this database: `cantonese` -> 11 rows, `Cantonese` -> 0.
    """
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    stored = _search(live_settings, query="", filters={"tags": ["cantonese"]})
    typed = _search(live_settings, query="", filters={"tags": ["Cantonese"]})
    assert stored.get("items"), "the corpus carries the tag and the filter emptied the answer"
    assert [i["slug"] for i in typed.get("items") or []] == [
        i["slug"] for i in stored["items"]], (
        "the tag spelled the way the product spells it in prose gave a different answer "
        "than the stored spelling - one fact, two readers")


def test_the_explicit_tag_filter_is_read_on_the_intent_path_too(live_settings):
    """The same gate on the branch that DOES resolve an intent - the reader has to sit on
    both paths, not only the one that had it first."""
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    stored = _search(live_settings, filters={"tags": ["cantonese"]})
    typed = _search(live_settings, filters={"tags": ["Cantonese"]})
    assert stored.get("items"), "the corpus carries the tag and the filter emptied the answer"
    assert [i["slug"] for i in typed.get("items") or []] == [
        i["slug"] for i in stored["items"]], (
        "the intent path read the tag differently from the intent-None path - one fact, "
        "two readers")


def test_the_avoid_filter_speaks_the_tags_the_corpus_writes(live_settings):
    """D517: the corpus records a cuisine in `tags` under the taxonomy leaf, so an `avoid`
    filter that never reads the column cannot exclude it.

    Measured on this database: `avoid=["seafood"]` used to remove 16 of the 470 published
    merchants and let all 14 published `seafood-grill` merchants through.
    """
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _tagged(tag: str) -> set[str]:
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            rows = await db.readonly(
                "select slug from merchants where status = 'published' and tags @> $1::text[]",
                [tag])
            return {r["slug"] for r in rows}
        finally:
            await db_pool.dispose()

    seafood = asyncio.run(_tagged("seafood-grill"))
    assert seafood, "the corpus carries the tag and the query found none of it"
    # the query is the word itself, so the merchants it names rank at the top
    kept = {i["slug"] for i in _search(
        live_settings, query="seafood", limit=50).get("items") or []}
    assert seafood & kept, (
        "the unfiltered search surfaces none of the merchants the corpus tags as seafood - "
        "this database cannot measure the avoid filter")
    avoided = {i["slug"] for i in _search(
        live_settings, query="seafood", limit=50,
        filters={"avoid": ["seafood"]}).get("items") or []}
    assert not (seafood & avoided), (
        f"the caller asked to avoid seafood and these merchants were still served: "
        f"{sorted(seafood & avoided)}")


def test_the_callers_own_avoid_list_is_not_overwritten(live_settings):
    """D517: §7.1 makes the request's filters hard. An intent must not replace the caller's
    own `avoid` list with an empty one.

    The query is the word itself so the merchants it names rank at the top; if the caller's
    list never reaches the SQL the two answers are identical.
    """
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    kept = {i["slug"] for i in _search(live_settings, query="seafood", limit=50).get("items") or []}
    avoided = {i["slug"] for i in _search(
        live_settings, query="seafood", limit=50, filters={"avoid": ["seafood"]}).get("items") or []}
    assert kept - avoided, (
        "the caller's explicit avoid list changed nothing - it never reached the SQL")


def test_a_point_to_measure_from_gives_a_distance(live_settings):
    if _published(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")
    body = _search(live_settings, geo=SHA_TIN)
    for it in body.get("items") or []:
        distance = it.get("distance") or {}
        assert distance.get("meters") is not None, f"{it.get('slug')} has no distance"
        assert distance.get("fact_id"), "the distance has no fact"
