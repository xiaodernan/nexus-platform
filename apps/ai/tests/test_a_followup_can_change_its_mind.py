"""D528 - a follow-up that changes its mind is not dropped on the floor.

`_absorb` pulls whatever a follow-up resolved into the carried state, and its preference
half tested `p["key"] not in {the keys the state holds}`. A preference the state already
carried was therefore DROPPED - and dropping it is not neutral:

    "我想要海景"  then  "唔好海景"  ->  view=scenic, polarity **+1**

A negation the user typed in the follow-up was discarded and the thing they refused stayed
a LIKE, which the ranking lane then boosts: the D523 inversion, reached from the merge lane
instead of the polarity lane. And the same test dropped a plain change of mind:

    "我想食日本菜"  then  "想食泰國菜"  ->  cuisine=japanese, and `changes: []`

The user was answered with the cuisine they had abandoned, and because nothing was recorded
no `agent_run` could explain what the turn did (§34: "every change is recorded").

The fix makes the turn's values for a key REPLACE the state's values for that key, and
records the replacement with the polarity attached, so a flip from +1 to -1 is visible in
the record and not only in the state. Re-stating what the state already carries is still a
no-op. It was **proved to fail**: restoring the membership test reddens the checks below
(the probe was put back).
"""

from __future__ import annotations

from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.nlu.understand import extract_intent

JAPANESE = "我想食日本菜"      # 我想食日本菜
THAI = "想食泰國菜"                # 想食泰國菜
WANT_VIEW = "我想要海景"          # 我想要海景
NO_VIEW = "唔好海景"                  # 唔好海景
VEGETARIAN = "我想食素食"          # 我想食素食


def _state(query: str) -> dict:
    return extract_intent(query).to_dict()


def _prefs(result) -> dict[tuple[str, str], int]:
    return {(str(p.get("key")), str(p.get("value"))): int(p.get("polarity", 1))
            for p in result.intent.get("preferences") or []}


def test_a_followup_can_name_a_different_cuisine():
    before = _state(JAPANESE)
    assert ("cuisine", "japanese") in _prefs(_Merge(before)), "the fixture is not what it claims"
    after = merge_turn(before, THAI)
    assert _prefs(after) == {("cuisine", "thai"): 1}, (
        f"a follow-up naming a different cuisine left {_prefs(after)} - the user changed "
        f"their mind and was answered with what they abandoned")


def test_the_replacement_is_recorded():
    after = merge_turn(_state(JAPANESE), THAI)
    recorded = [c for c in after.changes if c.get("field") == "preferences.cuisine"]
    assert recorded, (
        f"the merge changed the cuisine and recorded nothing: {after.changes} - §34 says "
        f"every change is recorded so an agent_run can explain what the turn did")
    assert recorded[0].get("from") == [["japanese", 1]], recorded[0]
    assert recorded[0].get("to") == [["thai", 1]], recorded[0]


def test_a_negation_in_a_followup_flips_the_polarity():
    """The D523 inversion, reached from the merge lane instead of the polarity lane."""
    after = merge_turn(_state(WANT_VIEW), NO_VIEW)
    assert _prefs(after) == {("view", "scenic"): -1}, (
        f"a follow-up that refused the view left {_prefs(after)} - the negation was "
        f"discarded and the thing the user refused is still a LIKE, which the ranking "
        f"lane then boosts")


def test_the_polarity_flip_is_visible_in_the_record():
    after = merge_turn(_state(WANT_VIEW), NO_VIEW)
    recorded = [c for c in after.changes if c.get("field") == "preferences.view"]
    assert recorded, f"the flip was recorded nowhere: {after.changes}"
    assert recorded[0].get("from") == [["scenic", 1]], recorded[0]
    assert recorded[0].get("to") == [["scenic", -1]], recorded[0]


def test_restating_the_same_preference_changes_nothing():
    before = _state(VEGETARIAN)
    after = merge_turn(before, VEGETARIAN)
    assert _prefs(after) == _prefs(_Merge(before))
    assert not [c for c in after.changes if str(c.get("field", "")).startswith("preferences.")], (
        f"re-stating what the state already carries recorded a change: {after.changes}")


def test_a_new_key_joins_without_disturbing_the_others():
    after = merge_turn(_state(JAPANESE), "安靜啓斸")  # 安靜啲
    prefs = _prefs(after)
    assert ("cuisine", "japanese") in prefs, (
        f"absorbing a new key dropped the one the state already carried: {prefs}")
    assert ("ambience", "quiet") in prefs, f"the new key was not absorbed: {prefs}"


def test_the_merge_stays_pure():
    before = _state(JAPANESE)
    snapshot = repr(before)
    merge_turn(before, THAI)
    assert repr(before) == snapshot, (
        "the merge mutated the state it was given - D489's deep copy is not holding")


class _Merge:
    """The state as the first turn left it, wrapped so the assertion reads plainly."""

    def __init__(self, state: dict):
        self.intent = state
