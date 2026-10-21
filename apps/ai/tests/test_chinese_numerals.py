"""D445 - the Chinese numerals are read in the places a user writes them.

The product already read the WEEKDAY numerals (星期三 ✓). It did not read the two a user
writes most: the HOUR (九點 ✗) and the PARTY SIZE (三個人 ✗). So a Hong Kong user who
wrote a number the way they spoke was understood only in the weekdays, and the numerals
were read in exactly one place.

The code points were checked against the Unicode character database - a writer's memory of
a CJK code point is not a reference (D409) - and every character below is written as an
escape for the same reason.

The rule now lives in one module (`nlu/numerals.py`) and the readers call it: the time
parser reads the hour, the NLU reads the party size, and the state merger's second turn
reads it too - the same way the first turn does.
"""

from __future__ import annotations

from nexus_ai.nlu.numerals import cn_number, normalise_numerals
from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.nlu.understand import extract_intent_dict

#: 零 〇 一 二 兩 两 三 四 五 六 七 八 九 十
ZERO = "\u96f6"
ONE = "\u4e00"
NINE = "\u4e5d"
TEN = "\u5341"
LIANG = "\u5169"        # 兩
LIANG_SIMPLIFIED = "\u4e24"   # 两
TWO = "\u4e8c"
THREE = "\u4e09"
ELEVEN = TEN + ONE
TWELVE = TEN + TWO
TWENTY = TWO + TEN
TWENTY_THREE = TWO + TEN + THREE

#: 點 点 時 时 個 个 位 人 星期 晚上 食 飯 饭 吃 安靜
DIAN = "\u9ede"
DIAN_SIMPLIFIED = "\u70b9"
SHI = "\u6642"
GE = "\u500b"
GE_SIMPLIFIED = "\u4e2a"
WEI = "\u4f4d"
REN = "\u4eba"
WEEKDAY = "\u661f\u671f"
EVENING = "\u665a\u4e0a"
EAT = "\u98df\u9910"
EAT_SIMPLIFIED = "\u5403\u996d"
QUIET = "\u5b89\u975c"


def _base_intent() -> dict:
    return {
        "intent": "discover_merchant", "raw_query": "x", "unknowns": [],
        "language": "zh-HK", "budget": None, "party_size": None, "location": {},
        "preferences": [], "constraints": [], "category": "restaurant",
    }


def test_the_numeral_reader_knows_the_digits_and_the_compounds():
    assert cn_number(ZERO) == 0
    assert cn_number(ONE) == 1
    assert cn_number(NINE) == 9
    assert cn_number(TEN) == 10
    assert cn_number(ELEVEN) == 11
    assert cn_number(TWELVE) == 12
    assert cn_number(TWENTY) == 20
    assert cn_number(TWENTY_THREE) == 23
    assert cn_number(LIANG) == 2
    assert cn_number("") is None
    assert cn_number(EAT) is None
    assert cn_number(TEN + "x") is None


def test_the_numeral_is_rewritten_only_where_it_is_a_number():
    # the weekday stays a weekday - 星期三 is Wednesday, not 星期3
    text = WEEKDAY + THREE + EVENING + NINE + DIAN
    rewritten = normalise_numerals(text, only_before=DIAN + DIAN_SIMPLIFIED + SHI)
    assert WEEKDAY + THREE in rewritten, "the weekday was rewritten into a number"
    assert "9" + DIAN in rewritten, "the hour was not rewritten into a digit"


def test_the_hour_is_read_in_both_spellings():
    for query in ("9" + DIAN + EAT, NINE + DIAN + EAT,
                  "9" + DIAN_SIMPLIFIED + EAT_SIMPLIFIED,
                  NINE + DIAN_SIMPLIFIED + EAT_SIMPLIFIED):
        intent = extract_intent_dict(query)
        time = intent.get("time") or {}
        assert time.get("starts_at"), (
            f"the hour was not read: {query.encode('unicode_escape').decode()}")
        assert time.get("type") == "explicit"


def test_the_party_size_is_read_in_both_spellings():
    for query, expected in (
            ("3" + GE + REN + EAT, 3), (THREE + GE + REN + EAT, 3),
            ("3" + GE_SIMPLIFIED + REN + EAT_SIMPLIFIED, 3),
            (THREE + GE_SIMPLIFIED + REN + EAT_SIMPLIFIED, 3),
            ("2" + WEI, 2), (LIANG + WEI, 2), (LIANG_SIMPLIFIED + WEI, 2)):
        intent = extract_intent_dict(query)
        assert intent.get("party_size") == expected, (
            f"the party size was not read: "
            f"{query.encode('unicode_escape').decode()}")


def test_the_two_spellings_reach_the_same_intent():
    # D435's lesson: the two spellings of a word must meet. A number the user writes is
    # the same number whichever way they write it.
    digits = extract_intent_dict("3" + GE + REN + EAT)
    numerals = extract_intent_dict(THREE + GE + REN + EAT)
    assert digits["party_size"] == numerals["party_size"] == 3
    assert digits["intent"] == numerals["intent"]
    assert digits["category"] == numerals["category"]


def test_the_merge_reads_the_second_turn_the_same_way():
    for turn in ("3" + WEI, THREE + WEI, "3" + GE + REN, THREE + GE + REN):
        result = merge_turn(_base_intent(), turn)
        assert result.intent.get("party_size") == 3, (
            f"the merge did not read the party size: "
            f"{turn.encode('unicode_escape').decode()}")


def test_the_weekday_still_reads():
    for query in (WEEKDAY + THREE + EAT, WEEKDAY + THREE + EVENING + "7" + DIAN):
        intent = extract_intent_dict(query)
        time = intent.get("time") or {}
        assert time.get("starts_at"), (
            f"the weekday was lost: {query.encode('unicode_escape').decode()}")


def test_the_chinese_one_is_not_a_number_where_the_product_said_so():
    # The product has already decided what 一 means in these two places, and both
    # decisions are tested elsewhere: "一個人" is the SOLO cue and does not become a party
    # size (an honest reading, not a guess), and "安靜一點" is a DEGREE and not one
    # o'clock. So the numeral ONE is not read as a number here.
    assert extract_intent_dict(ONE + GE + REN)["party_size"] is None, (
        "一個人 became a party size - it is the solo cue")

    quiet = extract_intent_dict(QUIET + ONE + DIAN)
    time = quiet.get("time") or {}
    assert not time.get("starts_at") or not str(time.get("starts_at")).endswith("13:00:00"), (
        "安靜一點 was read as one o'clock - it is a degree")

    # and the compound forms are unaffected: 十一 is eleven
    assert extract_intent_dict(TEN + ONE + GE + REN)["party_size"] == 11, (
        "十一個人 did not read as eleven people")
