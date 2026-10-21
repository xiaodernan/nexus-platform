"""The Chinese numerals, read in one place.

The product already reads them in one place: the WEEKDAY suffix (星期三 ✓). It does not read
them in the two a user writes most - the hour (九點 ✗) and the party size (三個人 ✗) - so a
Hong Kong user who writes a number the way they speak gets nothing back, and only the users
who type Arabic digits are understood.

The code points were checked against the Unicode character database (D409's lesson: a
writer's memory of a CJK code point is not a reference).

The forms a user actually writes:

    零〇一二三四五六七八九十   the digits
    十 十二 二十 二十三        the compound forms (a leading 十, then the ones place)
"""

from __future__ import annotations

import re

#: The digits. The canonical spelling only (D435: the vocabulary holds ONE spelling per
#: character, and the text is canonicalised before it reaches a matcher - so the Simplified
#: 两 is never seen here, and the table holds the Traditional 兩).
CN_DIGITS: dict[str, int] = {
    "\u96f6": 0,   # 零
    "\u3007": 0,   # 〇
    "\u4e00": 1,   # 一
    "\u4e8c": 2,   # 二
    "\u5169": 2,   # 兩
    "\u4e09": 3,   # 三
    "\u56db": 4,   # 四
    "\u4e94": 5,   # 五
    "\u516d": 6,   # 六
    "\u4e03": 7,   # 七
    "\u516b": 8,   # 八
    "\u4e5d": 9,   # 九
    "\u5341": 10,  # 十
}

#: A run of Chinese numerals.
CN_NUMBER_RE = re.compile("[" + "".join(CN_DIGITS) + "]{1,3}")


def cn_number(text: str) -> int | None:
    """The value of a Chinese numeral, or None when it is not one.

        零 -> 0        九 -> 9        十 -> 10
        十二 -> 12     二十 -> 20     二十三 -> 23
    """
    if not text:
        return None
    if "十" not in text:
        total = 0
        for ch in text:
            value = CN_DIGITS.get(ch)
            if value is None:
                return None
            total = total * 10 + value
        return total
    head, _, tail = text.partition("十")
    tens = 1 if head == "" else CN_DIGITS.get(head)
    if tens is None:
        return None
    ones = 0 if tail == "" else CN_DIGITS.get(tail)
    if ones is None:
        return None
    return tens * 10 + ones


def normalise_numerals(text: str, *, only_before: str = "") -> str:
    """Rewrite the Chinese numerals in a text as digits.

    `only_before` restricts the rewrite to a numeral that is IMMEDIATELY followed by one of
    the given characters - which is how the time parser reads an hour without touching the
    weekday tokens (星期三 must stay a weekday, not become 星期3).

    **一 is not rewritten.** The product has already decided what the Chinese ONE means in
    these two places, and both decisions are tested: "一個人" is the SOLO cue and does not
    become a party size (an honest reading, not a guess), and "安靜一點" is a DEGREE and not
    one o'clock. The compound forms are unaffected: 十一 is eleven, and it is rewritten.
    """
    if not text:
        return text

    def _replace(match: re.Match[str]) -> str:
        run = match.group(0)
        if only_before:
            after = text[match.end():match.end() + len(only_before)]
            if not after or after[0] not in only_before:
                return run
        value = cn_number(run)
        if value is None or value == 1:
            return run
        return str(value)

    return CN_NUMBER_RE.sub(_replace, text)
