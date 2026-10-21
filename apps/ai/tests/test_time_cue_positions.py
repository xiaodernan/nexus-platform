"""D475 - a direction cue reads in BOTH positions, in every language the table holds.

D463 made the "before" cue mean something - the parser reads `EARLY_CUES`, the plan carries
it, the search filters on it - and the gate checked each layer with the CHINESE order, the
one the cue table was written in. Two defects lived in the gap:

  * the window around the clock was 6 characters - one short of the longest cue (`before`
    plus the space that separates it from the clock) - so "before 7pm" was read as a plain
    clock time;
  * only the EARLY cue was read on both sides of the clock, so the English word order (the
    cue BEFORE the clock: "after 7pm") was never seen, while the Chinese order (the cue
    after it) was.

The English and the Chinese said the same thing and got different answers - which is the
worst kind of drift, because it hides in the language nobody tested.

This gate reads the cue tables themselves and requires EVERY cue, in EVERY language they
are written in, to be read on BOTH sides of the clock. The strings are composed from the
tables, so no CJK code point is typed by hand (D409, D446).
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import timeparse as T
from nexus_ai.nlu.numerals import CN_DIGITS

#: the numeral for seven and the hour marker, from the product's own tables
SEVEN = next(ch for ch, value in CN_DIGITS.items() if value == 7)
HOUR = "\u9ede"  # the marker the time parser itself names (U+9EDE, per its comment)

EARLY_QUALITY = "before:"
LATE_QUALITY = "open_late_after:"


def _clock(hour: str = "7", meridiem: str = "") -> str:
    return hour + meridiem


@pytest.mark.parametrize("cue", [c for c in T.EARLY_CUES if c.isascii()])
def test_every_english_early_cue_reads_on_both_sides(cue: str):
    before = T.parse_time(f"{cue} {_clock('7', 'pm')}")
    after = T.parse_time(f"{_clock('7', 'pm')} {cue}")
    for parsed, where in ((before, "before the clock"), (after, "after the clock")):
        assert parsed is not None, f"{cue!r} {where}: the time was not read at all"
        assert parsed.quality is not None and parsed.quality.startswith(EARLY_QUALITY), (
            f"{cue!r} {where}: the cue was not read - the quality is {parsed.quality!r}")


@pytest.mark.parametrize("cue", [c for c in T.LATE_CUES if c.isascii()])
def test_every_english_late_cue_reads_on_both_sides(cue: str):
    before = T.parse_time(f"{cue} {_clock('7', 'pm')}")
    after = T.parse_time(f"{_clock('7', 'pm')} {cue}")
    for parsed, where in ((before, "before the clock"), (after, "after the clock")):
        assert parsed is not None, f"{cue!r} {where}: the time was not read at all"
        assert parsed.quality is not None and parsed.quality.startswith(LATE_QUALITY), (
            f"{cue!r} {where}: the cue was not read - the quality is {parsed.quality!r}")


@pytest.mark.parametrize("cue", [c for c in T.EARLY_CUES if not c.isascii()])
def test_every_cjk_early_cue_reads_on_both_sides(cue: str):
    before = T.parse_time(f"{cue}{SEVEN}{HOUR}")
    after = T.parse_time(f"{SEVEN}{HOUR}{cue}")
    for parsed, where in ((before, "before the clock"), (after, "after the clock")):
        assert parsed is not None, f"{cue!r} {where}: the time was not read at all"
        assert parsed.quality is not None and parsed.quality.startswith(EARLY_QUALITY), (
            f"{cue!r} {where}: the cue was not read - the quality is {parsed.quality!r}")


@pytest.mark.parametrize("cue", [c for c in T.LATE_CUES if not c.isascii()])
def test_every_cjk_late_cue_reads_on_both_sides(cue: str):
    before = T.parse_time(f"{cue}{SEVEN}{HOUR}")
    after = T.parse_time(f"{SEVEN}{HOUR}{cue}")
    for parsed, where in ((before, "before the clock"), (after, "after the clock")):
        assert parsed is not None, f"{cue!r} {where}: the time was not read at all"
        assert parsed.quality is not None and parsed.quality.startswith(LATE_QUALITY), (
            f"{cue!r} {where}: the cue was not read - the quality is {parsed.quality!r}")


def test_the_window_is_wide_enough_for_the_longest_cue():
    longest = max(len(cue) for cue in T.EARLY_CUES + T.LATE_CUES)
    assert T._CUE_WINDOW >= longest + 1, (
        f"the window around the clock is {T._CUE_WINDOW} characters, and the longest cue is "
        f"{longest} - a cue that does not fit in the window can never be read, which is how "
        f"the English 'before 7pm' was answered as a plain clock time")


def test_the_cue_reads_the_same_way_on_both_sides():
    """The same cue and the same clock must read the same, whichever side it sits on."""
    for text_before, text_after in (
            ("before 7pm", "7pm before"),
            ("after 7pm", "7pm after"),
            (f"{SEVEN}{HOUR}{T.EARLY_CUES[0]}", f"{SEVEN}{HOUR}{T.EARLY_CUES[0]}")):
        before = T.parse_time(text_before)
        after = T.parse_time(text_after)
        assert before is not None and after is not None
        assert before.quality == after.quality, (
            f"{text_before!r} and {text_after!r} read differently: {before.quality!r} and "
            f"{after.quality!r} - the same request must get the same answer")


def test_the_two_languages_agree():
    """The English and the Chinese say the same thing, so both must be directions."""
    english = T.parse_time("before 7pm")
    chinese = T.parse_time(f"{SEVEN}{HOUR}{T.EARLY_CUES[0]}")
    assert english is not None and chinese is not None
    assert english.quality is not None and english.quality.startswith(EARLY_QUALITY), (
        f"the English 'before 7pm' is not a direction: {english.quality!r}")
    assert chinese.quality is not None and chinese.quality.startswith(EARLY_QUALITY), (
        f"the Chinese before-cue is not a direction: {chinese.quality!r}")
