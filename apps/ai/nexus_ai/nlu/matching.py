"""The one rule for reading a cue out of a text.

D478 gave the time parser a rule of its own - a Latin marker is a WORD - and D476 gave
the state merger a near-copy of it. The first turn kept a third copy, the loosest one:
any substring will do. So the same product read three cues three ways, and each copy
failed on its own:

  * the first turn's copy read "book" inside "bookshop" - a bookshop is a RESERVATION;
  * the first turn's copy read "am" inside "ramen" - no, that one was the time parser's
    (D478) - and "past" inside "pastry" - a PASTRY is "open late after".

One rule, one place:

  * a **Latin cue is a word** - no letter may touch it ("7am" is a cue, "ramen" is not),
    and only a plural may follow it ("weekends" is "weekend");
  * a **CJK cue** has no word boundaries and matches on its own spelling;
  * and when several cues match, the **longest** one wins - a short cue must not shadow
    a longer one (D476).

The tables are the vocabulary; this is the grammar. The two must not drift apart, so the
gates take their parameters from the tables (D477).
"""

from __future__ import annotations

import re
from collections.abc import Iterable

__all__ = ["cue_positions", "cue_in", "longest_cue"]


def cue_positions(cue: str, text: str, low: str) -> list[int]:
    """Where a cue reads in the text - every place it is found.

    `text` is the canonical spelling and `low` its lowercase form; a Latin cue is read
    out of `low` and a CJK cue out of `text`.
    """
    if cue.isascii():
        # D538: a space inside the cue reads as ANY whitespace, so a cue whose own words
        # the user punctuated - "make a, table" - still reads across the clause separator
        # the normalizer writes where the comma was.
        words = r"\s".join(re.escape(w) for w in re.split(r"\s+", cue.lower()))
        pattern = rf"(?<![a-z]){words}(?:es|s)?(?![a-z])"
        return [m.start() for m in re.finditer(pattern, low)]
    return [m.start() for m in re.finditer(re.escape(cue), text)]


def cue_in(cue: str, text: str, low: str) -> bool:
    """Whether a cue is in the text."""
    return bool(cue_positions(cue, text, low))


def longest_cue(text: str, low: str, cues: Iterable[str]) -> str | None:
    """The longest cue in the text, or None. The longest wins, so a cue that contains
    another one cannot be shadowed by it."""
    best: str | None = None
    for cue in cues:
        if not cue_in(cue, text, low):
            continue
        if best is None or len(cue) > len(best):
            best = cue
    return best
