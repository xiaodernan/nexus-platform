"""D433 - the product's two-turn refinement, measured on the live plane, in BOTH spellings.

The product's own conversation: a user says what they want, then says "太贵了" (too
expensive) or "近一点" (a bit closer) on the second turn. §34 promises what the second
turn does, and the two units that carry it were measured OFFLINE:

* D406 wired the sort preference (`plan.sort_preference` was written and never read);
* D421 made the merge's cues answer to either spelling (the cues are a second vocabulary
  the canonical table did not cover).

This is the same question asked of the live plane, and the words are taken FROM THE
VOCABULARY rather than typed here - D421's lesson is that a writer's memory of a CJK code
point is not a reference, and a test that hard-codes one inherits the mistake.
"""

from __future__ import annotations

import json
import os

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import state_merger as M

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: 拉麵 - the lexicon's own word for it, not a hand-typed one.
RAMEN = L.CUISINE_TERMS["japanese"][5]
#: 太貴 and 太贵 - the two spellings of the same refinement, from the merge's own cues.
CHEAPER_TRADITIONAL = M.CHEAPER_CUES[1]
CHEAPER_SIMPLIFIED = M.CHEAPER_CUES[0]
#: 近一點 - the traditional spelling of "a bit closer".
CLOSER_TRADITIONAL = M.NEARER_CUES[1]


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _turn(client, query: str, previous: dict | None = None):
    """One turn of the SSE stream: the intent it understood and the cards it served."""
    payload: dict = {"query": query, "limit": 8}
    if previous:
        payload["previous_intent"] = previous
    intent: dict = {}
    items: list = []
    with client.stream("POST", "/ai/v1/search/stream", json=payload) as resp:
        assert resp.status_code == 200, resp.status_code
        for line in resp.iter_lines():
            if not line.startswith("data:"):
                continue
            body = json.loads(line[len("data:"):].strip())
            if "sort_preference" in body:
                intent = body
            if "items" in body:
                items = body["items"]
    prices = [float((i.get("price") or {}).get("amount")) for i in items
               if (i.get("price") or {}).get("amount")]
    return intent, items, prices


@pytest.fixture
def client():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        yield c


def test_the_second_turn_orders_by_price_in_either_spelling(client):
    first, items, _prices = _turn(client, RAMEN)
    assert items, "the first turn served no cards"
    assert first.get("sort_preference") == "relevance"

    for word in (CHEAPER_TRADITIONAL, CHEAPER_SIMPLIFIED):
        intent, items, prices = _turn(client, word, dict(first))
        assert intent.get("sort_preference") == "price_low", (
            f"{word.encode('unicode_escape').decode()} did not name the price order")
        assert prices == sorted(prices), (
            f"{word.encode('unicode_escape').decode()} did not reorder the answer: {prices}")
        assert items, "the refinement emptied the answer"


def test_the_second_turn_narrows_the_distance_in_the_traditional_spelling(client):
    first, items, _prices = _turn(client, RAMEN)
    assert items
    intent, items, _prices = _turn(client, CLOSER_TRADITIONAL, dict(first))
    assert intent.get("sort_preference") == "distance", (
        "the traditional spelling of the distance refinement did not name the order")
    location = intent.get("location") or {}
    assert location.get("radius_m"), "the radius was not tightened"
