"""D484 - the follow-up question follows the product's DECLARED priority, and the
machinery holds no promise nobody keeps.

The order list says which missing thing matters most - the intent, the party size, the
time, the location, the category - and the reader took whichever unknown came first in
the list, which is the order the producer appended them:

    "book a table" -> the unknowns ['category', 'location', 'party_size', 'time']
                    -> the question "Looking for a place or a product?"

The user said "book a table". The product asked whether they want a place or a product -
and the PARTY SIZE, the unknown the contract's own example names, was never asked.

Two dead entries went with it: the "budget" question (the producer never reports the
budget as missing - a budget is optional) and the "compare_targets" unknown (a compare
turn needs two entities to BE a compare turn).

This gate CENSUSES the machinery: every unknown the producer can emit must be in the
order and have a question, and every question in the bank must be one the producer can
ask.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import understand as U
from nexus_ai.nlu.state_merger import (
    FOLLOWUP_QUESTIONS,
    _ONE_FOLLOWUP_ORDER,
    question_for,
)

#: the cases the producer's branches can produce - one per branch
CASES: list[dict[str, object]] = [
    {"intent": "unknown"},
    {"intent": "discover_merchant"},
    {"intent": "discover_merchant", "category": "cafe"},
    {"intent": "discover_merchant", "category": "cafe", "location": {"type": "nearby"}},
    {"intent": "discover_merchant", "category": "cafe", "location": {"type": "district"}},
    {"intent": "reserve"},
    {"intent": "reserve", "category": "restaurant", "location": {"type": "district"}},
    {"intent": "reserve", "category": "restaurant", "location": {"type": "district"},
     "party_size": 4},
    {"intent": "reserve", "category": "restaurant", "location": {"type": "district"},
     "party_size": 4, "time": {"type": "range"}},
    {"intent": "compare", "mentioned_entities": ["a", "b"]},
    {"intent": "plan_experience", "location": {"type": "district"}},
]


def _unknowns(**fields: object) -> list[str]:
    ex = U.IntentExtraction(raw_query="x", **fields)  # type: ignore[arg-type]
    return U._compute_unknowns(ex)


@pytest.mark.parametrize("case", CASES, ids=lambda c: str(c.get("intent")))
def test_every_unknown_the_producer_can_emit_is_asked_about(case: dict[str, object]):
    """The census: the producer's unknowns are the order's unknowns."""
    for unknown in _unknowns(**case):
        assert unknown in _ONE_FOLLOWUP_ORDER, (
            f"the producer reports the unknown {unknown!r} and the follow-up order does "
            f"not know it - the product would report what it is missing and ask nothing")
        for locale, bank in FOLLOWUP_QUESTIONS.items():
            assert bank.get(unknown), (
                f"{locale} has no question for the unknown {unknown!r} - the product "
                f"reports it and asks nothing")


def test_no_question_in_the_bank_is_one_the_producer_never_asks():
    """The other direction: the bank holds no promise nobody keeps."""
    reachable = {u for case in CASES for u in _unknowns(**case)}
    for locale, bank in FOLLOWUP_QUESTIONS.items():
        for unknown in bank:
            assert unknown in reachable, (
                f"{locale} holds a question for {unknown!r} and the producer never reports "
                f"that unknown - a promise nobody keeps")


def test_the_question_follows_the_declared_priority():
    """The order decides - not the order the unknowns happened to be appended."""
    for later, earlier in (("category", "party_size"), ("category", "location"),
                           ("location", "party_size"), ("time", "party_size"),
                           ("party_size", "intent")):
        unknowns = [later, earlier]
        asked = question_for({"unknowns": unknowns, "language": "en"})
        assert asked == FOLLOWUP_QUESTIONS["en"][earlier], (
            f"the unknowns {unknowns} were asked about {asked!r} - the ORDER says "
            f"{earlier!r} comes first")


def test_a_table_booking_asks_for_the_party_size():
    """The end-to-end proof: the contract's own example is a table booking."""
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    with TestClient(create_app(settings)) as client:
        answer = client.post("/ai/v1/query/understand",
                              json={"query": "book a table", "context": {}}).json()
    assert answer.get("follow_up_question") == FOLLOWUP_QUESTIONS["en"]["party_size"], (
        f"'book a table' was asked {answer.get('follow_up_question')!r} - the user said they "
        f"want a table, and the party size is the unknown the contract's example names")
