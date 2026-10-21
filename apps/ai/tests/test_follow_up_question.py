"""D439 - §8's follow-up question, delivered.

API_CONTRACT §7.1 says the intent carries `"unknowns": ["party_size"]  // §8 - never guess;
ask in one follow-up only`. The question itself was written - `nlu/state_merger.py` holds it
in the user's language - and it was delivered nowhere: the understand endpoint's
`follow_up_question` was ALWAYS null, because only the merge path (the second turn of a
conversation) ever asked for it, and the endpoint that would carry it never merges.

So the question is asked on every turn now, and this file asks the live plane whether it
arrives - and in which language.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _client():
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    return settings


def _understand(client, query: str, context: dict | None = None) -> dict:
    r = client.post("/ai/v1/query/understand", json={"query": query, "context": context or {}})
    assert r.status_code == 200, r.text
    return r.json()


def test_the_endpoint_asks_the_one_question_the_intent_leaves_open():
    from fastapi.testclient import TestClient

    with TestClient(create_app(_client())) as c:
        body = _understand(c, "餐廳")
        intent = body  # D466: the answer IS the intent (the contract's §7 row)
        assert intent.get("unknowns"), "the intent guessed everything - nothing to ask"
        assert body.get("follow_up_question"), (
            "the intent leaves something unknown and the endpoint asks nothing: "
            "§8 says ask, once, in one follow-up")


def test_the_question_is_in_the_users_language():
    from fastapi.testclient import TestClient

    with TestClient(create_app(_client())) as c:
        traditional = _understand(c, "餐廳")
        simplified = _understand(c, "餐厅")
        english = _understand(c, "coffee")
        assert traditional["follow_up_question"], "no question for the traditional query"
        assert traditional["follow_up_question"] != english["follow_up_question"], (
            "the question is the same in every language")
        assert english["follow_up_question"].isascii(), (
            "the English user was asked in Chinese")
        # the Simplified spelling is the one D435 made the locale detection know
        assert simplified["language"] == "zh-CN", (
            "the Simplified query was not read as Simplified")
        assert simplified["follow_up_question"], "no question for the simplified query"


def test_nothing_to_ask_means_no_question():
    from fastapi.testclient import TestClient

    with TestClient(create_app(_client())) as c:
        body = _understand(c, "拉麵", context={"locale": "zh-HK"})
        intent = body  # D466: the answer IS the intent (the contract's §7 row)
        if not intent.get("unknowns"):
            assert body.get("follow_up_question") is None, (
                "the endpoint asked a question it had no unknown to ask about")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_live_plane_asks_it_too():
    from fastapi.testclient import TestClient

    with TestClient(create_app(_client())) as c:
        body = _understand(c, "餐廳")
        assert body.get("follow_up_question"), (
            "the live plane delivered no follow-up question")
        assert body.get("unknowns")  # D466: the answer IS the intent
