"""D478 - a marker is a WORD, not a piece of a word.

Every marker in the time parser's tables was matched as a bare substring, so a word that
CONTAINED a marker read as the marker:

    "am"   inside "ramen"      -> the query got the MORNING window (07:00-11:30)
    "now"  inside "know"       -> the query was read as TODAY
    "past" inside "pastry"     -> the query was read as "open late after"

The Chinese half of the same tables was never affected - Chinese has no word inside a
word - so the Chinese "ramen" got no time filter and the English one got a morning one.
The live answer showed it: "ramen in sha tin" returned **3** merchants and "coffee in sha
tin" returned **9**, for a reason the user never said.

This gate takes its parameters from the tables themselves, so the tables grow and the
gate grows with them: every marker must read as a word, and no marker may read out of
the middle of a word. The CJK markers must keep reading - the fix must not cost the
Chinese anything.
"""

from __future__ import annotations

import datetime

import pytest

from nexus_ai.nlu import timeparse as T

HK = T.HK_TZ
NOW = datetime.datetime(2026, 10, 22, 9, 0, tzinfo=HK)  # a Thursday

#: the tables the parser reads, and the context each one needs to show its effect
TABLES: list[tuple[str, str]] = [
    ("TODAY_TOKENS", ""),
    ("TONIGHT_TOKENS", ""),
    ("TOMORROW_TOKENS", ""),
    ("AFTER_TOMORROW_TOKENS", ""),
    ("WEEKEND_TOKENS", ""),
    ("NEXT_WEEK_TOKENS", "monday "),
    # the open-late cues act on an HOUR - "still open" with no hour is no filter at all,
    # so the context carries one
    ("OPEN_LATE_CUES", "11pm "),
    ("EARLY_CUES", "7pm "),
    ("LATE_CUES", "7pm "),
]


def _part_of_day_markers() -> list[tuple[str, str, str]]:
    """The part-of-day rows and their markers."""
    out: list[tuple[str, str, str]] = []
    for label, tokens, _, _ in T.PART_OF_DAY:
        for tok in tokens:
            out.append((f"PART_OF_DAY[{label}]", tok, ""))
    return out


def _table_markers() -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    for name, context in TABLES:
        for tok in getattr(T, name):
            out.append((name, tok, context))
    return out


def _latin_markers() -> list[tuple[str, str, str]]:
    return [row for row in _part_of_day_markers() + _table_markers() if row[1].isascii()]


def _cjk_markers() -> list[tuple[str, str, str]]:
    return [row for row in _part_of_day_markers() + _table_markers() if not row[1].isascii()]


def _signature(text: str) -> tuple | None:
    """What the parser made of a text - the quality and the day, or nothing."""
    parsed = T.parse_time(text, NOW)
    if parsed is None:
        return None
    return (parsed.quality, parsed.starts_at.date() if parsed.starts_at else None)


def test_the_tables_are_readable():
    """The gate reads the tables out of the module - a renamed table changes what it sees."""
    for name, _ in TABLES:
        assert hasattr(T, name), (
            f"the time parser has no {name} - the gate reads the tables out of the module, "
            f"so a renamed table changes what the gate can see")
    assert T.PART_OF_DAY, "the time parser has no part-of-day table"


@pytest.mark.parametrize("table,marker,context", _latin_markers())
def test_a_latin_marker_reads_as_a_word(table: str, marker: str, context: str):
    """Every Latin marker must be readable - as a word."""
    assert _signature(context + marker) is not None, (
        f"{table}'s marker {marker!r} is not readable at all - a table's entries are "
        f"promises, and a promise nobody exercises is a promise nobody keeps")
    assert _signature(context + marker) != _signature(context), (
        f"{table}'s marker {marker!r} changed nothing - the table names a word the "
        f"parser does not act on")


@pytest.mark.parametrize("table,marker,context", _latin_markers())
def test_a_latin_marker_is_not_read_out_of_the_middle_of_a_word(
        table: str, marker: str, context: str):
    """A letter glued to the marker's left must take the marker out of the text."""
    assert _signature(context + "x" + marker) != _signature(context + marker), (
        f"{table}'s marker {marker!r} was read out of the middle of a word - \"am\" inside "
        f"\"ramen\" gave the query the morning window, and \"now\" inside \"know\" gave it "
        f"today")


@pytest.mark.parametrize("table,marker,context", _cjk_markers())
def test_a_cjk_marker_still_reads(table: str, marker: str, context: str):
    """The fix must not cost the Chinese anything."""
    assert _signature(context + marker) is not None, (
        f"{table}'s marker {marker!r} is not readable - the word rule must not take the "
        f"Chinese markers with it")


@pytest.mark.parametrize("text", ["ramen", "lamb", "programmer cafe", "know", "nowhere",
                                  "snow cone", "camping trip"])
def test_a_word_that_contains_a_marker_carries_no_time(text: str):
    """The measured instances."""
    assert T.parse_time(text, NOW) is None, (
        f"{text!r} carries no time signal, but the parser read one out of a word inside it")


def test_the_cue_is_not_read_out_of_pastry():
    """\"past\" inside \"pastry\" is not a direction."""
    parsed = T.parse_time("pastry 7pm", NOW)
    assert parsed is not None
    assert not (parsed.quality or "").startswith("open_late_after"), (
        f"'pastry' was read as the 'past' cue - the quality is {parsed.quality!r}")


@pytest.mark.parametrize("text", ["midnight", "overnight", "luncheon", "next weekend",
                                  "weekends", "7am", "7pm", "mornings", "today's"])
def test_the_words_the_tables_name_are_still_read(text: str):
    """The fix must not lose what the looser match used to find."""
    assert T.parse_time(text, NOW) is not None, (
        f"{text!r} used to be read and is not any more - a word the product means must be "
        f"named in the table")


def test_the_direction_cues_still_read():
    """D475's finding still holds: the cues read on both sides of the clock."""
    for text in ("before 7pm", "7pm before", "after 7pm", "7pm after"):
        parsed = T.parse_time(text, NOW)
        assert parsed is not None and parsed.quality is not None, (
            f"{text!r} carries no direction any more - the quality is "
            f"{None if parsed is None else parsed.quality!r}")


def _carries_a_time(block: object) -> bool:
    """Whether an intent's time block carries a time signal at all."""
    if not isinstance(block, dict):
        return False
    return any(block.get(key) for key in ("type", "starts_at", "ends_at", "quality"))


def test_a_ramen_query_carries_no_time_filter():
    """The end-to-end proof: the answer the user gets."""
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    with TestClient(create_app(settings)) as client:
        ramen = client.post("/ai/v1/query/understand",
                             json={"query": "ramen in sha tin", "context": {}}).json()
        coffee = client.post("/ai/v1/query/understand",
                              json={"query": "coffee in sha tin", "context": {}}).json()
        morning = client.post("/ai/v1/query/understand",
                              json={"query": "ramen in sha tin morning", "context": {}}).json()
    assert not _carries_a_time(ramen.get("time")), (
        f"'ramen in sha tin' carries a time filter it never said: {ramen.get('time')}")
    assert not _carries_a_time(coffee.get("time")), (
        f"'coffee in sha tin' carries a time filter it never said: {coffee.get('time')}")
    assert (morning.get("time") or {}).get("quality") == "morning", (
        f"'ramen in sha tin morning' lost its morning: {morning.get('time')}")
