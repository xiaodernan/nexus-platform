"""D406 - the order the user's own words named reaches the served answer.

`plan_from_intent()` has written `plan.sort_preference` since the intent layer existed, and
`nlu/state_merger.py` fills it from the user's own words ("太贵了" -> `price_low`, "近一点" ->
`distance`), but the ranking pipeline never read it: every follow-up that named an order came
back with the same cards in the same order. The sibling lane measured it on the live plane and
filed the reader: "the 8 cards and their first four slugs are identical across turns".

This file pins the reader on the live plane, through the SSE stream the product's own surface
uses, with the two turns the contract names (§34):
  * turn 1 says WHAT ("拉麵"), turn 2 says in what ORDER ("太贵了");
  * the order the words named has to be visible in the answer's prices, not only in the intent
    object that the answer never showed.

The prices are the evidence because they are the thing the user complained about, and the
comparison is turn 1 against turn 2 on the SAME corpus: a change in the served order that no
turn-2 word asked for would be a defect, so the test also asserts the order is not merely
ascending but that it CHANGED from turn 1.
"""

from __future__ import annotations

import json
import os

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

RAMEN = "\u62c9\u9eb5"
TOO_EXPENSIVE = "\u592a\u8d35\u4e86"


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _stream(client, query: str, previous_intent: dict | None = None) -> tuple[dict, list]:
    """The SSE stream's own frames: the intent it understood and the cards it served."""
    payload: dict = {"query": query, "limit": 8}
    if previous_intent is not None:
        payload["previous_intent"] = previous_intent
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
    return intent, items


def _prices(items: list) -> list[float]:
    out = []
    for item in items:
        price = (item.get("price") or {}).get("amount")
        if price is not None:
            out.append(float(price))
    return out


def _slugs(items: list) -> list[str]:
    return [str(item.get("slug")) for item in items]


@pytest.mark.integration
def test_the_order_the_words_named_reaches_the_served_prices(live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        first_intent, first_items = _stream(c, RAMEN)
        assert first_items, "the corpus has restaurants and the first turn served none"
        assert first_intent.get("sort_preference") == "relevance"

        second_intent, second_items = _stream(c, TOO_EXPENSIVE,
                                               previous_intent=first_intent)

    # the merge kept the subject and named the order
    assert second_intent.get("sort_preference") == "price_low"
    assert second_intent.get("category") == first_intent.get("category")

    prices = _prices(second_items)
    assert len(prices) == len(second_items), "a card without a price was served"
    assert prices == sorted(prices), f"the prices are not ascending: {prices}"

    # and the order CHANGED: the follow-up was answered, not acknowledged
    assert _slugs(second_items) != _slugs(first_items), (
        "the follow-up named an order and the answer came back unchanged")


@pytest.mark.integration
def test_the_english_cue_names_the_same_order(live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        first_intent, _ = _stream(c, RAMEN)
        second_intent, second_items = _stream(c, "too expensive",
                                               previous_intent=first_intent)

    assert second_intent.get("sort_preference") == "price_low"
    prices = _prices(second_items)
    assert prices == sorted(prices), f"the prices are not ascending: {prices}"
