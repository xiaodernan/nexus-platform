"""The live-DB proof that a Chinese sentence reaches the right merchants (D398).

D381-D397 fixed a chain of defects that only the LIVE plane could show: a soft preference
rendered as a hard filter (D381), a category the NLU could not read from the signals it
had resolved (D391), a vocabulary the user and the seed did not share (D394, D395). Each
was verified offline and by probe, but the probes are not a gate: they are files nobody
runs. These tests make the chain a gate.

They need the demo seed (`NEXUS_TEST_DATABASE_URL` pointed at the seeded `nexus`
database), and they skip cleanly without it.
"""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

# The sentences that started this line of work, written as escapes so the file's own
# encoding cannot corrupt them.
DATE_SENTENCE = "\u5e2b\u6211\u627e\u4e00\u500b\u9002\u5408\u60c5\u4fa3\u7ea6\u4f1a\u7684\u5730\u65b9"  # 情侣约会
QUIET_SENTENCE = "\u60f3\u627e\u4e2a\u5b89\u975c\u7684\u5496\u5561\u5e97"  # 安静的咖啡店
JAPANESE_SENTENCE = "\u6211\u60f3\u98df\u65e5\u5f0f\u83dc"  # 我想食日式菜


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _published_merchants(live_settings) -> int:
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            rows = await db.readonly(
                "select count(*) as n from merchants where status = 'published'")
            return int(rows[0]["n"])
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _search(live_settings, query: str, limit: int = 5) -> dict:
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        r = c.post("/ai/v1/search", json={"query": query, "limit": limit})
        assert r.status_code == 200, r.text
        return r.json()


def _intent(live_settings, query: str) -> dict:
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        # The request schema is strict (UnderstandRequest: query + context), so the
        # locale travels in `context` - a top-level `locale` is a 422, not a harmless extra.
        r = c.post("/ai/v1/query/understand",
                   json={"query": query, "context": {"locale": "zh-HK"}})
        assert r.status_code == 200, r.text
        return r.json()


# --------------------------------------------------------------------------- the sentence
def test_the_chinese_date_sentence_answers_with_cards(live_settings):
    """D381: this sentence answered with ZERO cards because a soft preference became a
    hard filter. The proof is on the live plane, where the filter reaches Postgres."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    body = _search(live_settings, DATE_SENTENCE)
    assert body["items"], body


def test_the_chinese_date_sentence_resolves_a_category(live_settings):
    """D391: the sentence named no category, and a sentence with no category is a sentence
    the search cannot answer. The category is now READ from the resolved signal."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    data = _intent(live_settings, DATE_SENTENCE)
    assert data["intent"]["category"] == "restaurant"
    # An INFERRED category is never as certain as a named one.
    assert data["intent"].get("confidence", {}).get("category", 0) < 0.95


def test_the_chinese_date_sentence_keeps_its_preference_soft(live_settings):
    """D381: the preference must not become an attribute filter, or the search returns
    nothing at all."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    data = _intent(live_settings, DATE_SENTENCE)
    prefs = data["intent"].get("preferences") or []
    assert {"key": "occasion", "value": "date", "polarity": 1} in prefs


# --------------------------------------------------------------------------- the vocabulary
def test_the_style_form_cuisine_resolves_on_the_live_plane(live_settings):
    """D395: "我想食日式菜" resolved to nothing, so the page answered with whatever the
    search found first."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    data = _intent(live_settings, JAPANESE_SENTENCE)
    assert data["intent"]["category"] == "restaurant"
    cuisines = [p for p in (data["intent"].get("preferences") or [])
                if p.get("key") == "cuisine"]
    assert cuisines and cuisines[0]["value"] == "japanese"


def test_the_quiet_sentence_resolves_the_cafe_category(live_settings):
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    data = _intent(live_settings, QUIET_SENTENCE)
    assert data["intent"]["category"] == "cafe"


# --------------------------------------------------------------------------- the taxonomy
def test_the_category_filter_reaches_the_database(live_settings):
    """The category the NLU infers must be the category the taxonomy holds, or the
    filter matches nothing and the page is empty again."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    body = _search(live_settings, "restaurant", limit=5)
    assert body["items"], body
