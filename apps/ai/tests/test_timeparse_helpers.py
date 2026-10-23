"""Contract tests for the time parser's two pure helpers (``nlu/timeparse``).

`parse_time` is pinned end-to-end by D346; this file pins the helpers it is built from:
`clock_match` (the clock in a text, with Chinese numerals read as digits and the weekday left
alone) and `resolve_weekday` (the next occurrence of a weekday, with an optional +7 days).

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

from datetime import date

import nexus_ai.nlu.timeparse as T

MONDAY = date(2026, 1, 5)  # a Monday (weekday 0)


class TestClockMatch:
    def test_hour_marker_form(self):
        m = T.clock_match("9點")
        assert m is not None
        assert m.group(0) == "9點"
        assert m.group(3) == "9"

    def test_chinese_numeral_is_read_as_a_digit(self):
        # 九點 and 9點 are the same hour
        m = T.clock_match("九點")
        assert m is not None
        assert m.group(0) == "9點"

    def test_colon_form(self):
        m = T.clock_match("9:30")
        assert m is not None
        assert (m.group(1), m.group(2)) == ("9", "30")

    def test_meridiem_form(self):
        m = T.clock_match("10pm")
        assert m is not None
        assert (m.group(5), m.group(6)) == ("10", "pm")

    def test_meridiem_is_outside_the_colon_match(self):
        # the colon form stops at the minutes; "pm" is read by the caller
        m = T.clock_match("7:30pm")
        assert m is not None
        assert m.group(0) == "7:30"

    def test_a_weekday_is_not_a_clock(self):
        # the numeral rewrite is restricted to an hour marker, so 星期三 stays a weekday
        assert T.clock_match("星期三") is None

    def test_empty_is_none(self):
        assert T.clock_match("") is None

    def test_clock_inside_a_sentence(self):
        m = T.clock_match("今晚8點")
        assert m is not None
        assert m.group(3) == "8"


class TestResolveWeekday:
    def test_forward_to_the_target(self):
        assert T.resolve_weekday(2, MONDAY) == date(2026, 1, 7)

    def test_today_counts_as_the_next_occurrence(self):
        assert T.resolve_weekday(0, MONDAY) == MONDAY

    def test_sunday_later_in_the_same_week(self):
        assert T.resolve_weekday(6, MONDAY) == date(2026, 1, 11)

    def test_next_week_adds_seven_days(self):
        assert T.resolve_weekday(0, MONDAY, next_week=True) == date(2026, 1, 12)

    def test_next_week_also_applies_to_a_later_day(self):
        assert T.resolve_weekday(2, MONDAY, next_week=True) == date(2026, 1, 14)
