"""Contract tests for the one cue-reading rule (``nlu/matching``, D476/D478).

The product read the same cue three ways (first turn, time parser, state merger), and each copy
failed differently: "book" inside "bookshop" made a shop a reservation, "past" inside "pastry"
made a pastry "open late after". This module is the one rule:

  * a **Latin cue is a word** — no letter may touch it ("7am" is a cue, "ramen" is not), and only
    a plural may follow ("weekends" is "weekend");
  * a **CJK cue** has no word boundaries and matches on its own spelling;
  * when several cues match, the **longest** wins (a short cue must not shadow a longer one).

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.nlu.matching as M


def _pos(cue: str, text: str) -> list[int]:
    return M.cue_positions(cue, text, text.lower())


class TestLatinCueIsAWord:
    def test_exact_word_matches_at_zero(self):
        assert _pos("book", "book a table") == [0]

    def test_letter_after_the_cue_blocks_it(self):
        # "bookshop" / "booking" merely contain the letters
        assert _pos("book", "bookshop") == []
        assert _pos("book", "booking") == []

    def test_letter_before_the_cue_blocks_it(self):
        # "am" inside "ramen" is not the cue
        assert _pos("am", "ramen") == []

    def test_plural_is_allowed(self):
        assert _pos("book", "books") == [0]
        assert _pos("weekend", "weekends") == [0]

    def test_a_digit_may_touch_the_cue(self):
        # "7am" is a cue; only a LETTER may not touch it
        assert _pos("am", "7am") == [1]

    def test_trailing_letters_block_it(self):
        assert _pos("past", "pastry") == []

    def test_every_occurrence_is_reported(self):
        assert _pos("book", "book a book") == [0, 7]


class TestCjkCueMatchesBySpelling:
    def test_substring_position(self):
        assert _pos("安靜", "好安靜") == [1]

    def test_no_word_boundaries(self):
        # a CJK cue has no boundaries: it matches inside a longer run
        assert _pos("安靜", "不安靜") == [1]

    def test_absent_cue(self):
        assert _pos("安靜", "好熱鬧") == []


class TestCueIn:
    def test_true_and_false(self):
        assert M.cue_in("book", "book a table", "book a table") is True
        assert M.cue_in("book", "bookshop", "bookshop") is False


class TestLongestCue:
    def test_longest_wins(self):
        # both match "books"; the longer cue must win
        assert M.longest_cue("books", "books", ["book", "books"]) == "books"

    def test_short_cue_does_not_shadow_a_longer_one(self):
        assert M.longest_cue("7am", "7am", ["am", "7am"]) == "7am"

    def test_no_match_is_none(self):
        assert M.longest_cue("xyz", "xyz", ["book", "weekend"]) is None

    def test_a_non_matching_plural_is_none(self):
        assert M.longest_cue("weekdays", "weekdays", ["weekend"]) is None
