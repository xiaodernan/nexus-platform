"""D483 - the one unknown the product asks nothing about: the INTENT.

The follow-up question is the contract's §8 promise - "ask about the single most
important missing thing, in the user's language" - and the intent's unknowns were read
from a list of five that did not include "intent". So a query the product cannot classify
carried `unknowns: ["intent"]` and **no question at all**: the user was told the product
does not know what it is looking for, and then it asked nothing.

    "open now"             -> the unknowns ['intent']   the question None   (before)
    "open now"             -> the unknowns ['intent']   the question "What are you looking for?"

The bank is a TABLE now, so this gate can read it: every unknown the product can carry
must have a question in every locale.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.state_merger import FOLLOWUP_QUESTIONS, _ONE_FOLLOWUP_ORDER, question_for

#: the locales the bank carries
LOCALES = ("zh-HK", "zh-CN", "en")

#: a query that leaves each unknown the product can carry
CASES = {
    "intent": "open now",
    "location": "coffee",
    "category": "book a table",
}


@pytest.mark.parametrize("locale", LOCALES)
def test_every_unknown_has_a_question_in_every_locale(locale: str):
    """The bank must cover the order list in every locale."""
    bank = FOLLOWUP_QUESTIONS.get(locale)
    assert bank, f"the question bank has no {locale} section"
    for unknown in _ONE_FOLLOWUP_ORDER:
        assert bank.get(unknown), (
            f"{locale} has no question for the unknown {unknown!r} - the product would ask "
            f"nothing about the one thing it knows least")


def test_the_order_covers_the_intent():
    assert "intent" in _ONE_FOLLOWUP_ORDER, (
        "the intent is not in the follow-up order - a query the product cannot classify "
        "would carry the unknown and ask nothing")


@pytest.mark.parametrize("unknown,query", sorted(CASES.items()))
def test_an_unknown_carries_a_question(unknown: str, query: str):
    """The end-to-end proof: the answer asks something."""
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    with TestClient(create_app(settings)) as client:
        answer = client.post("/ai/v1/query/understand",
                             json={"query": query, "context": {}}).json()
    assert unknown in (answer.get("unknowns") or []), (
        f"{query!r} does not leave the unknown {unknown!r} - the gate's case is stale: "
        f"{answer.get('unknowns')}")
    assert answer.get("follow_up_question"), (
        f"{query!r} leaves the unknown {unknown!r} and asks NOTHING - the product tells the "
        f"user it does not know and then says nothing")


def test_the_question_is_asked_in_the_users_language():
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    with TestClient(create_app(settings)) as client:
        english = client.post("/ai/v1/query/understand",
                              json={"query": "open now", "context": {}}).json()
        chinese = client.post("/ai/v1/query/understand",
                              json={"query": "\u6253\u5f00\u5427",
                                    "context": {"locale": "zh-HK"}}).json()
    assert english.get("follow_up_question"), "the English query asks nothing"
    assert chinese.get("follow_up_question"), "the Chinese query asks nothing"
    assert english["follow_up_question"] != chinese["follow_up_question"], (
        "the two languages asked the same question - the bank must be per locale")


def test_the_question_reader_uses_the_table():
    for locale in LOCALES:
        for unknown in _ONE_FOLLOWUP_ORDER:
            assert question_for({"unknowns": [unknown], "language": locale}) == \
                FOLLOWUP_QUESTIONS[locale][unknown], (
            f"{locale}/{unknown}: the reader and the table disagree")
