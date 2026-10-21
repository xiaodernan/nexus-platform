"""Deterministic HK time parser (API_CONTRACT §7.1 `time`, spec §111-112).

Covers the shapes the product actually sees: "周六晚上", "晚上10點後", "週末", "今晚",
"明日下晝3點半", "10pm", "22:00", "weekend", "Saturday evening", "after 7pm".

Timezone is fixed to Asia/Hong_Kong. HK has had no DST since 1979, so a constant +08:00
offset is used instead of `zoneinfo` — that keeps the parser working on machines without
the tzdata package (Windows CI) and is documented in AGENT_CONTRACT §12.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from nexus_ai.nlu.canonical import canonical

HK_TZ = timezone(timedelta(hours=8), "Asia/Hong_Kong")

# python weekday(): Mon=0 .. Sun=6
#: characters that follow 星期/礼拜/週/周
WEEKDAY_SUFFIX: dict[str, int] = {
    "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6,
}

#: standalone weekday tokens (CJK prefix forms + english names). Bare digits are NOT
#: here on purpose: "一個人" must not read as Monday.
WEEKDAY_TOKENS: dict[str, int] = {
    "星期一": 0, "星期二": 1, "星期三": 2, "星期四": 3, "星期五": 4, "星期六": 5,
    "星期日": 6, "星期天": 6, "礼拜一": 0, "礼拜二": 1, "礼拜三": 2, "礼拜四": 3,
    "礼拜五": 4, "礼拜六": 5, "礼拜天": 6, "礼拜日": 6,
    "週一": 0, "週二": 1, "週三": 2, "週四": 3, "週五": 4, "週六": 5, "週日": 6, "週天": 6,
    "周一": 0, "周二": 1, "周三": 2, "周四": 3, "周五": 4, "周六": 5, "周日": 6, "周天": 6,
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4,
    "saturday": 5, "sunday": 6,
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}

#: part-of-day windows in local HK time, (start, end, canonical label)
PART_OF_DAY: list[tuple[str, tuple[str, ...], time, time]] = [
    ("morning", ("朝早", "早上", "上午", "清晨", "早晨", "morning", "am"), time(7, 0), time(11, 30)),
    ("noon", ("中午", "正午", "午市", "lunch", "noon", "midday"), time(11, 30), time(14, 30)),
    ("afternoon", ("下晝", "下午", "午後", "afternoon", "pm"), time(14, 0), time(18, 0)),
    ("evening", ("傍晚", "黃昏", "黄昏", "evening", "dusk"), time(17, 0), time(19, 30)),
    ("night", ("夜晚", "晚間", "晚间", "晚上", "晚黑", "夜間", "夜间", "深夜", "宵夜", "今晚",
               "今夜", "tonight", "night", "evening"), time(18, 0), time(23, 0)),
]

WEEKEND_TOKENS = ("週末", "周末", "weekend", "打side", "兩日", "双休")
TODAY_TOKENS = ("今日", "今天", "日頭", "today", "而家", "家下", "現在", "现在", "now")
TONIGHT_TOKENS = ("今晚", "今齊", "tonight", "今期")
TOMORROW_TOKENS = ("聽日", "听日", "明日", "明天", "tomorrow")
AFTER_TOMORROW_TOKENS = ("後日", "后日", "大後日", "the day after tomorrow")
NEXT_WEEK_TOKENS = ("下週", "下周", "來週", "来週", "next week", "下星期", "下礼拜")
LATE_CUES = ("之後", "以後", "以後", "過後", "过后", "以後", "后", "後", "after", "past",
             "最少", "至少", "起跳", "或以上", "以上")
EARLY_CUES = ("之前", "以前提前", "before", "up to", "以內", "以内", "內", "前")
OPEN_LATE_CUES = ("還营业", "還營業", "还营业", "仍開", "仍开", "開住", "开住", "營業中",
                  "still open", "open at", "open until", "营业到", "營業到", "夜晚都")

#: How many characters around the clock a direction word may sit in. The window is
#: derived from the cue tables themselves - the longest cue, plus the space that
#: separates it from the clock - so a longer cue cannot fall out of it again (D475:
#: a hard-coded 6 was one short of `before`, and the English "before 7pm" was invisible).
_CUE_WINDOW = max(len(cue) for cue in EARLY_CUES + LATE_CUES) + 1

CLOCK_RE = re.compile(
    r"(?:(\d{1,2})\s*[:：]\s*(\d{2}))"                                  # 19:30
    r"|(?:(\d{1,2})\s*(?:點|点|時|时|o'?clock)(半|\d{1,2}(?:分|分鐘|分钟)?)?)"  # 7點 / 7點半 / 7時15分
    r"|(?:(\d{1,2})\s*(am|pm|AM|PM))",                                   # 10pm
    re.VERBOSE,
)

#: The characters a Chinese numeral may precede when it is an HOUR (D445: 九點 is 9 o'clock
#: - the product read the weekday numerals and not the hour ones, so a user who wrote a
#: number the way they speak got nothing).
#:
#: D446: the CANONICAL spellings only - the text is canonicalised before it is read, so a
#: Simplified marker here could never match. (點 U+9EDE and 時 U+6642.)
_HOUR_MARKERS = "點時"

#: D446: the time parser's cue tables are canonicalised at import, like the lexicon's
#: (D435) and the state merger's (D421). The query is canonicalised before it reaches a
#: matcher, so a Simplified entry in a table that is NOT canonicalised can never match -
#: and the Traditional spelling the table does not carry is not read at all. That is how
#: the Cantonese 禮拜 (the Traditional spelling of 礼拜) was never understood: the table
#: held only the Simplified 礼拜, which the canonicalisation had already rewritten away.
_CANONICALISED_TABLES = (
    "TODAY_TOKENS", "TONIGHT_TOKENS", "TOMORROW_TOKENS", "AFTER_TOMORROW_TOKENS",
    "NEXT_WEEK_TOKENS", "WEEKEND_TOKENS", "WEEKDAY_TOKENS", "WEEKDAY_SUFFIX",
    "PART_OF_DAY", "EARLY_CUES", "LATE_CUES", "OPEN_LATE_CUES",
)


def _canonicalise_tables() -> None:
    """Put every cue table in the canonical spelling."""
    from nexus_ai.nlu.canonical import canonical_node

    module = sys.modules[__name__]
    for name in _CANONICALISED_TABLES:
        table = getattr(module, name, None)
        if table is None:
            continue
        setattr(module, name, canonical_node(table))


_canonicalise_tables()


def clock_match(text: str) -> re.Match[str] | None:
    """The clock in a text, with the Chinese numerals read as digits.

    One place, so the hour is read the same way wherever it is looked for: 九點 and 9點
    are the same hour, and 星期三 stays a weekday (the numeral is only rewritten when it
    is followed by an hour marker).
    """
    from nexus_ai.nlu.numerals import normalise_numerals

    return CLOCK_RE.search(normalise_numerals(text or "", only_before=_HOUR_MARKERS))


@dataclass
class ParsedTime:
    type: str  # explicit | relative | range | unspecified
    starts_at: datetime | None
    ends_at: datetime | None
    raw: str
    quality: str | None = None
    confidence: float = 0.0

    def to_intent_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": self.type, "starts_at": None, "ends_at": None,
                               "raw": self.raw, "quality": self.quality}
        if self.starts_at:
            out["starts_at"] = self.starts_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if self.ends_at:
            out["ends_at"] = self.ends_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return out


def resolve_weekday(target: int, today: date, *, next_week: bool = False) -> date:
    """The next occurrence of python weekday `target` on/after `today`."""
    delta = (target - today.weekday()) % 7
    if next_week:
        delta += 7
    return today + timedelta(days=delta)


def _combine(day: date, hh: int, mm: int) -> datetime:
    return datetime(day.year, day.month, day.day, hh, mm, tzinfo=HK_TZ)


def _guess_meridiem(hour: int, meridiem: str | None, part: str | None) -> int:
    if meridiem == "am":
        return 0 if hour == 12 else hour
    if meridiem == "pm":
        return hour if hour == 12 else hour + 12
    if part in ("afternoon", "evening", "night") and hour < 12:
        return hour + 12
    if part == "morning" and hour == 12:
        return 12
    if part == "noon" and hour < 11:
        return hour + 12
    return hour


def _find_part(text: str) -> tuple[str, time, time] | None:
    low = text.lower()
    best: tuple[int, tuple[str, time, time]] | None = None
    for label, tokens, start, end in PART_OF_DAY:
        for tok in tokens:
            t = tok.lower()
            if t and t in low:
                if best is None or len(t) > best[0]:
                    best = (len(t), (label, start, end))
    return best[1] if best else None


def _find_weekday(text: str) -> tuple[int, bool] | None:
    low = text.lower()
    next_week = any(tok in low for tok in NEXT_WEEK_TOKENS)
    # 星期X / 週X / 周X first (longest wins), then bare english names
    m = re.search(r"(?:星期|礼拜|週|周)([一二三四五六日天])", text)
    if m:
        return WEEKDAY_SUFFIX[m.group(1)], next_week
    for tok in sorted(WEEKDAY_TOKENS, key=len, reverse=True):
        if tok.isascii():
            # 3-letter abbreviations must be whole words: "sunset" is not Sunday
            if not re.search(rf"{re.escape(tok)}", low):
                continue
        elif tok not in text:
            continue
        return WEEKDAY_TOKENS[tok], next_week
    return None


def parse_time(text: str, now: datetime | None = None) -> ParsedTime | None:
    """Return a `ParsedTime` or None when the query carries no time signal at all.

    Never guesses a date when none was implied: a pure "open late" cue comes back with
    `starts_at=None` and a machine-readable `quality` instead (§8 — no invented fields).

    D446: the text is canonicalised before it is read, because the cue tables are (§411,
    D435) - so the Cantonese 禮拜 and the Simplified 礼拜 are the same weekday, and the
    Traditional spelling the table did not carry is read at last.
    """
    if not text:
        return None
    raw_text = text
    text = canonical(text)
    now = (now or datetime.now(HK_TZ)).astimezone(HK_TZ)
    today = now.date()
    low = text.lower()

    part = _find_part(text)
    weekday, next_week = (None, False)
    wd = _find_weekday(text)
    if wd:
        weekday, next_week = wd
    clock = clock_match(text)
    has_weekend = any(tok.lower() in low for tok in WEEKEND_TOKENS)
    is_tonight = any(tok in text for tok in TONIGHT_TOKENS) or ("tonight" in low)
    is_tomorrow = any(tok in text for tok in TOMORROW_TOKENS) or ("tomorrow" in low)
    is_today = any(tok in text for tok in TODAY_TOKENS) or any(t in low for t in ("today", "now"))
    is_after_tomorrow = any(tok in text for tok in AFTER_TOMORROW_TOKENS)
    open_late = any(tok.lower() in low for tok in OPEN_LATE_CUES) or bool(
        clock and _late_suffix(text, clock))

    day: date | None = None
    if weekday is not None:
        day = resolve_weekday(weekday, today, next_week=next_week)
    elif is_tonight:
        day = today
    elif is_tomorrow or is_after_tomorrow:
        day = today + timedelta(days=1)
    elif is_today:
        day = today
    elif has_weekend:
        day = resolve_weekday(5, today)
        if day <= today and today.weekday() == 6:
            day = today

    # ---- 1. explicit clock time -------------------------------------------
    if clock and not _valid_clock(clock, part):
        clock = None
    if clock:
        hh, mm, part_label = _clock_to_hm(clock, part)
        anchor = day or (today if (is_today or is_tonight or part) else None)
        if anchor is None:
            anchor = today
        start = _combine(anchor, hh, mm)
        if start < now and not (weekday is not None or is_tomorrow or is_after_tomorrow
                                or has_weekend):
            # "晚上8點" said at 9pm reads as tomorrow unless the user pinned a date
            if is_today or is_tonight:
                pass
            else:
                start = start + timedelta(days=1)
        window_end = start + timedelta(minutes=_default_duration(part_label))
        if _early_suffix(text, clock):
            # D463: "before seven" is a direction, not a window: the merchant's OPENING
            # hour has to be at or before it - the mirror of the "open late after" filter
            # below, which asks for a CLOSING hour at or after it.
            return ParsedTime("relative", None, None, _raw(raw_text),
                              quality=f"before:{hh:02d}{mm:02d}", confidence=0.8)
        if open_late or _late_suffix(text, clock):
            return ParsedTime("relative", None, None, _raw(raw_text),
                              quality=f"open_late_after:{hh:02d}{mm:02d}",
                              confidence=0.9)
        return ParsedTime("explicit", start, window_end, _raw(raw_text),
                          quality=part_label, confidence=0.95)

    # ---- 2. "open after 10" without a date: a recurring closing-time filter --
    late_hours = _bare_hour(text) if open_late else None
    if late_hours is not None:
        hh, mm = late_hours
        return ParsedTime("relative", None, None, _raw(raw_text),
                          quality=f"open_late_after:{hh:02d}{mm:02d}", confidence=0.8)

    # ---- 3. day + part-of-day window --------------------------------------
    if day is not None and part:
        label, p_start, p_end = part
        start = _combine(day, p_start.hour, p_start.minute)
        end = _combine(day, p_end.hour, p_end.minute)
        if start < now:
            rolled = start + timedelta(days=1)
            # only roll when the user did not pin a weekday/date themselves
            if weekday is None and not (is_tomorrow or is_after_tomorrow or has_weekend):
                start, end = rolled, end + timedelta(days=1)
        conf = 0.85 if weekday is not None else 0.7
        return ParsedTime("range", start, end, _raw(raw_text), quality=label, confidence=conf)

    # ---- 4. weekend span ---------------------------------------------------
    if has_weekend:
        sat = resolve_weekday(5, today)
        start = _combine(sat, 9, 0)
        end = _combine(sat + timedelta(days=2), 0, 0)
        return ParsedTime("range", start, end, _raw(raw_text), quality="weekend", confidence=0.75)

    # ---- 5. part-of-day only ("晚上10點後" handled above; "夜晚" here) -------
    if part:
        label, p_start, p_end = part
        start = _combine(today, p_start.hour, p_start.minute)
        end = _combine(today, p_end.hour, p_end.minute)
        if end <= now:
            start += timedelta(days=1)
            end += timedelta(days=1)
        return ParsedTime("range", start, end, _raw(raw_text), quality=label, confidence=0.5)

    # ---- 6. bare day -------------------------------------------------------
    if day is not None:
        start = _combine(day, 9, 0)
        end = _combine(day, 23, 0)
        return ParsedTime("range", start, end, _raw(raw_text), quality="all_day", confidence=0.6)

    return None


def _valid_clock(m: re.Match, part: tuple[str, time, time] | None) -> bool:
    """A clock match must yield a real time; "7 30pm" after punctuation stripping would
    otherwise read as hour 30, and §8 forbids silently inventing a time."""
    try:
        hh, mm, _ = _clock_to_hm(m, part)
    except (ValueError, TypeError):
        return False
    return 0 <= hh <= 23 and 0 <= mm <= 59


def _clock_to_hm(m: re.Match, part: tuple[str, time, time] | None) -> tuple[int, int, str | None]:
    part_label = part[0] if part else None
    if m.group(1):  # 19:30
        hh, mm = int(m.group(1)), int(m.group(2))
        if hh < 12 and part_label in ("afternoon", "evening", "night"):
            hh += 12
        return hh, mm, part_label
    if m.group(5):  # 10pm
        hh = _guess_meridiem(int(m.group(5)), m.group(6).lower(), None)
        return hh, 0, "night" if m.group(6).lower() == "pm" else "morning"
    hh = int(m.group(3))
    tail = m.group(4)
    mm = 0
    if tail == "半":
        mm = 30
    elif tail:
        digits = re.sub(r"\D", "", tail)
        mm = int(digits) if digits else 0
        if mm > 59:
            mm = 0
    return _guess_meridiem(hh, None, part_label), mm, part_label


def _default_duration(part_label: str | None) -> int:
    return {"night": 150, "evening": 150, "afternoon": 120, "lunch": 90,
            "noon": 90, "morning": 120}.get(part_label or "", 120)


def _cue_near(text: str, clock: re.Match, cues: tuple[str, ...]) -> bool:
    """Whether a direction word sits next to the clock, on EITHER side.

    D475: the two cues were read differently - the early one on both sides of the
    clock, the late one only after it - and the English word order puts the cue
    BEFORE the clock ("after 7pm"), so the late cue was invisible in English while it
    worked in Chinese ("七點之後"). One rule for both now.

    D463: the list used to be hard-coded in the late cue while the table beside it -
    `LATE_CUES` - held the same idea and was read by nobody, and the two disagreed: the
    table knows the Cantonese and the written forms, the literal knew six of them. One
    list now, and the table is the one that is read.
    """
    tail = text[clock.end(): clock.end() + _CUE_WINDOW]
    head = text[max(0, clock.start() - _CUE_WINDOW): clock.start()]
    return any(tok in tail or tok in head for tok in cues)


def _late_suffix(text: str, clock: re.Match) -> bool:
    """The direction word next to the clock ("seven o'clock, after").

    D463: the list used to be hard-coded HERE while the table beside it - `LATE_CUES` -
    held the same idea and was read by nobody, and the two disagreed: the table knows the
    Cantonese and the written forms, the literal knew six of them. One list now, and the
    table is the one that is read.
    """
    return _cue_near(text, clock, LATE_CUES)


def _early_suffix(text: str, clock: re.Match) -> bool:
    """The direction word next to the clock ("seven o'clock, before").

    D463: `EARLY_CUES` was a table nobody read, so the "before" was dropped and the
    query answered as if the user had not said it. The cue may sit on either side of
    the clock - "seven o'clock, before" and "before seven o'clock" are the same request -
    so both sides are read.
    """
    return _cue_near(text, clock, EARLY_CUES)


def _bare_hour(text: str) -> tuple[int, int] | None:
    """`10pm`, `10點`, `22:00` anywhere, for the open-late reading."""
    m = clock_match(text)
    if not m:
        return None
    hh, mm, _ = _clock_to_hm(m, _find_part(text))
    return hh, mm


def _raw(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text or "").strip()
    return cleaned[:80]
