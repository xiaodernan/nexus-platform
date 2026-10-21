"""D463 - a direction the user says is a direction the product keeps.

The time parser has three direction tables: `LATE_CUES` (after), `OPEN_LATE_CUES` (open
late) and `EARLY_CUES` (before / up to / within). The first was dead - the function that
reads the direction had its own hard-coded list, so the table was a second copy nobody
read, and the two copies disagreed - and the last was dead too: "seven o'clock, before"
was read as "seven o'clock", and the user's "before" was dropped without a word.

Now the "before" means what the "after" means: the parser says `before:HHMM`, the plan
carries it, the service turns it into a filter, and the search asks for the merchants whose
OPENING hour is at or before the hour the user named - the mirror of the "open late after"
filter, which asks for a CLOSING hour at or after it.

The strings are composed from the product's OWN tables (the cue lists and the numeral
table), so no CJK code point is typed by hand: the writer's memory of a code point is not
a reference (D409, D446).
"""

from __future__ import annotations

from nexus_ai.nlu import timeparse as T
from nexus_ai.nlu.numerals import CN_DIGITS

#: the numeral for seven and the hour marker, from the product's own tables
SEVEN = next(ch for ch, value in CN_DIGITS.items() if value == 7)
HOUR = "\u9ede"  # the marker the time parser itself names (U+9EDE, per its comment)
BEFORE = T.EARLY_CUES[0]
AFTER = T.LATE_CUES[0]
UP_TO = "up to"


def _parse(text: str):
    return T.parse_time(text)


def test_the_before_cue_is_read_at_all():
    # the defect: this used to be read as a plain "seven o'clock" - the cue was a table
    # nobody read, so the user's "before" was dropped
    parsed = _parse(SEVEN + HOUR + BEFORE)
    assert parsed is not None, "the time was not read at all"
    assert parsed.type == "relative", (
        f"the 'before' cue was dropped: the parse is {parsed.type!r} with the quality "
        f"{parsed.quality!r} - the user said 'before' and the product did not hear it")
    assert parsed.quality == "before:0700", parsed.quality


def test_the_before_cue_may_sit_on_either_side_of_the_clock():
    after = _parse(SEVEN + HOUR + BEFORE)
    before = _parse(BEFORE + SEVEN + HOUR)
    assert after is not None and before is not None
    assert after.quality == before.quality == "before:0700", (
        f"{after.quality!r} and {before.quality!r} - the cue means the same thing on "
        f"either side of the clock")


def test_the_up_to_cue_is_read_too():
    parsed = _parse(SEVEN + HOUR + " " + UP_TO)
    assert parsed is not None
    assert parsed.quality == "before:0700", parsed.quality


def test_the_after_cue_still_means_what_it_meant():
    parsed = _parse(SEVEN + HOUR + AFTER)
    assert parsed is not None
    assert parsed.quality == "open_late_after:0700", parsed.quality


def test_a_plain_time_is_still_a_window():
    parsed = _parse(SEVEN + HOUR)
    assert parsed is not None
    assert parsed.type == "explicit", parsed.type
    assert parsed.starts_at is not None and parsed.ends_at is not None


def test_the_plan_carries_the_direction_into_the_search_filters():
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.nlu.understand import extract_intent_dict
    from nexus_ai.search.service import plan_from_intent

    # the same path the search takes: the rules fill the intent, the contract validates it
    intent = validate_intent(extract_intent_dict(SEVEN + HOUR + BEFORE, {"locale": "zh-HK"}))
    plan = plan_from_intent(intent)
    assert plan.open_early_before == 7, (
        f"the plan carries {plan.open_early_before!r} - the direction never reached it")
    assert plan.filters.get("max_opening_hour") == 7, plan.filters


def test_the_open_late_filter_asks_for_the_HOUR_and_not_the_hhmms():
    # D463: the quality carries HHMM ("open_late_after:1000") and the filter's SQL is
    # `(X::int * interval '1 hour')::time` - so X has to be the HOUR. 1000 hours is 41
    # days, and the time part of that interval is four in the afternoon: the "open late
    # after ten" filter was asking the database for a closing hour of 16:00.
    from nexus_ai.api.pipeline import validate_intent
    from nexus_ai.nlu.understand import extract_intent_dict
    from nexus_ai.search.service import plan_from_intent

    intent = validate_intent(extract_intent_dict(SEVEN + HOUR + AFTER, {"locale": "zh-HK"}))
    plan = plan_from_intent(intent)
    assert plan.open_late_after == 7, (
        f"the plan carries {plan.open_late_after!r} - the filter's SQL wants the hour")
    assert plan.filters.get("min_closing_hour") == 7, plan.filters


def test_the_search_filter_is_the_mirror_of_the_open_late_one():
    # the SQL asks for a merchant whose OPENING hour is at or before the hour named, the
    # mirror of the one that asks for a CLOSING hour at or after it
    from nexus_ai.search.sql import build_merchant_query

    built = build_merchant_query(
        tenant_id="11111111-1111-1111-1111-111111111111",
        text=None, embedding=None,
        filters={"max_opening_hour": 7})
    sql = built.sql if hasattr(built, "sql") else built[0]
    params = built.params if hasattr(built, "params") else built[1]
    assert "opens_at <=" in sql, sql[:600]
    assert 7 in params, params
