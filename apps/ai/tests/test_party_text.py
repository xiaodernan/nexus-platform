"""Contract tests for the party-size reader's normalisation step (``nlu/understand.party_text``).

`party_size_of` is pinned by the party-size tests; this file pins the helper it stands on:
`party_text` rewrites a Chinese numeral to a digit **only when a party counter follows it**
(``_PARTY_MARKERS`` = 個/位/人), so 三個人 and 3個人 are the same party while 星期三 stays a
weekday and a numeral before a non-counter stays put. It also pins the end-to-end guarantee that makes Simplified input
work: the pipeline canonicalises BEFORE it matches, so 四个人 and 两位 are read even though the
numeral table holds only the Traditional spellings.

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.nlu.understand as U


class TestPartyText:
    def test_chinese_numeral_before_a_counter_becomes_a_digit(self):
        assert U.party_text("三個人") == "3個人"
        assert U.party_text("二人") == "2人"

    def test_a_digit_is_left_alone(self):
        assert U.party_text("3個人") == "3個人"

    def test_a_weekday_is_not_a_party(self):
        # 三 is followed by 星, not by a party counter
        assert U.party_text("星期三") == "星期三"

    def test_a_non_counter_suffix_is_left_alone(self):
        # 點 is the hour marker, not a party counter, so the numeral is not rewritten.
        # (The first draft used a pair-counter word the vocabulary does not carry; the
        # vocabulary gate caught it - D409/D446.)
        assert U.party_text("兩點") == "兩點"

    def test_a_compound_numeral_is_read(self):
        assert U.party_text("十三個人") == "13個人"

    def test_the_rest_of_the_sentence_is_untouched(self):
        assert U.party_text("三個人食飯") == "3個人食飯"

    def test_a_counter_after_a_weekday_still_rewrites(self):
        # the rule is the FOLLOWING character, not the word before it
        assert U.party_text("星期三人") == "星期3人"

    def test_empty(self):
        assert U.party_text("") == ""

    def test_the_marker_set_is_the_three_counters(self):
        assert set(U._PARTY_MARKERS) == {"個", "位", "人"}


class TestThePipelineCanonicalisesFirst:
    """The numeral table holds only the Traditional spellings (D435: one spelling per
    character), so Simplified input works only because `extract_intent` canonicalises before
    it matches. These rows are that guarantee, end to end."""

    def test_simplified_party_is_read(self):
        assert U.extract_intent("四个人").party_size == 4

    def test_simplified_counter_is_read(self):
        assert U.extract_intent("两位").party_size == 2

    def test_traditional_and_arabic_agree(self):
        assert U.extract_intent("四個人").party_size == 4
        assert U.extract_intent("2位").party_size == 2

    def test_no_party_is_none(self):
        assert U.extract_intent("你好").party_size is None
