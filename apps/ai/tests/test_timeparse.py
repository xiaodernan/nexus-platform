"""§7.1 / §8 — deterministic HK time parsing, and *never guessing* a time.

`nexus_ai.nlu.timeparse.parse_time` turns "周六晚上", "晚上8點", "22:30", "10pm", "週末",
"今晚", "明日", "營業到10點後" into a `ParsedTime`. The §8 rule is explicit: when the query
carries no time signal at all it returns `None` — it must never invent a date. This pins
the contract with a fixed reference "now" so every assertion is deterministic. DB-free,
no provider.
"""

from __future__ import annotations

from datetime import date, datetime

from nexus_ai.nlu.timeparse import HK_TZ, parse_time

# Monday 2024-01-01 10:00 HKT — a fixed reference so "future" / roll logic is deterministic
NOW = datetime(2024, 1, 1, 10, 0, tzinfo=HK_TZ)


def test_no_time_signal_returns_none():
    assert parse_time("推薦一家餐延", now=NOW) is None  # §8: never invent a time


def test_explicit_clock_with_passed_hour_rolls_to_tomorrow():
    # said at 10:00, a 07:00 that already passed reads as tomorrow
    r = parse_time("7點", now=NOW)
    assert r.type == "explicit"
    assert r.starts_at == datetime(2024, 1, 2, 7, 0, tzinfo=HK_TZ)


def test_evening_clock_applies_pm_via_part_of_day():
    r = parse_time("晚上8點", now=NOW)
    assert r.type == "explicit"
    assert r.starts_at == datetime(2024, 1, 1, 20, 0, tzinfo=HK_TZ)
    assert r.quality == "night"


def test_24h_clock():
    r = parse_time("22:30", now=NOW)
    assert r.type == "explicit"
    assert r.starts_at == datetime(2024, 1, 1, 22, 30, tzinfo=HK_TZ)


def test_pm_clock():
    r = parse_time("10pm", now=NOW)
    assert r.type == "explicit"
    assert r.starts_at == datetime(2024, 1, 1, 22, 0, tzinfo=HK_TZ)


def test_weekday_evening_resolves_next_occurrence():
    # Monday reference -> next Saturday is 2024-01-06
    r = parse_time("周六晚上", now=NOW)
    assert r.type == "range"
    assert r.starts_at.date() == date(2024, 1, 6)
    assert r.quality == "night"


def test_weekend_span():
    r = parse_time("週末", now=NOW)
    assert r.type == "range"
    assert r.quality == "weekend"
    assert r.starts_at.date() == date(2024, 1, 6)  # Saturday


def test_tonight_is_today_evening_window():
    r = parse_time("今晚", now=NOW)
    assert r.type == "range"
    assert r.starts_at == datetime(2024, 1, 1, 18, 0, tzinfo=HK_TZ)


def test_tomorrow_is_bare_all_day():
    r = parse_time("明日", now=NOW)
    assert r.type == "range"
    assert r.starts_at.date() == date(2024, 1, 2)
    assert r.quality == "all_day"


def test_open_late_after_is_a_recurring_quality_not_a_date():
    # "營業到10點後" -> a recurring closing-time filter, no pinned start/end
    r = parse_time("營業到10點後", now=NOW)
    assert r.type == "relative"
    assert r.starts_at is None and r.ends_at is None
    assert r.quality == "open_late_after:1000"


def test_to_intent_dict_emits_zulu_timestamps_and_nulls():
    r = parse_time("22:30", now=NOW)
    d = r.to_intent_dict()
    assert d["starts_at"].endswith("Z") and "T" in d["starts_at"]
    rel = parse_time("營業到10點後", now=NOW)
    assert rel.to_intent_dict()["starts_at"] is None
    assert rel.to_intent_dict()["ends_at"] is None
