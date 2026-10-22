"""D489 - the merge is PURE: it does not change the state it was given.

The module's own words: "Merging is *pure and ordered* so it unit-tests without a model".
The state was copied with `dict(state)` - a SHALLOW copy - so the nested lists (the
preferences, the constraints) were the CALLER'S, and the residual absorb appends to them:

    the turn 'romantic dinner'   the caller's preferences [] -> [{'key': 'occasion', ...}]

So a caller that keeps the state - to merge the next turn - found the turn's preferences
already in it. This gate holds the promise: the merge reads the state and leaves it exactly
as it found it.
"""

from __future__ import annotations

import copy

import pytest

from nexus_ai.nlu import state_merger as M

STATE = {
    "raw_query": "coffee", "intent": "discover_merchant", "category": "cafe",
    "budget": None, "party_size": None, "preferences": [], "constraints": [],
    "sort_preference": "relevance",
    "location": {"type": "district", "value": "Sha Tin"},
    "time": {}, "confidence": {}, "unknowns": [],
}

#: the turns that touch the state - the urgency, a preference, a constraint, a place
TURNS = ["quiet cafe", "romantic dinner", "a view", "mtr", "rainy day", "spicy food",
         "no garlic", "near me", "next week", "coffee"]


@pytest.mark.parametrize("turn", TURNS)
def test_the_merge_leaves_the_state_it_was_given_untouched(turn: str):
    """The promise: the merge reads the state and writes into its own copy."""
    state = copy.deepcopy(STATE)
    before = copy.deepcopy(state)
    M.merge_turn(state, turn)
    assert state == before, (
        f"the turn {turn!r} changed the state it was given: {state} was {before}")


def test_the_merge_is_deterministic():
    """The same state and the same turn give the same answer, every time."""
    for turn in TURNS:
        first = M.merge_turn(copy.deepcopy(STATE), turn)
        second = M.merge_turn(copy.deepcopy(STATE), turn)
        assert first.intent == second.intent, (
            f"the turn {turn!r} gave two different answers")


def test_the_merge_still_reads_the_state():
    """The fix must not cost the product the carried state."""
    state = copy.deepcopy(STATE)
    state["preferences"] = [{"key": "ambience", "value": "quiet", "polarity": 1}]
    result = M.merge_turn(state, "near me")
    preferences = {(p.get("key"), p.get("value")) for p in result.intent.get("preferences", [])}
    assert ("ambience", "quiet") in preferences, (
        f"the carried preference was lost: {preferences}")


def test_the_caller_can_merge_twice_onto_the_same_state():
    """Two turns, one state - the second must not see the first turn's preferences."""
    state = copy.deepcopy(STATE)
    first = M.merge_turn(state, "romantic dinner")
    second = M.merge_turn(state, "a view")
    first_prefs = [(p.get("key"), p.get("value"))
                   for p in first.intent.get("preferences", [])]
    second_prefs = [(p.get("key"), p.get("value"))
                    for p in second.intent.get("preferences", [])]
    assert first_prefs == [("occasion", "date")], (
        f"the first answer carried {first_prefs} - the merge changed the state it was "
        f"given")
    assert second_prefs == [("view", "scenic")], (
        f"the second answer carried {second_prefs} - it saw the first turn's preferences, "
        f"which were never the caller's")
