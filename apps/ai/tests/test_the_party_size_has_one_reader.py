"""D518 - the party size has ONE reader, and both turns use it.

`state_merger.py` said so in a comment: "D445: the numerals are read here too - 三位 is three
seats, and the merge's own rule has to agree with the first turn's (the shared reader is in
`nlu/understand`)." The code did not use the shared reader. It kept a private copy of the
pattern, and the copy had lost the leading-digit guard `PARTY_RE` puts on its CJK alternative:

    "113個人"  ->  the first turn reads NO party size (§8: do not invent a number)
                ->  the merge read THIRTEEN SEATS

Measured at HEAD, the two readers disagreed on every turn whose party counter follows a digit
run of three or more: "113個人", "113位", "HK$113位人", "這角落有213人". One fact, two readers,
and the merge's copy was the one that invented a number.

This gate holds the two to one reader:
  * `understand.party_size_of` is the only place the pattern lives;
  * the merge's answer for a turn is that reader's answer for the same turn, for every form
    the product's own tables name - the CJK counters, the latin units, the spelled-out
    Chinese numerals, and the long digit runs that must NOT be read.

It was **proved to fail**: putting the private copy back reddens these checks (the probe was
put back).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.state_merger import merge_turn
from nexus_ai.nlu.understand import PARTY_RE, extract_intent, party_size_of

#: a state that is NOT a cold start, so `merge_turn` takes the follow-up branch (the one that
#: used to keep the private regex) instead of re-extracting from scratch
BASE = {"raw_query": "揄餐廳", "intent": "discover", "category": "restaurant",
        "language": "zh-HK", "location": {}, "time": {}, "preferences": [],
        "constraints": [], "unknowns": [], "confidence": {}}

#: every form the product's own tables name, with the answer the reader must give
READS = [
    ("三個人", 3),            # 三個人 - the spelled-out numeral
    ("3個人", 3),                 # 3個人 - the digit
    ("十一個人", 11),    # 十一個人 - the compound
    ("兩個人", 2),           # 兩個人
    ("12位", 12),                      # 12位
    ("40位", 40),                      # 40位 - the top of the range
    ("2個人", 2),                 # 2個人
    ("6 guests", 6), ("5 diners", 5), ("9 persons", 9), ("8 pax", 8),
    ("party of 4", 4), ("for 6 people", 6),
]

#: turns that must NOT be read as a party size
NOT_READS = [
    "星期三",                # 星期三 - a weekday, not three people
    "一個人",                # 一個人 - the solo cue, not one seat
    "安静一點",          # 安靜一點 - a degree, not one o'clock
    "41個人",                     # 41個人 - past the range
    "0個人",                      # 0個人 - not a party
    "双人",                       # 雙人 - not a numeral
    # the digit runs: three or more digits before a counter is not a party size
    "113個人", "113位", "250人", "99人", "100人",
    "HK$113位人", "這角落有213人",
]


@pytest.mark.parametrize("text,expected", READS, ids=[t for t, _ in READS])
def test_the_one_reader_reads_every_form_the_product_names(text, expected):
    assert party_size_of(text) == expected


@pytest.mark.parametrize("text", NOT_READS, ids=NOT_READS)
def test_the_one_reader_refuses_to_invent_a_party_size(text):
    assert party_size_of(text) is None, (
        f"{text!r} was read as a party size - §8 forbids inventing a number the turn does "
        f"not state")


@pytest.mark.parametrize("text,expected", READS, ids=[t for t, _ in READS])
@pytest.mark.parametrize("surface", ["first turn", "follow-up"])
def test_both_turns_read_the_party_size_the_same_way(text, expected, surface):
    """The same turn, read by the first turn and by the merge, gives the same party size."""
    first = extract_intent(text).party_size
    merged = merge_turn(BASE, text).intent.get("party_size")
    assert first == expected, f"the first turn read {text!r} as {first}, not {expected}"
    assert merged == expected, (
        f"the merge read {text!r} as {merged} and the first turn read {first} - one fact, "
        f"two readers ({surface})")


@pytest.mark.parametrize("text", NOT_READS, ids=NOT_READS)
def test_neither_turn_invents_a_party_size(text):
    assert extract_intent(text).party_size is None
    assert merge_turn(BASE, text).intent.get("party_size") is None


def test_the_merge_uses_the_one_reader_and_not_a_private_copy():
    """The merge's answer IS the reader's answer - not a second pattern that happens to
    agree on the cases someone thought to try."""
    import inspect

    from nexus_ai.nlu import state_merger

    source = inspect.getsource(state_merger)
    assert "party_size_of" in source, (
        "the merge no longer calls the shared reader - it has grown a private copy again")
    for text, _expected in READS + [(t, None) for t in NOT_READS]:
        assert merge_turn(BASE, text).intent.get("party_size") == party_size_of(text)


def test_the_pattern_still_guards_a_long_digit_run():
    """The guard is the thing the private copy lost, so it is pinned on its own."""
    assert PARTY_RE.search("113個人") is None
    assert party_size_of("113個人") is None
