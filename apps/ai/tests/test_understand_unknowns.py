"""§8 — query understanding never guesses. A field it cannot resolve stays `null`
and is listed in `unknowns`; it is never filled with a plausible-looking default.

These pin the contract of `nexus_ai.nlu.understand` so a later tweak cannot quietly
start fabricating intent/category/location/party_size to look more confident. All
pure logic — no DB, no provider.
"""

from __future__ import annotations

from nexus_ai.nlu.understand import IntentExtraction, _compute_unknowns, extract_intent


def test_empty_query_lists_intent_as_unknown():
    ex = extract_intent("   ")
    assert ex.intent == "unknown"
    assert ex.unknowns == ["intent"]
    # nothing fabricated from nothing
    assert ex.category is None
    assert ex.location == {}


def test_never_guesses_party_size_from_a_couple():
    # §8 / AGENT_CONTRACT §1: "情侣/约会" must NOT become party_size=2.
    ex = extract_intent("情侣约会")
    assert ex.party_size is None
    # and the vague turn is honest about what it lacks rather than inventing a party
    assert "intent" in ex.unknowns or ex.intent == "unknown"


def test_vague_discover_lists_unknowns_instead_of_fabricating():
    # a discovery verb with no named category/location must stay null and be surfaced,
    # never filled with a guessed category or a session-geo location.
    ex = extract_intent("有什么好推荐")
    assert ex.intent == "discover_merchant"
    assert ex.category is None
    assert not ex.location
    assert ex.budget is None
    assert "category" in ex.unknowns
    assert "location" in ex.unknowns


def test_reserve_without_party_and_time_lists_both():
    # the reservation contract needs a party and a time; if absent, say so.
    ex = IntentExtraction(raw_query="预约", intent="reserve",
                          location={"type": "district", "value": "X"})
    unknowns = _compute_unknowns(ex)
    assert "party_size" in unknowns
    assert "time" in unknowns


def test_garbage_input_does_not_raise_and_stays_honest():
    ex = extract_intent("🔥🤷‍♂️ ㊙️")
    # the engine must not crash on noise; it returns a valid, unguessed result
    assert ex.intent in {"unknown"}
    assert isinstance(ex.unknowns, list) and ex.unknowns
    assert ex.category is None
