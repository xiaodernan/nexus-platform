"""D446 - the time parser reads the spellings a user writes.

The time parser's cue tables were NOT canonicalised, while the query IS canonicalised
before it reaches them. So their Simplified entries could never match, and the Traditional
spelling they did not carry was not read at all: the Cantonese 禮拜 - the way a Hong Kong
user writes "week" - was in that gap, and "禮拜三" returned NOTHING.

The tables are canonicalised at import now, and the text is canonicalised before it is
read, so the two spellings of a word meet (§429, D435).
"""

from __future__ import annotations

from nexus_ai.nlu.timeparse import WEEKDAY_TOKENS, parse_time

#: 星期 禮拜 礼拜 週 周 三 食飯
#: (U+9031 is 週 and U+908A is 邊 - the code points were checked against the Unicode
#: character database, because a writer's memory of a CJK code point is not a reference.)
WEEK = "\u661f\u671f"
WEEK_CANTONESE = "\u79ae\u62dc"
WEEK_SIMPLIFIED = "\u793c\u62dc"
WEEK_TRADITIONAL = "\u9031"
WEEK_PLAIN = "\u5468"
THREE = "\u4e09"
#: 現在 现在 聽日 明日 週末 周末 下午
NOW_TRADITIONAL = "\u73fe\u5728"
NOW_SIMPLIFIED = "\u73b0\u5728"
TOMORROW_CANTONESE = "\u807d\u65e5"
TOMORROW_PLAIN = "\u660e\u65e5"
WEEKEND_TRADITIONAL = "\u9031\u672b"
WEEKEND_SIMPLIFIED = "\u5468\u672b"
AFTERNOON = "\u4e0b\u5348"

def test_every_weekday_token_in_the_table_reads():
    # the data-driven half: the table's own tokens must all be understood
    for token, weekday in WEEKDAY_TOKENS.items():
        if not any("\u4e00" <= ch <= "\u9fff" for ch in token):
            continue
        parsed = parse_time(token)
        assert parsed is not None and parsed.starts_at is not None, (
            f"the weekday token {token.encode('unicode_escape').decode()} reads as nothing")
        assert parsed.type == "range", (
            f"the weekday token {token.encode('unicode_escape').decode()} did not read as a "
            f"weekday")

def test_the_cantonese_weekday_reads():
    # D446: this one read as NOTHING before - the table held only the Simplified 礼拜, which
    # the canonicalisation had already rewritten away.
    parsed = parse_time(WEEK_CANTONESE + THREE)
    assert parsed is not None and parsed.starts_at is not None, (
        "the Cantonese weekday did not read")
    assert parsed.type == "range"

def test_every_spelling_of_the_weekday_reads_the_same_day():
    days = set()
    for prefix in (WEEK, WEEK_CANTONESE, WEEK_SIMPLIFIED, WEEK_TRADITIONAL, WEEK_PLAIN):
        parsed = parse_time(prefix + THREE)
        assert parsed is not None and parsed.starts_at is not None, (
            f"the weekday {prefix.encode('unicode_escape').decode()} did not read")
        days.add(parsed.starts_at.date())
    assert len(days) == 1, f"the spellings of the weekday read as different days: {days}"

def test_the_day_words_read_in_both_spellings():
    now = parse_time(NOW_TRADITIONAL)
    now_simplified = parse_time(NOW_SIMPLIFIED)
    assert now is not None and now_simplified is not None
    assert now.starts_at == now_simplified.starts_at, (
        "現在 and 现在 read as different moments")

    tomorrow = parse_time(TOMORROW_CANTONESE)
    tomorrow_plain = parse_time(TOMORROW_PLAIN)
    assert tomorrow is not None and tomorrow_plain is not None
    assert tomorrow.starts_at == tomorrow_plain.starts_at, (
        "聽日 and 明日 read as different days")

def test_the_weekend_reads_in_both_spellings():
    traditional = parse_time(WEEKEND_TRADITIONAL)
    simplified = parse_time(WEEKEND_SIMPLIFIED)
    assert traditional is not None and simplified is not None
    assert traditional.starts_at == simplified.starts_at, (
        "週末 and 周末 read as different weekends")

def test_the_part_of_day_reads():
    parsed = parse_time(AFTERNOON)
    assert parsed is not None and parsed.starts_at is not None
    assert parsed.starts_at.hour == 14, "the afternoon did not read as the afternoon"
