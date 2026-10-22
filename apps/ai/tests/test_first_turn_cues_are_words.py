"""D479 - the first turn's cues: a Latin cue is a WORD, and no cue shadows another table's.

The first turn had its own copy of the matching rule - the loosest one, any substring
will do - so a **bookshop** was a RESERVATION ("book" inside "bookshop") and a **planet**
was a PLAN ("plan" inside "planets").

The Chinese half of the same tables had the mirror defect: the one-character cue U+8A02
("book") sits inside the purchase cue U+8A02 U+8CFC ("order"), and the reserve table is
checked first - so an order was a booking. And the table's own "book a table" cue was
spelled with a variant character (U+8A02 U+67B1) that the product never writes: the
CONTRACT's spelling (U+8A02 U+684C) was read only by the bare cue, so the table's entry
was a promise nobody kept (D477).

This gate takes its parameters from the tables themselves, so the tables grow and the gate
grows with them: every cue must reach its own intent, a Latin cue must not be read out of
the middle of a word, and no cue may sit in two tables or shadow another table's cue.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.matching import cue_in
from nexus_ai.nlu.understand import extract_intent

#: the tables the reader checks, the intent each one means, and the text its cue needs
#: to show that intent (the compare cue needs two things to compare)
TABLES: list[tuple[str, str, str]] = [
    ("COMPARE_CUES", "compare", " ramen and sushi"),
    ("RESERVE_CUES", "reserve", ""),
    ("PURCHASE_CUES", "purchase", ""),
    ("ASK_MERCHANT_CUES", "ask_merchant", ""),
    ("PLAN_CUES", "plan_experience", ""),
    ("DISCOVER_CUES", "discover_merchant", ""),
]

#: the confidence each table's branch gives - the fallback ("discover_merchant" at 0.6)
#: is a different answer from a cue that was read
CONFIDENCE = {"compare": 0.9, "reserve": 0.9, "purchase": 0.85, "ask_merchant": 0.8,
              "plan_experience": 0.8, "discover_merchant": 0.75}


def _cues() -> list[tuple[str, str, str]]:
    """Every cue of every table, with the table it belongs to."""
    out: list[tuple[str, str, str]] = []
    for name, intent, suffix in TABLES:
        for cue in getattr(L, name):
            out.append((name, cue, suffix))
    return out


def _latin_cues() -> list[tuple[str, str, str]]:
    return [row for row in _cues() if row[1].isascii()]


def _signature(text: str) -> tuple:
    """What the first turn made of a text - the intent and how sure it is."""
    intent = extract_intent(text, {})
    return (intent.intent, intent.confidence.get("intent"))


def test_the_tables_are_readable():
    """The gate reads the tables out of the module - a renamed table changes what it sees."""
    for name, _, _ in TABLES:
        assert hasattr(L, name), (
            f"the lexicon has no {name} - the gate reads the tables out of the module, so a "
            f"renamed table changes what the gate can see")


@pytest.mark.parametrize("name,cue,suffix", _cues())
def test_every_cue_reaches_its_own_intent(name: str, cue: str, suffix: str):
    """A table's entry is a promise - the reader must act on it."""
    the_intent = _intent_of(name)
    assert _signature(cue + suffix) == (the_intent, CONFIDENCE[the_intent]), (
        f"{name}'s cue {cue.encode('unicode_escape').decode()!r} did not reach "
        f"{the_intent!r} - a table's entries are promises, and a promise nobody exercises "
        f"is a promise nobody keeps")


@pytest.mark.parametrize("name,cue,suffix", _latin_cues())
def test_a_latin_cue_is_not_read_out_of_the_middle_of_a_word(
        name: str, cue: str, suffix: str):
    """A letter glued to the cue's left must take the cue out of the text.

    This asks the ONE matcher, not the intent: another cue of the same table may still
    match the text (\"xmake a table\" still holds the cue \"a table\"), so the intent
    cannot tell which cue was read.
    """
    glued = "x" + cue
    assert not cue_in(cue, glued, glued.lower()), (
        f"{name}'s cue {cue!r} was read out of the middle of a word - \"book\" inside "
        f"\"bookshop\" gave the query a reservation")
    assert cue_in(cue, cue, cue.lower()), (
        f"{name}'s cue {cue!r} does not match itself - a table's entry is a promise")


def _intent_of(name: str) -> str:
    for table, intent, _ in TABLES:
        if table == name:
            return intent
    raise AssertionError(f"unknown table {name}")


def test_the_matcher_reads_a_latin_cue_as_a_word():
    """The ONE matcher - a Latin cue is a word (D478)."""
    assert not cue_in("book", "bookshop", "bookshop"), (
        "'book' matched inside 'bookshop' - a Latin cue must match on a word boundary")
    assert cue_in("book", "book a table", "book a table")
    assert cue_in("book", "books", "books")
    assert cue_in("which", "which ramen and sushi", "which ramen and sushi")


def test_no_cue_sits_in_two_tables():
    """The same word in two tables is unreachable in the second one."""
    seen: dict[str, str] = {}
    for name, _, _ in TABLES:
        for cue in getattr(L, name):
            if cue in seen and seen[cue] != name:
                pytest.fail(
                    f"the cue {cue.encode('unicode_escape').decode()!r} sits in both "
                    f"{seen[cue]} and {name} - the reader checks one table first, so the "
                    f"other is unreachable")
            seen[cue] = name


def test_no_cue_shadows_another_tables_cue():
    """A cue that sits inside another table's cue makes that cue unreachable."""
    for first, _, _ in TABLES:
        for cue in getattr(L, first):
            for second, _, _ in TABLES:
                if second == first:
                    continue
                for other in getattr(L, second):
                    if cue != other and cue in other:
                        pytest.fail(
                            f"{first}'s cue {cue.encode('unicode_escape').decode()!r} sits "
                            f"inside {second}'s {other.encode('unicode_escape').decode()!r} "
                            f"- the reader checks {first} first, so {second}'s cue can "
                            f"never be reached")


def test_a_bookshop_is_not_a_reservation():
    """The measured instances."""
    assert _signature("bookshop in sha tin")[0] != "reserve", (
        "'bookshop' was read as a reservation - 'book' inside 'bookshop'")
    assert _signature("notebook cafe")[0] != "reserve"
    assert _signature("planets cafe")[0] != "plan_experience"
    assert _signature("airplane restaurant")[0] != "plan_experience"


def test_an_order_is_not_a_booking():
    """The Chinese shadowing: the bare U+8A02 sat inside the purchase cue."""
    order = "\u8a02\u8cfc"      # 購 - the Traditional "order"
    assert _signature(order)[0] == "purchase", (
        f"the purchase cue {order.encode('unicode_escape').decode()!r} was read as a "
        f"booking - the one-character reserve cue sat inside it")


def test_the_contract_s_own_spelling_is_read():
    """The table held a variant character the product never writes."""
    contract = "\u8a02\u684c"    # the spelling the eval's own case uses
    assert _signature(contract)[0] == "reserve", (
        f"the contract's own spelling {contract.encode('unicode_escape').decode()!r} is "
        f"not read - the table held a variant character instead")
