"""D419 - the personalization signal, measured on the live plane, and the plane's own
freshness.

The personalization signal is the ranking's answer to "does this fit this user" (§99-100).
On the live demo plane it measured **0.5 on every card** — the matcher's NEUTRAL value — for
a sentence that names an occasion: "想找一個適合情侶約會的餐廳". The reason is not the code:
the plane's corpus was seeded before the seed generator learned to write the occasion
attributes (D383), so **0 of its 500 rows carry `date_occasion`** and the preference is
understood and then does nothing.

Measured on a throwaway plane seeded from the CURRENT generator, the same sentence gives
**1.0** on every card — the date_occasion venues are preferred ✓.

So this test does two things: it measures the signal (which is the point), and it says WHY it
skips when the plane's corpus is too old to carry the attribute — a skip without its reason
is a number, and a number here would hide a plane that cannot show the behaviour.
"""

from __future__ import annotations

import asyncio
import os

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: The sentence that names an occasion, written as escapes so the file's own encoding
#: cannot corrupt it.
DATE_SENTENCE = "\u60f3\u627e\u4e00\u500b\u9002\u5408\u60c5\u4fa3\u7d04\u6703\u7684\u9910\u5ef6"

#: The attribute the occasion matcher reads, and the corpus's own name for a private room.
OCCASION_ATTRIBUTE = "date_occasion"


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _rows_carrying(attribute: str) -> int:
    """How many published rows carry the attribute the occasion matcher reads."""
    import asyncpg

    async def _go():
        conn = await asyncpg.connect(DB_URL)
        try:
            return int(await conn.fetchval(
                "select count(*) from merchants where status = 'published' "
                "and attributes @> $1::jsonb", f'{{"{attribute}": true}}'))
        finally:
            await conn.close()

    return asyncio.run(_go())


def _cards(query: str, limit: int = 6) -> list[dict]:
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        r = c.post("/ai/v1/search", json={"query": query, "limit": limit})
        assert r.status_code == 200, r.text
        return r.json().get("items") or []


@pytest.mark.integration
def test_the_occasion_preference_reaches_the_ranking(live_settings=None):
    """The preference is understood AND it moves the answer — on a corpus that carries it."""
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    carrying = _rows_carrying(OCCASION_ATTRIBUTE)
    if carrying == 0:
        pytest.skip(
            f"this plane's corpus carries no {OCCASION_ATTRIBUTE} row (0 of its published "
            f"merchants) - it predates the seed generator that writes it, so the occasion "
            f"preference cannot fire here. Re-seed the plane (data/seed/load.sh) to measure "
            f"it; the CI seeds a fresh one and runs this.")

    cards = _cards(DATE_SENTENCE)
    assert cards, "the sentence answered with no cards"
    values = [(it.get("slug"), (it.get("score_breakdown") or {}).get("personalization"))
              for it in cards]
    assert all(v is not None for _s, v in values), f"a card has no personalization: {values}"
    assert max(v for _s, v in values) > 0.5, (
        f"the occasion preference is understood and then does nothing: {values}")


@pytest.mark.integration
def test_the_preference_is_understood_whatever_the_corpus_carries(live_settings=None):
    """The NLU half does not depend on the corpus: the intent names the occasion."""
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        r = c.post("/ai/v1/query/understand",
                   json={"query": DATE_SENTENCE, "context": {"locale": "zh-HK"}})
        assert r.status_code == 200, r.text
        prefs = r.json().get("preferences") or []
    assert {"key": "occasion", "value": "date", "polarity": 1} in prefs
