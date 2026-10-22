"""D477 - every weekday the table names is readable, and the day after tomorrow is two days out.

Two defects, both invisible in Chinese:

  * the weekday reader's ASCII branch had the word boundary written as a LITERAL BACKSPACE
    byte (0x08) instead of the two characters `\\b`. The regex searched for a backspace
    around the weekday name and never matched, so **every English weekday was unreadable**
    - "monday", "next friday", "mon" all resolved to nothing - while the Chinese worked.
    The comment above the line says what it was meant to be: "3-letter abbreviations must
    be whole words: 'sunset' is not Sunday".

  * the day after tomorrow was resolved to TOMORROW: the branch that picks the day added
    one day for `is_tomorrow or is_after_tomorrow`, so "the day after tomorrow" and the
    Chinese landed on tomorrow - and the English phrase also matched the "tomorrow"
    inside itself, so it took the same branch. The day after tomorrow is two days out.

This gate reads the tables themselves, and it also checks the SOURCE for the class of
defect: a control byte where a regex escape belongs is invisible in a diff and fatal in a
matcher.
"""

from __future__ import annotations

import datetime

import pytest

from nexus_ai.nlu import timeparse as T

HK = T.HK_TZ
NOW = datetime.datetime(2026, 10, 22, 9, 0, tzinfo=HK)  # a Thursday

#: the control characters a source file may carry: the tab, the newline, the carriage
#: return - and nothing else. A backspace where a regex escape belongs is invisible in a
#: diff and fatal in a matcher.
ALLOWED_CONTROL = {9, 10, 13}


def _source_files() -> list:
    from pathlib import Path

    return sorted(Path(T.__file__).parent.parent.rglob("*.py"))


def test_no_source_file_carries_a_control_byte():
    offenders = []
    for path in _source_files():
        data = path.read_bytes()
        for number, line in enumerate(data.split(b"\n"), 1):
            bad = {b for b in line if b < 32 and b not in ALLOWED_CONTROL}
            if bad:
                offenders.append(f"{path.name}:{number} {sorted(bad)}")
    assert not offenders, (
        "these source lines carry a control character that is not a tab, a newline or a "
        "carriage return: " + "; ".join(offenders) + " - a byte where an escape belongs is "
        "invisible in a diff and fatal in a matcher")


@pytest.mark.parametrize("token", sorted(t for t in T.WEEKDAY_TOKENS if t.isascii()))
def test_every_english_weekday_token_is_readable(token: str):
    found = T._find_weekday(token)
    assert found is not None, (
        f"the weekday table names {token!r} and the reader cannot find it - the table's "
        f"entries are promises, and a name nothing reads is a promise nobody keeps")
    assert found[0] == T.WEEKDAY_TOKENS[token]


def test_the_english_weekdays_resolve_to_a_day():
    for token in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
                  "sunday"):
        parsed = T.parse_time(token, NOW)
        assert parsed is not None, f"the English weekday {token!r} resolved to nothing"
        assert parsed.starts_at is not None


def test_an_abbreviation_must_be_a_whole_word():
    """'sunset' is not Sunday - and the boundary has to be a real one."""
    assert T._find_weekday("sunset") is None, (
        "'sunset' was read as Sunday - the three-letter abbreviations must be whole words")
    assert T._find_weekday("sun") is not None
    assert T._find_weekday("sunday") is not None


def test_the_day_after_tomorrow_is_two_days_out():
    for token in T.AFTER_TOMORROW_TOKENS:
        parsed = T.parse_time(token, NOW)
        assert parsed is not None, f"the day after tomorrow {token!r} resolved to nothing"
        assert parsed.starts_at is not None
        assert parsed.starts_at.date() == NOW.date() + datetime.timedelta(days=2), (
            f"the day after tomorrow {token!r} landed on {parsed.starts_at.date()} - the day "
            f"after tomorrow is {NOW.date() + datetime.timedelta(days=2)}")


def test_tomorrow_is_one_day_out():
    for token in T.TOMORROW_TOKENS:
        parsed = T.parse_time(token, NOW)
        assert parsed is not None, f"tomorrow {token!r} resolved to nothing"
        assert parsed.starts_at is not None
        assert parsed.starts_at.date() == NOW.date() + datetime.timedelta(days=1), (
            f"tomorrow {token!r} landed on {parsed.starts_at.date()}")


def test_the_two_languages_agree_about_the_weekday():
    """The English and the Chinese name the same day, so they must land on the same day."""
    english = T.parse_time("monday", NOW)
    chinese = T.parse_time("星期一", NOW)
    assert english is not None and chinese is not None
    assert english.starts_at.date() == chinese.starts_at.date(), (
        f"the English and the Chinese Monday are different days: {english.starts_at} and "
        f"{chinese.starts_at}")
