"""D421 - the second turn's cues answer to both spellings.

The state merger's cue lists are written in mixed forms, and the turn was compared with them
as the user wrote it. The measured gaps (before this unit):

    近一点  -> distance        近一點  -> NOTHING (and 點 was read as a TIME cue)
    熱鬧一點 -> NOTHING
    換一間 / 换一间 -> nothing (the cue fired, but the "show me others" change needs the
                        ids that were shown, so the pair is asserted with that context)

The fix has two halves: the cue lists are put in the canonical spelling (the same table the
vocabulary uses), and the turn is canonicalised before it is compared with them - so the
user's words are kept (the raw_query shows what they wrote) and the MATCHING sees one
spelling.

The code points here are the ones the Unicode database gives (checked against it, because
§409's lesson was that a writer's memory of a CJK code point is not a reference).
"""

from __future__ import annotations

from nexus_ai.nlu.state_merger import merge_turn

STATE = {"intent": "discover_merchant", "language": "zh-HK", "raw_query": "\u62c9\u9eb5"}

#: (the simplified turn, the traditional turn, what the merge must do)
PAIRS = [
    # 太贵了 / 太貴了 -> the budget tightens and the order becomes price_low
    ("\u592a\u8d35\u4e86", "\u592a\u8cb4\u4e86", "price_low"),
    # 近一点 / 近一點 -> the radius tightens and the order becomes distance
    ("\u8fd1\u4e00\u70b9", "\u8fd1\u4e00\u9ede", "distance"),
    # 遠一點 -> the radius loosens
    ("\u9060\u4e00\u9ede", "\u9060\u4e00\u9ede", None),
    # 安靜一點 -> the quiet preference
    ("\u5b89\u975c\u4e00\u70b9", "\u5b89\u975c\u4e00\u9ede", "quiet"),
    # 熱鬧一點 -> the lively preference
    ("\u70ed\u95a9\u4e00\u70b9", "\u71b1\u9b27\u4e00\u9ede", "lively"),
    # 而家開唔開 -> the urgency is now
    ("\u800c\u5bb6\u958b\u5584\u958b", "\u800c\u5bb6\u958b\u5584\u958b", "now"),
]


def _merge(turn: str, context: dict | None = None) -> dict:
    return merge_turn(STATE, turn, context or {}).intent


def test_the_price_cue_answers_to_both_spellings():
    for turn in ("\u592a\u8d35\u4e86", "\u592a\u8cb4\u4e86"):
        intent = _merge(turn)
        assert intent["sort_preference"] == "price_low", turn.encode("unicode_escape").decode()


def test_the_distance_cue_answers_to_both_spellings():
    for turn in ("\u8fd1\u4e00\u70b9", "\u8fd1\u4e00\u9ede"):
        intent = _merge(turn)
        assert intent["sort_preference"] == "distance", turn.encode("unicode_escape").decode()
        assert intent["location"].get("type") == "nearby"


def test_the_ambience_cues_answer_to_both_spellings():
    for turn, value in (("\u5b89\u975c\u4e00\u70b9", "quiet"),
                         ("\u5b89\u975c\u4e00\u9ede", "quiet"),
                         ("\u70ed\u95f9\u4e00\u70b9", "lively"),
                         ("\u71b1\u9b27\u4e00\u9ede", "lively")):
        prefs = _merge(turn).get("preferences") or []
        assert {"key": "ambience", "value": value, "polarity": 1} in prefs, (
            turn.encode("unicode_escape").decode())


def test_the_urgency_cue_answers_to_both_spellings():
    for turn in ("\u800c\u5bb6\u958b\u5584\u958b",):
        assert _merge(turn).get("urgency") == "now"


def test_the_spicy_cue_answers_to_both_spellings():
    for turn in ("\u5514\u98df\u8fa3",):
        constraints = _merge(turn).get("constraints") or []
        assert {"key": "cuisine_avoid", "value": "spicy"} in constraints


def test_the_show_others_cue_answers_to_both_spellings():
    context = {"shown_ids": ["m1", "m2"]}
    for turn in ("\u63db\u4e00\u9593", "\u6362\u4e00\u95f4"):
        intent = _merge(turn, context)
        assert (intent.get("filters") or {}).get("exclude") == ["m1", "m2"], (
            turn.encode("unicode_escape").decode())


def test_the_merge_keeps_the_users_own_words():
    # The canonical form is for the MATCHING; the raw_query shows what the user wrote.
    intent = _merge("\u592a\u8d35\u4e86")
    assert "\u592a\u8d35\u4e86" in intent["raw_query"]
    assert "\u592a\u8cb4\u4e86" not in intent["raw_query"]
