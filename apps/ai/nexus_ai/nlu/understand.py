"""Deterministic query understanding to the §7.1 `Intent` schema.

This is the engine behind `MockAdapter`'s `intent_extract` task, and also the *floor*
the real providers are checked against: the rule path always runs, and its per-field
confidence is what lets us honour §8 "不要强行猜测" — a field we cannot resolve stays
`null` and is listed in `unknowns`, never filled in with a plausible-looking default.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Sequence

from nexus_ai.nlu.matching import cue_in, cue_positions
from nexus_ai.nlu.lexicon import (
    canon_constraint,
    COMPARE_CUES,
    quoted_entities,
    CONSTRAINT_RULES,
    DISCOVER_CUES,
    NEARBY_TERMS,
    PREFERENCE_RULE_VALUES,
    PLAN_CUES,
    PREFERENCE_RULES,
    PURCHASE_CUES,
    RESERVE_CUES,
    ASK_MERCHANT_CUES,
    SORT_RULES,
    URGENCY_FLEXIBLE,
    URGENCY_NOW,
    detect_language,
    match_category,
    match_cuisine_terms,
    match_cuisines,
    match_district,
    normalize_query,
)
from nexus_ai.nlu.polarity import (
    apply_polarity,
    clause_attached,
    clause_final,
    forward_gap,
    negation_positions,
)
from nexus_ai.nlu.timeparse import HK_TZ, cue_alternation, parse_time

# --------------------------------------------------------------------------- patterns
BUDGET_MAX_RE = re.compile(
    r"(?:预算|預算|budget)\s*(?:系|是|為|为)?\s*(?:最多|唔超過|不超过|內|內|以内|以內)?\s*"
    r"(?:hk\$|hkd|港幣|港币|蚊|\$)?\s*(\d{2,5})(?:\.\d{1,2})?",
    re.IGNORECASE,
)
BUDGET_WORD_RE = re.compile(
    r"(?:under|less than|below|within|max|最多|唔超過|不超过|以下|以內|以内|"
    r"少過|唔多過|平過|便宜過|唔貴過|不貴过|不超過)\s*"
    r"(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})",
    re.IGNORECASE,
)
#: D636: two families of cue were missing from every ceiling and floor rule. Measured on the
#: building plane 2026-10-31 (`tmp/d636_before.txt`): 至多/頂多/不多過/少於/低於 and `at most`,
#: `no more than`, `up to` read NO budget at all, and so did 多過/貴過/起碼/高於 and `more than`.
#: A user who capped the price at 至多1000 got the unfiltered catalogue; a user who floored it at
#: 起碼1000 got the cheapest rows, because the floor lane never saw the sentence.
#:
#: The CJK cues added here count things that are not money - 「至多40人」 is a party, 「少於10分鐘」
#: a wait, 「低於30度」 a temperature - so each one reads a budget only when the amount is marked
#: as money: a currency token on one side of the digits (`_MONEY_SIDES`). 「貴過」 needs no marker,
#: because "more expensive than" IS a price. The Latin cues are money in this domain ("at most 300"
#: in a restaurant request), so they read a bare amount but refuse one that is a clock, a party or
#: a duration (`_NOT_MONEY`) - "up to 12pm" is the time lane's, and 「up to 12pm」 already answers
#: `before:1200` (`tmp/d636_collide.txt`).
_MONEY_BEFORE = r"(?:hk\$|hkd|港幣|港币|\$)"
_MONEY_AFTER = r"(?:蚊|元|塊|块|港幣|港币|dollars?)"
_MONEY_SIDES = (rf"(?:{_MONEY_BEFORE}\s*(\d{{2,5}})(?:\.\d{{1,2}})?"
                rf"|(\d{{2,5}})(?:\.\d{{1,2}})?\s*{_MONEY_AFTER})")
_NOT_MONEY = (r"(?!\s*(?:am|pm|:|點|時|时|人|位|個|个|people|pax|persons?|guests?|diners?|"
              r"mins?|minutes?|hours?|hrs?|days?|weeks?|months?|years?|%))")
BUDGET_CEILING_CUE_RE = re.compile(
    r"(?:至多|頂多|不多過|少於|低於)\s*" + _MONEY_SIDES
    + r"|(?:at\s+most|no\s+more\s+than|up\s+to)\s*(?:hk\$|hkd|\$)?\s*(\d{2,5})(?:\.\d{1,2})?"
    + _NOT_MONEY,
    re.IGNORECASE,
)
BUDGET_FLOOR_CUE_RE = re.compile(
    r"貴過\s*(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})(?:\.\d{1,2})?"
    r"|(?:多過|起碼|高於)\s*" + _MONEY_SIDES
    + r"|more\s+than\s*(?:hk\$|hkd|\$)?\s*(\d{2,5})(?:\.\d{1,2})?"
    + _NOT_MONEY,
    re.IGNORECASE,
)
#: D624: the ceiling a HK user writes comes AFTER the amount. Every ceiling cue above - and in
#: BUDGET_WORD_RE - must PRECEDE the number, which is the English/formal shape ("under 300",
#: "最多300"). Measured 2026-10-30 (`tmp/d624_census.txt`): "300蚊以內", "300以下", "500蚊以下", "$3000以下",
#: "人均300以內", "每位$200以內" and "300蚊樓下" ALL produced no budget at all, so a stated price
#: ceiling never reached the ranker. This is the trailing half; the currency token is OPTIONAL
#: but a unit word is not skipped over - "500米以內" is a radius and stays without a budget.
SPEND_CEILING_RE = re.compile(
    r"(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})(?:\.\d{1,2})?\s*(?:"
    r"(?:蚊|元|塊|块|hk\$|hkd|港幣|港币|\$|dollars?)\s*"
    r"(?:以內|以内|以下|樓下|楼下|之內|之内|內|内|左右|上下)"
    r"|(?:以內|以内|以下|樓下|楼下|之內|之内)"
    r")",
    re.IGNORECASE,
)
#: D624: a RANGE is money only when the sentence marks it as money - a currency token inside
#: the span, or a budget cue before it - so "10至20人" stays a party size. Measured
#: 2026-10-30: "預算 300 - 500" read max=300 (the LOW end, so a user asking for 300-500 got
#: only ≤300) and "$300-$500" read nothing at all (`tmp/d624_census.txt`).
BUDGET_RANGE_RE = re.compile(
    r"(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})(?:\s*(?:蚊|元|塊|块))?\s*"
    r"(?:-|–|—|~|～|至|到|to)\s*(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})"
    r"(?:\s*(?:蚊|元|塊|块))?",
    re.IGNORECASE,
)
#: D624: the per-head price POINT with no ceiling word - "人均$300", "人均消費300蚊".
#: A user who names a per-head figure is stating a budget; every one of those shapes was silent.
PER_PERSON_POINT_RE = re.compile(
    r"(?:每人|人均|每位|per ?person|p/?p|per head|人頭)\s*"
    r"(?:消費額|消費|佐)?\s*(?:大約|大概|約|差不多)?\s*"
    r"(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})(?:\.\d{1,2})?",
    re.IGNORECASE,
)
#: D624: the same amount-first shape for a FLOOR - "300蚊以上" carried no budget at all, so a
#: user who names the bottom of a band got the cheapest rows in the corpus. BUDGET_MIN_RE reads
#: only the cue-first form ("超過300").
SPEND_FLOOR_RE = re.compile(
    r"(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})(?:\.\d{1,2})?\s*(?:"
    r"(?:蚊|元|塊|块|hk\$|hkd|港幣|港币|\$|dollars?)\s*"
    r"(?:以上|或以上|起跳|打上|起)"
    r"|(?:以上|或以上|起跳|打上)"
    r")",
    re.IGNORECASE,
)
CURRENCY_TOKENS = ("hk$", "hkd", "港幣", "港币", "$", "蚊", "元", "塊", "块")
BUDGET_MIN_RE = re.compile(
    r"(?:over|above|at least|超過|超过|以上|最少|至少)\s*(?:hk\$|hkd|\$)?\s*(\d{2,5})"
    r"|(?:hk\$|hkd|\$)\s*(\d{2,5})\s*(?:以上|over|起跳)",
    re.IGNORECASE,
)
CURRENCY_AMOUNT_RE = re.compile(
    r"(?:hk\$|hkd|港幣|港币)\s*(\d{2,5})(?:\.\d{1,2})?", re.IGNORECASE
)
#: D628: the span a party size occupies, written so it can be REMOVED from a text. `PARTY_RE`
#: above opens with `(?:\D|^)`, which consumes the character before the number - fine for a
#: search, wrong for a substitution.
#: D629: the span a time occupies. Unlike the price and the party, a cue word CAN be content
#: (下午 in 下午茶), so this one is only applied when the time lane actually parsed a time
#: (`match_core(..., strip_time=True)`), not unconditionally.
#: D634: and the cue words are the LANE's own table, not a list written beside it. This one
#: held eight CJK spellings out of the 23 `PART_OF_DAY` writes, so 「深夜嘅餐廳」 kept 深夜 in the match text
#: (measured 2026-10-30: 0 of the 470 published rows carry it, `tmp/d634_carriers.txt`) and
#: all ten cards printed 符合「深夜嘅餐廳」 - a match no row can have. The whole table is
#: written by `timeparse.cue_alternation()`: the parts of the day, the days, the weekdays
#: and the clock, so a cue the lane learns is stripped the day it is written (§D438).
_TIME_CUE = cue_alternation()
TIME_SPAN_RE = re.compile(
    rf"(?:{_TIME_CUE})?\s*"
    r"\d{1,2}\s*(?:點|点|時|时)(?:\s*\d{1,2}\s*分)?"
    r"|\d{1,2}:\d{2}"
    r"|\d{1,2}\s*(?:am|pm)\b"
    rf"|{_TIME_CUE}",
    re.IGNORECASE,
)
PARTY_SPAN_RE = re.compile(
    # D633: a RANGE is one party too - 「2至4人」 is read as 4 by `PARTY_RE` and the strip removed
    # only the tail, leaving 「2至」 in the match text; 「10至20人」 was worse, because the BUDGET
    # range rule took 「10至20」 first and left 「人」. The range alternative comes FIRST, so the
    # whole span goes before the money rule can claim half of it.
    r"(?:\u6211\u54cb|\u6211\u5011|\u6211\u4eec)?\s*\d{1,2}\s*"
    r"(?:\u81f3|\u5230|[-–~～]|to)\s*\d{1,2}\s*"
    r"(?:\u500b\s*\u4eba|\u4e2a\s*\u4eba|\u4f4d\u4eba|\u500b|\u4e2a|\u4f4d|\u4eba)|"
    r"(?:\u6211\u54cb|\u6211\u5011|\u6211\u4eec)?\s*\d{1,2}\s*"
    r"(?:\u500b\s*\u4eba|\u4e2a\s*\u4eba|\u4f4d\u4eba|\u500b|\u4e2a|\u4f4d|\u4eba)(?:\u5605|\u7684)?"
    r"|party(?:\s*of)?\s*\d{1,2}\b"
    r"|\d{1,2}\s*(?:people|pax|persons?|guests|diners)\b",
    re.IGNORECASE,
)
PER_PERSON_RE = re.compile(r"(?:每人|人均|每位|per ?person|p/?p|per head|人頭)", re.IGNORECASE)
PER_ITEM_RE = re.compile(r"(?:每件|每款|each|per item|一双|一对|一對)", re.IGNORECASE)

#: CJK counters need no trailing boundary (they are word chars); latin units do.
PARTY_RE = re.compile(
    r"(?:\D|^)\s*(?:我哋|我們|我们)?\s*(\d{1,2})\s*(?:個|个|位|人)"
    r"|(?:party(?:\s*of)?|for)\s*(\d{1,2})\b"
    r"|(\d{1,2})\s*(?:people|pax|persons?|guests|diners)\b",
    re.IGNORECASE,
)

#: The characters a Chinese numeral may precede when it is a PARTY SIZE (D445: 三個人 is
#: three people - the product read the digits and not the numerals, so a user who wrote a
#: number the way they speak got no party size at all).
#:
#: D446: the CANONICAL spellings only - the text is canonicalised before it is read, so a
#: Simplified marker here could never match. (個 U+500B, 位 U+4F4D, 人 U+4EBA.)
_PARTY_MARKERS = "個位人"

#: D447: this module's own cue tables are canonicalised at import, like the lexicon's
#: (D435) and the state merger's (D421). Their Simplified entries were dead - the query
#: is canonicalised before it is compared with them - and they were harmless only because
#: the tables happened to hold both spellings.
_CANONICALISED_TABLES = ("OPEN_PRICE_WORDS", "_BUDGET_WORDS")


def _canonicalise_tables() -> None:
    """Put every cue table in this module in the canonical spelling."""
    import sys

    from nexus_ai.nlu.canonical import canonical_node

    module = sys.modules[__name__]
    for name in _CANONICALISED_TABLES:
        table = getattr(module, name, None)
        if table is None:
            continue
        setattr(module, name, canonical_node(table))


_canonicalise_tables()


def party_text(text: str) -> str:
    """The text with its Chinese party-size numerals read as digits.

    One place, so the party size is read the same way in the first turn and in the
    second: 三個人 and 3個人 are the same party, and 星期三 stays a weekday (the numeral
    is only rewritten when a party counter follows it).
    """
    from nexus_ai.nlu.numerals import normalise_numerals

    return normalise_numerals(text or "", only_before=_PARTY_MARKERS)


def party_size_of(text: str) -> int | None:
    """The party size a turn names, or None when it names none. The ONE reader.

    `PARTY_RE` guards its CJK alternative with `(?:\D|^)`, so a digit run that is part of a
    LONGER number is not read as a party size. D518: the state merger kept a private copy of
    the pattern without that guard, so "113個人" was thirteen seats on the second turn
    and no party size at all on the first - the same fact read two ways, and the merge's copy
    was the one that invented a number. Both turns read it here now.
    """
    m = PARTY_RE.search(party_text(text))
    if not m:
        return None
    raw = next((g for g in m.groups() if g), "")
    if not raw:
        return None
    n = int(raw)
    return n if 1 <= n <= 40 else None
RADIUS_RE = re.compile(
    r"(\d{1,3})\s*(?:公里|公里|km|千米)", re.IGNORECASE
)
METERS_RE = re.compile(r"(\d{3,5})\s*(?:米|m\b)", re.IGNORECASE)
WALK_MIN_RE = re.compile(r"(?:行|walk|步行|走)\s*(\d{1,2})\s*(?:分鐘|分钟|min|minute)", re.IGNORECASE)

OPEN_PRICE_WORDS = ("預算", "预算", "budget", "price", "價錢", "价钱", "多少錢", "多少钱", "平", "貴", "贵")


def _wire_value(row: dict[str, Any]) -> dict[str, Any]:
    """A structured value crosses the §2 boundary as JSON TEXT.

    The contract fixes `PreferenceItem.value: str` and `ConstraintItem.value: str`, while the
    rule engine's own rows hold structured objects (D511's `cuisine_like`, the budget row).
    Emitting the object into the dict made `Intent.model_validate` FAIL — a typed-cuisine
    query could not build an intent at all, so `/ai/v1/query/understand` and the search
    pipeline broke on it — and it made every consumer that hashes the value crash
    (`TypeError: unhashable type: 'dict'`). Every reader downstream already parses the text
    back (`search/service.py` `json.loads(raw_value)`), so JSON text is the shape they expect.
    """
    value = row.get("value")
    if isinstance(value, (dict, list)):
        return {**row, "value": json.dumps(value, ensure_ascii=False)}
    return row


@dataclass
class IntentExtraction:
    """The rule engine's output before it is coerced into the contract's `Intent`."""

    raw_query: str
    intent: str = "unknown"
    category: str | None = None
    language: str = "zh-HK"
    location: dict[str, Any] = field(default_factory=dict)
    time: dict[str, Any] = field(default_factory=dict)
    budget: dict[str, Any] | None = None
    party_size: int | None = None
    preferences: list[dict[str, Any]] = field(default_factory=list)
    constraints: list[dict[str, Any]] = field(default_factory=list)
    sort_preference: str = "relevance"
    urgency: str = "normal"
    confidence: dict[str, float] = field(default_factory=dict)
    unknowns: list[str] = field(default_factory=list)
    mentioned_entities: list[str] = field(default_factory=list)
    merchant_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "raw_query": self.raw_query,
            "intent": self.intent,
            "category": self.category,
            "location": self.location or {},
            "time": self.time or {},
            "budget": self.budget,
            "party_size": self.party_size,
            "preferences": [_wire_value(p) for p in self.preferences],
            "constraints": [_wire_value(c) for c in self.constraints],
            "sort_preference": self.sort_preference,
            "urgency": self.urgency,
            "language": self.language,
            "confidence": self.confidence,
            "unknowns": self.unknowns,
            "mentioned_entities": self.mentioned_entities,
            "merchant_id": self.merchant_id,
        }


# --------------------------------------------------------------------------- entry point
def extract_intent_dict(query: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """JSON-shaped Intent for `MockAdapter` and the HTTP layer."""
    return extract_intent(query, context).to_dict()


def extract_intent(query: str, context: dict[str, Any] | None = None) -> IntentExtraction:
    context = context or {}
    ex = IntentExtraction(raw_query=(query or "").strip())
    text = normalize_query(query or "")
    if not text:
        ex.unknowns = ["intent"]
        return ex

    # D420: the language is read from the text as the user wrote it, and only the
    # VOCABULARY comparison sees the canonical spelling. Canonicalising first would take
    # the simplified markers with it, and a Simplified Chinese user would be answered
    # in the Traditional locale.
    ex.language = str(context.get("locale") or detect_language(text))
    from nexus_ai.nlu.canonical import canonical

    text = canonical(text)
    ex = _fill_intent_kind(ex, text)
    ex = _fill_category(ex, text)
    ex = _fill_location(ex, text, context)
    ex = _fill_time(ex, text, context)
    ex = _fill_budget(ex, text)
    ex = _fill_party(ex, text, context)
    ex = _fill_preferences(ex, text)
    # Second pass: infer category from preferences now that they are filled
    if not ex.category:
        inferred = _infer_category_from_signals(ex)
        if inferred:
            ex.category = inferred[0]
            ex.confidence["category"] = inferred[1]
    ex = _fill_constraints(ex, text)
    ex = _fill_sort(ex, text)
    ex = _fill_urgency(ex, text)
    ex.mentioned_entities = _extract_entities(text)
    if context.get("merchant_id"):
        ex.merchant_id = str(context["merchant_id"])
    ex.unknowns = _compute_unknowns(ex)
    return ex


# --------------------------------------------------------------------------- field rules
def _fill_intent_kind(ex: IntentExtraction, text: str) -> IntentExtraction:
    low = text.lower()
    # D479: the first turn had its own copy of the matching rule - the loosest one,
    # any substring will do - so a bookshop was a reservation. One rule now.
    has = lambda cues: any(cue_in(c, text, low) for c in cues)  # noqa: E731

    compare_hits = len(_extract_entities(text)) >= 2
    if has(COMPARE_CUES) and compare_hits:
        ex.intent, ex.confidence["intent"] = "compare", 0.9
    elif has(RESERVE_CUES):
        ex.intent, ex.confidence["intent"] = "reserve", 0.9
    elif has(PURCHASE_CUES):
        ex.intent, ex.confidence["intent"] = "purchase", 0.85
    elif has(ASK_MERCHANT_CUES):
        ex.intent, ex.confidence["intent"] = "ask_merchant", 0.8
    elif has(PLAN_CUES):
        ex.intent, ex.confidence["intent"] = "plan_experience", 0.8
    elif has(DISCOVER_CUES):
        ex.intent, ex.confidence["intent"] = "discover_merchant", 0.75
    elif match_category(text) or match_cuisines(text) or has(NEARBY_TERMS)             or has(PREFERENCE_RULE_VALUES) or _has_budget_word(text) or _has_constraint(text):
        # "预算 300 港币，想吃日料" names *what* they want without a discovery verb.
        ex.intent, ex.confidence["intent"] = "discover_merchant", 0.6
    else:
        ex.intent, ex.confidence["intent"] = "unknown", 0.2
    return ex


def _has_constraint(text: str) -> bool:
    """Whether the text names a NEGATION and its value ("唔食辣", "no peanuts").

    A user who says what they do not want is still asking for places, so the intent
    has to be a discovery - otherwise the constraint is read and the answer is "I do
    not know what you are looking for", which is not what was said.

    D541: the question is answered by the ONE reader. This copy kept D536's
    eight-character window after the lane itself moved to the clause, so the two
    answers about one sentence could disagree: measured, "no cilantro" and
    "no coriander" wrote `diet_avoid:coriander` and came back with the intent
    `unknown` - the constraint was read and the answer refused to answer. The window
    was also a substring test, so a cue inside a word ("no" in "snow peanut") counted
    as a refusal. One reader for both questions, the way D536 gave the two lanes one.
    """
    return bool(constraint_hits(text))


#: A stated price/quantity limit with no discovery verb is still a discovery request.
_BUDGET_WORDS = ("預算", "预算", "budget", "hk$", "hkd", "港幣", "港币", "蚊", "too expensive",
                 "cheap", "平啲", "貴啲", "under", "within", "less than", "以內", "以内")


def _has_budget_word(text: str) -> bool:
    low = (text or "").lower()
    # D480: the budget words are read by the ONE matcher - "under" inside "underground"
    # is not a budget the user stated.
    return any(cue_in(w, text, low) for w in _BUDGET_WORDS)


def _fill_category(ex: IntentExtraction, text: str) -> IntentExtraction:
    hit = match_category(text)
    if hit:
        cat, conf = hit
        ex.category = cat
        ex.confidence["category"] = conf
    cuisines = match_cuisines(text)
    if cuisines:
        if not ex.category:
            ex.category, ex.confidence["category"] = "restaurant", 0.9
        for c in cuisines:
            ex.preferences.append({"key": "cuisine", "value": c, "polarity": 1})
        # D511: also emit the structured cuisine_like that the seed writes and the matcher reads.
        # The seed stores {"values": [...]} under cuisine_like; the matcher (D394) reads both
        # shapes through cuisine_matches. A typed cuisine should be stored as cuisine_like
        # so the user's own words are recorded as a preference, not just used for category.
        #
        # The value is JSON TEXT, not an object: the contract fixes `PreferenceItem.value: str`,
        # and an object here made `Intent.model_validate` reject every typed-cuisine query and
        # made every consumer that hashes the value crash (184 tests). Every reader parses the
        # text back (`search/service.py` `json.loads(raw_value)`), so this is the one shape.
        ex.preferences.append({"key": "cuisine_like",
                               "value": json.dumps({"values": cuisines}, ensure_ascii=False),
                               "polarity": 1})
        ex.confidence["category"] = max(ex.confidence.get("category", 0.0), 0.92)
    if ex.intent == "discover_merchant" and ex.category in ("footwear", "electronics", "retail"):
        # a purchasable thing, not a place to go
        ex.intent = "discover_offering"
    if ex.intent == "purchase" and ex.category:
        ex.unknowns = []  # recomputed later
    # If still no category, try to infer from signals (occasion, preferences, etc.)
    if not ex.category:
        inferred = _infer_category_from_signals(ex)
        if inferred:
            ex.category = inferred[0]
            ex.confidence["category"] = inferred[1]
    return ex


# --------------------------------------------------------------------------- category inference from signals
#: An occasion names a situation, not a place, so it only narrows the category.
_OCCASION_CATEGORY_MAP: dict[str, list[tuple[str, float]]] = {
    "date": [("restaurant", 0.7), ("cafe", 0.6), ("bar", 0.5)],
    "group": [("restaurant", 0.7), ("bar", 0.6), ("karaoke", 0.5)],
    "family": [("restaurant", 0.8), ("cafe", 0.5), ("hotpot", 0.5)],
    "business": [("restaurant", 0.8), ("cafe", 0.5), ("hotel", 0.5)],
    "solo": [("cafe", 0.7), ("restaurant", 0.6), ("bakery", 0.4)],
}

#: (preference key, preference value) -> the categories that fit it. The pairs are the
#: ones `PREFERENCE_RULES` can emit, so a resolved preference is a category hint.
_PREFERENCE_CATEGORY_MAP: dict[tuple[str, str], list[tuple[str, float]]] = {
    ("ambience", "quiet"): [("cafe", 0.7), ("restaurant", 0.5)],
    ("ambience", "lively"): [("bar", 0.7), ("karaoke", 0.5)],
    ("style", "ambience"): [("restaurant", 0.6), ("cafe", 0.5), ("bar", 0.4)],
    ("style", "outdoor"): [("attraction", 0.7), ("park", 0.5)],
    ("style", "indoor"): [("restaurant", 0.6), ("cafe", 0.5), ("mall", 0.4)],
    ("view", "scenic"): [("restaurant", 0.6), ("hotel", 0.5), ("attraction", 0.5)],
    ("access", "mtr_near"): [("restaurant", 0.5), ("mall", 0.5)],
    ("access", "accessible"): [("restaurant", 0.5), ("mall", 0.5)],
    ("access", "parking"): [("mall", 0.6), ("restaurant", 0.4)],
    ("access", "pet_friendly"): [("restaurant", 0.5), ("cafe", 0.4), ("park", 0.4)],
    ("price_sense", "cheap"): [("restaurant", 0.6), ("cafe", 0.5)],
    ("price_sense", "premium"): [("restaurant", 0.7), ("hotel", 0.5)],
    ("weather", "rainy_day"): [("restaurant", 0.6), ("cafe", 0.5), ("mall", 0.5)],
    ("time_pref", "open_late"): [("bar", 0.8), ("restaurant", 0.5)],
    ("cuisine", "spicy"): [("restaurant", 0.8), ("hotpot", 0.6)],
}

#: A named cuisine lives in a category, and `specialty-coffee` is the one that is not a
#: restaurant: the seeded taxonomy has a `cafe` category for it.
_CUISINE_CATEGORY_MAP: dict[str, tuple[str, float]] = {
    "specialty-coffee": ("cafe", 0.95),
    "sushi": ("restaurant", 0.95),
    "dim_sum": ("restaurant", 0.95),
    "cantonese": ("restaurant", 0.9),
    "japanese": ("restaurant", 0.9),
    "korean": ("restaurant", 0.9),
    "thai": ("restaurant", 0.9),
    "italian": ("restaurant", 0.9),
    "indian": ("restaurant", 0.9),
    "western": ("restaurant", 0.9),
    "vegetarian": ("restaurant", 0.8),
    "seafood": ("restaurant", 0.9),
    "malaysian": ("restaurant", 0.9),
    "hotpot": ("restaurant", 0.9),
    "sichuan": ("restaurant", 0.9),
    "hunan": ("restaurant", 0.9),
    "mexican": ("restaurant", 0.9),
}


def _infer_category_from_signals(ex: IntentExtraction) -> tuple[str, float] | None:
    """Infer a category from occasion, preferences, and cuisine_like signals.

    A Chinese sentence rarely names a category outright ("\u5e2b\u6211\u627e\u4e00\u4e2a\u9002\u5408\u60c5\u4fa3\u7ea6\u4f1a\u7684\u5730\u65b9" says `occasion=date` and nothing
    else), so the category is inferred from the signals the extractor DID resolve. The
    confidence is deliberately lower than a direct category hit (0.95): an inferred
    category is a reading of the query, not a word the user wrote, and §8 says never
    fill a field in as if it were certain.
    """
    scores: dict[str, float] = {}

    for pref in ex.preferences:
        key = str(pref.get("key") or "")
        value = pref.get("value")
        polarity = int(pref.get("polarity", 1) or 1)
        sign = 1.0 if polarity > 0 else -0.5

        # occasion: date/group/family/business/solo
        if key == "occasion" and isinstance(value, str) and value in _OCCASION_CATEGORY_MAP:
            for cat, conf in _OCCASION_CATEGORY_MAP[value]:
                scores[cat] = scores.get(cat, 0.0) + conf * sign
            continue

        # (kind, value) pairs the NLU can emit
        pair = (key, value) if isinstance(value, str) else None
        if pair and pair in _PREFERENCE_CATEGORY_MAP:
            for cat, conf in _PREFERENCE_CATEGORY_MAP[pair]:
                scores[cat] = scores.get(cat, 0.0) + conf * sign
            continue

        # cuisine_like: {"values": [...]} -> the category that cuisine lives in. The value
        # crosses the boundary as JSON TEXT (the contract fixes `value: str`), so parse it.
        if key == "cuisine_like":
            payload: Any = value
            if isinstance(value, str):
                try:
                    payload = json.loads(value)
                except ValueError:
                    payload = None
            if isinstance(payload, dict):
                for cuisine in payload.get("values") or []:
                    hit = _CUISINE_CATEGORY_MAP.get(str(cuisine).lower())
                    if hit:
                        cat, conf = hit
                        scores[cat] = scores.get(cat, 0.0) + conf * sign

    if not scores:
        return None

    best_cat = max(scores, key=lambda c: (scores[c], c))
    best_score = scores[best_cat]
    if best_score < 0.5:
        return None
    # 0.5 -> 0.45, 0.95 -> 0.60: always below a direct hit, never above it.
    return best_cat, round(min(0.75, 0.15 + best_score * 0.5), 4)


def _fill_location(ex: IntentExtraction, text: str, context: dict[str, Any]) -> IntentExtraction:
    district = match_district(text)
    low = text.lower()
    # D480: the ONE matcher - a Latin term is a word.
    nearby = any(cue_in(t, text, low) for t in NEARBY_TERMS)
    geo = context.get("geo") or {}
    loc: dict[str, Any] = {}
    if district:
        name, spec = district
        loc = {"type": "district", "value": name,
               "resolved": {"lat": spec["lat"], "lng": spec["lng"]}}
        ex.confidence["location"] = 0.95
    elif nearby:
        loc = {"type": "nearby"}
        if isinstance(geo, dict) and geo.get("lat") is not None:
            loc["resolved"] = {"lat": float(geo["lat"]), "lng": float(geo["lng"])}
            ex.confidence["location"] = 0.9
        else:
            ex.confidence["location"] = 0.3
    elif isinstance(geo, dict) and geo.get("lat") is not None:
        # no place named: fall back to the session geo, but say so in confidence
        loc = {"type": "nearby", "resolved": {"lat": float(geo["lat"]), "lng": float(geo["lng"])}}
        ex.confidence["location"] = 0.45
    else:
        loc = {}
    radius = _match_radius(text)
    if radius:
        loc["radius_m"] = radius
        ex.confidence["location"] = max(ex.confidence.get("location", 0.0), 0.85)
    if loc.get("type") == "district" and not radius and district:
        loc["radius_m"] = None  # "in Sha Tin" is a district filter, not a radius
    ex.location = loc
    return ex


def _match_radius(text: str) -> int | None:
    m = RADIUS_RE.search(text)
    if m:
        return int(m.group(1)) * 1000
    m = WALK_MIN_RE.search(text)
    if m:  # ~80m of walking per minute
        return int(m.group(1)) * 80
    m = METERS_RE.search(text)
    if m and "距離" not in text[: max(0, m.start() - 2)]:
        return int(m.group(1))
    return None


def _fill_time(ex: IntentExtraction, text: str, context: dict[str, Any]) -> IntentExtraction:
    now_raw = context.get("now") or context.get("reference_time")
    now: datetime | None
    if isinstance(now_raw, datetime):
        now = now_raw.astimezone(HK_TZ)
    elif isinstance(now_raw, str) and now_raw:
        try:
            now = datetime.fromisoformat(now_raw.replace("Z", "+00:00")).astimezone(HK_TZ)
        except ValueError:
            now = None
    else:
        now = None
    parsed = parse_time(text, now)
    if parsed:
        ex.time = parsed.to_intent_dict()
        ex.confidence["time"] = round(parsed.confidence, 2)
    return ex


def _range_is_money(span: str, before: str) -> bool:
    """D624: an amount pair is a budget only when the sentence SAYS it is money.

    "10至20人" is a party size and must never become a HK$10-20 ceiling; a currency token
    inside the span, or a budget cue immediately before it, is what separates the two.
    """
    low = span.lower()
    if any(tok in low for tok in CURRENCY_TOKENS):
        return True
    return bool(re.search(r"(?:預算|预算|budget|max|最多|不超過|唔超過)\s*$",
                          before.lower()))


#: D636: the digits after a cue-first ceiling can count PEOPLE instead of dollars - 「最多40人」 is
#: a party cap, 「唔多過12人」 the same - and the ceiling lane read each as an HK$ ceiling, so a
#: party of forty filtered the catalogue by PRICE. Measured 2026-10-31 (`tmp/d636_party.txt`):
#: 少過12個人 / 唔多過12人 / 不超過12位 / 最多40人 each read max=12/12/12/40 AND the party size.
#: A word-cue amount followed by a counter is not money.
_PARTY_AFTER = re.compile(r"\s*(?:個|个|位|人|people|pax|persons?|guests?|diners?)", re.IGNORECASE)


def _budget_amount(text: str, m: "re.Match[str] | None") -> float | None:
    """The amount a cue-first budget rule read, or None when those digits count a party.

    Every rule below writes its digits in one of several groups (a ceiling may put the currency
    before or after the number), so the first non-empty group is the amount.
    """
    if m is None:
        return None
    for i in range(1, m.re.groups + 1):
        if not m.group(i):
            continue
        if _PARTY_AFTER.match(text, m.end(i)):
            return None
        return float(m.group(i))
    return None


#: D628: the phrases that name no content. A price and a party size are consumed by their own
#: lanes and no row can contain them, so matching them does not find anything - it divides every
#: row's relevance by a term nobody can meet. Measured on the seeded plane 2026-10-30
#: (`tmp/d628_shapes.txt`), `kw_score` for the whole sentence against the rows it retrieves:
#:
#:     餐廳                  1.00
#:     100蚊以下嘅餐廳        0.325
#:     人均100以下嘅餐廳      0.200
#:     4個人嘅餐廳            0.343 / 0.200
#:
#: D633: and the words that belong to the amount ITSELF. Every budget regex above stops at the
#: digits, so 「最多1000蚊嘅餐廳」 was stripped to 「蚊嘅餐廳」 and 「最多1000-2000嘅餐廳」 to
#: 「最多 嘅餐廳」 - the cue and the unit stay in the match text, where they divide every row's
#: relevance by a term no row can meet. Measured (`tmp/d633_residue.txt`): 0 of the 470 published
#: rows carry 蚊, 元, 塊, 最多, 唔超過 or 不超過 anywhere in name, description or tags.
#:
#: Both rules run AFTER the amount is gone, which is what makes them exact rather than a guess: the
#: strip replaces a span with a SPACE, so a unit word that belonged to a consumed amount now sits
#: against whitespace (「最多1000蚊」 consumed 蚊 with its span under D633; the unit rule only
#: catches an amount the range rule left behind), and a cue sits where the span began.
#: 「最多人」 is content and
#: stays. The cue list is `BUDGET_WORD_RE`'s own CJK cues minus 以下/以內, which
#: `SPEND_CEILING_RE` already carries whole.
#: D636: and the two cue families added that day, because the PARTY strip strands them too -
#: 「多過4人嘅餐廳」 is left as 「多過 餐廳」, a cue against whitespace, and 「at most 12 people」 as
#: 「at most」. Same predicate as above: only a cue that a strip left against whitespace goes.
_MATCH_CORE_RESIDUE = (
    re.compile(r"(?<=\s)(?:蚊|元|塊|块)(?=[\s嘅的，,、?？]|$)", re.IGNORECASE),
    re.compile(r"(?:唔多過|不多過|最多|唔超過|不超过|不超過|少於|低於|高於|至多|頂多|起碼|貴過|"
               r"少過|多過|平過|便宜過|唔貴過|不貴过)(?=[\s嘅的]|$)",
               re.IGNORECASE),
)
#:
#: so a user who states a budget is served the page the DILUTED score chose. The strip below removes
#: exactly those spans; nothing else - a constraint that IS content (`安靜` in `安靜嘅咖啡店`) stays.
#: D633: the PARTY span is read FIRST - a party range and a budget range share the shape N-M, and
#: the money rule used to take 「10至20」 out of 「10至20人」 and leave the counter behind.
_MATCH_CORE_RES = (PARTY_SPAN_RE, BUDGET_RANGE_RE, SPEND_CEILING_RE, SPEND_FLOOR_RE,
                   PER_PERSON_POINT_RE, BUDGET_MAX_RE, BUDGET_WORD_RE, BUDGET_CEILING_CUE_RE,
                   BUDGET_FLOOR_CUE_RE, BUDGET_MIN_RE, CURRENCY_AMOUNT_RE)
_MATCH_CORE_CUES = re.compile(r"(?:預算|预算|budget|人均|每人|每位|人頭|per\s?person|p/p)",
                              re.IGNORECASE)
_MATCH_CORE_EDGES = re.compile(r"^[\s嘅的，,、。?？]+|[\s嘅的，,、。?？]+$")


_SHOP_SUFFIX_AFTER = re.compile(r"(?:店|舖|鋪|shop|store)(?![a-z])", re.IGNORECASE)


def _strip_surface_spans(text: str, surfaces: Sequence[str]) -> str:
    """Blank out every span one of `surfaces` occupies, found through the ONE matcher (D481).

    D635: a category is answered by a FILTER, so the word that named it is not a search term - and
    the word the user wrote is not always the table's spelling (餐廳/餐厅, 咖啡店/咖啡店). The positions are
    read off the CANONICAL text, which is character-for-character the same length as the user's
    (`CANONICAL_FORMS` maps one character to one character - pinned by the gate), so a span found
    there is the same span here and the user's own spelling is what gets blanked.
    """
    if not surfaces:
        return text
    from nexus_ai.nlu.canonical import canonical

    canon = canonical(text)
    low = canon.lower()
    spans: set[tuple[int, int]] = set()
    for surface in surfaces:
        for start in cue_positions(surface, canon, low):
            spans.add((start, start + len(surface)))
    if not spans:
        return text
    chars = list(text)
    for start, end in spans:
        # D639: a generic shop noun that FOLLOWS the removed word belongs to it - 「火鍋店」 is the
        # hotpot surface plus the suffix, and the suffix alone is a term 246 of the 470 published
        # rows carry, so leaving it divides the hotpot pool by whether a name happens to say 店.
        # The suffix is absorbed only where a surface was just removed; 「燒味店」 (no leaf, no
        # category surface of its own) leaves the 店 its own strip found.
        suffix = _SHOP_SUFFIX_AFTER.match(text, end)
        if suffix:
            end = suffix.end()
        for i in range(start, min(end, len(chars))):
            chars[i] = " "
    return "".join(chars)


def match_core(text: str, *, strip_time: bool = False,
               strip_surfaces: Sequence[str] = ()) -> str:
    """The part of a sentence that names WHAT to find, with the spans a lane already handles removed.

    Returns "" when nothing is left - the caller keeps the original text in that case, because a
    request that is ONLY a constraint (「4個人」) is still a request.

    `strip_time` is set by the caller when the time lane PARSED a time: the cue words can be
    content (下午茶), so they are not removed on a guess.
    `strip_surfaces` is the category lane's own answer (`lexicon.category_surfaces`): the
    spellings of the bucket the sentence is about, which its filter has already selected
    (D635). It is empty when no bucket was named or the text named a different one.
    """
    t = text or ""
    if strip_time:
        t = TIME_SPAN_RE.sub(" ", t)
    t = _strip_surface_spans(t, strip_surfaces)
    for rx in _MATCH_CORE_RES:
        t = rx.sub(" ", t)
    for rx in _MATCH_CORE_RESIDUE:
        t = rx.sub(" ", t)
    t = _MATCH_CORE_CUES.sub(" ", t)
    t = _MATCH_CORE_EDGES.sub("", re.sub(r"\s+", " ", t).strip())
    return t.strip()


def _fill_budget(ex: IntentExtraction, text: str) -> IntentExtraction:
    budget: dict[str, Any] = {"min": None, "max": None, "currency": "HKD", "per": None}
    found = False
    rng = BUDGET_RANGE_RE.search(text)
    # D631: the cue may sit DIRECTLY against the digits - 「預算1000-2000」 is the shape a HK user
    # writes, and the window used to stop one character PAST the span's start, so the cue ended on
    # a digit and the band was dropped (read as the ceiling 1000: `tmp/d631_mechanism.txt`). It
    # worked for a Latin cue only because a space separated it from the number.
    low = (text[:rng.start()] if rng else "")
    if rng and (_range_is_money(rng.group(0), low)):
        ends = sorted((float(rng.group(1)), float(rng.group(2))))
        budget["min"], budget["max"] = ends
        ex.confidence["budget"] = 0.9
        found = True
    # D636: the two cue families the ceiling had no rule for (至多/頂多/不多過/少於/低於,
    # `at most`, `no more than`, `up to`), read through the same party guard as the rest.
    for rx in (() if found else (BUDGET_MAX_RE, BUDGET_WORD_RE, BUDGET_CEILING_CUE_RE,
                                 SPEND_CEILING_RE)):
        amount = _budget_amount(text, rx.search(text))
        if amount is not None:
            budget["max"] = amount
            ex.confidence["budget"] = 0.9 if rx is BUDGET_MAX_RE else 0.85
            found = True
            break
    if not found:
        m = CURRENCY_AMOUNT_RE.search(text)
        if m and any(cue_in(w, text, text.lower()) for w in OPEN_PRICE_WORDS):
            budget["max"] = float(m.group(1))
            ex.confidence["budget"] = 0.8
            found = True
    if not found:
        # D636: and the floor's own (多過/貴過/起碼/高於, `more than`) ahead of the amount-first
        # shape, so 「起碼1000蚊」 is a floor instead of nothing.
        for rx in (BUDGET_FLOOR_CUE_RE, SPEND_FLOOR_RE):
            amount = _budget_amount(text, rx.search(text))
            if amount is not None:
                budget["min"] = amount
                ex.confidence["budget"] = 0.85
                found = True
                break
    if not found:
        m = PER_PERSON_POINT_RE.search(text)
        if m:
            budget["max"] = float(m.group(1))
            ex.confidence["budget"] = 0.8
            found = True
    if not found:
        amount = _budget_amount(text, BUDGET_MIN_RE.search(text))
        if amount is not None:
            budget["min"] = amount
            ex.confidence["budget"] = 0.8
            found = True
    if found:
        if PER_PERSON_RE.search(text):
            budget["per"] = "person"
        elif PER_ITEM_RE.search(text):
            budget["per"] = "item"
        else:
            budget["per"] = "party"
        ex.budget = budget
    return ex


def _fill_party(ex: IntentExtraction, text: str, context: dict[str, Any]) -> IntentExtraction:
    ctx_party = context.get("party_size")
    if ctx_party:
        try:
            ex.party_size = int(ctx_party)
            ex.confidence["party_size"] = 0.95
            return ex
        except (TypeError, ValueError):
            pass
    n = party_size_of(text)
    if n is not None:
        ex.party_size = n
        ex.confidence["party_size"] = 0.9
    # NOTE: "情侣"/"date" is deliberately NOT turned into party_size=2. §8 forbids
    # guessing it and AGENT_CONTRACT §1 lists inventing party_size as a must-not.
    return ex


def _fill_preferences(ex: IntentExtraction, text: str) -> IntentExtraction:
    """Resolve the preferences, then let the SENTENCE say which way each one points.

    D393: the lexicon gives every rule a fixed polarity (+1), but a user who says
    "\u55b8\u597d\u5b89\u975c" (not quiet) is expressing a dislike. The surface token that
    matched is remembered, because the canonical value ("quiet") is not in a Chinese
    sentence while the token that matched it ("\u5b89\u975c") is.
    """
    low = text.lower()
    seen: set[tuple[str, str]] = set()
    matched_tokens: dict[tuple[str, str], str] = {}
    for key, value, tokens, polarity in PREFERENCE_RULES:
        for tok in tokens:
            t = tok.lower()
            # D480: the ONE matcher - "view" inside "review" is not a view the user
            # asked for, and "solo" inside "console" is not a solo dinner.
            if t and cue_in(tok, text, low) and (key, value) not in seen:
                seen.add((key, value))
                ex.preferences.append({"key": key, "value": value, "polarity": polarity})
                matched_tokens[(key, value)] = tok
                break
    # D522: `apply_polarity` re-stamps EVERY preference on the Intent, and the cuisine ones
    # were put there by `_fill_category` without the surface term that matched them - so the
    # reader fell back to the canonical value, a word that is not in a Chinese sentence, and
    # a negation the user typed was never seen. Measured: "素食唔好", "唔好素食",
    # "不想吃海鲜", "不要日料" all came back polarity +1 - a LIKE of the
    # very cuisine the user refused, which the ranking lane then boosts. The English rows
    # worked only by luck of that fallback: "no seafood" carries the value in the sentence.
    for cuisine, term in match_cuisine_terms(text):
        matched_tokens.setdefault(("cuisine", cuisine), term)
    ex.preferences = apply_polarity(ex.preferences, text, matched_tokens)
    return ex


def constraint_hits(text: str) -> list[tuple[str, str]]:
    """Every (key, canon value) refusal the clause rule reads out of the text.

    D536 replaced the lane's eight-character window with the clause rule; D539 gave it
    the backward direction. D541 makes this the ONE reader both of the module's
    questions about a refusal are answered by - what the search plan filters for, and
    whether the turn is a discovery at all - so the two can no longer disagree about
    one sentence.
    """
    hits: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    low = (text or "").lower()
    for key, negs, values in CONSTRAINT_RULES:
        for neg in negs:
            # D480: the ONE matcher, for the negation and for the value - "no" inside
            # "notebook" is not a negation. `negation_positions` adds the two refusals
            # the spelling alone cannot tell: 有冇's verb (D533) and 特別's tail.
            cue = neg.strip()
            for start in negation_positions(cue, text, low):
                after = start + len(cue)
                for v in values:
                    value = v.strip()
                    # D536: the clause, not a window. The value must sit in the cue's
                    # own clause, and one verb may bridge the two - "don't WANT spicy"
                    # refuses the spicy, while "no rush want spicy" refuses nothing.
                    for at in cue_positions(value, text, low):
                        if at < after:
                            # D539: the value sits BEFORE the cue - "咖喱唔要" refuses
                            # the curry. The gap keeps every separator in it, because
                            # there the comma really did end the value's clause
                            # ("辣，唔好" leaves the 辣 alone), and the cue must govern
                            # nothing after it in its own clause - a cue with an object
                            # of its own keeps that object (D537).
                            if not (at + len(value) <= start
                                    and clause_attached(low[at + len(value):start])
                                    and clause_final(low, start, cue)):
                                continue
                        # D538: the separator directly under the cue is the cue's own
                        # punctuation; one anywhere else in the gap is a clause boundary.
                        elif not clause_attached(forward_gap(low, after, at)):
                            continue
                        canon = canon_constraint(v)
                        if (key, canon) not in seen:
                            seen.add((key, canon))
                            hits.append((key, canon))
                        break
    return hits


def _fill_constraints(ex: IntentExtraction, text: str) -> IntentExtraction:
    """A refusal inside a clause writes that clause's constraint: "唔食辣" ⇒ constraint, "食辣" ⇒ preference (§8).

    D536: the lane read an eight-character window past the cue, and the cue's own
    trailing space was stripped before the offset was measured - so the value had
    seven characters of room. A character count is not a clause: "no cilantro" and
    "no coriander" wrote no constraint at all, and neither did "don't want spicy".
    Widening the window was measured and rejected - at sixteen it reads "no rush want
    spicy" as a refusal of the spicy, because both clauses' words sit inside it. So
    the window is a guess at a grammar, and the lane now reads a refusal the way the
    polarity lane reads one (D535): the cue governs a value in its own clause, and one
    verb may bridge the two. The two arms were then run against each other over the
    sentences the product's own refusal tests speak - the clause rule wrote every
    constraint the window wrote, and lost none; what it gains is the reach a clause
    gives that eight characters never did, and every surface form the product's own
    CONSTRAINT_CANON names, which the census in this unit's test file now holds open.

    D538: the normalizer writes a clause separator where a comma was, and the lane reads
    it the way the polarity lane does. The one that sits directly under the cue is the
    cue's own punctuation - "唔好，辣" refuses the 辣 - and `forward_gap` takes it out of
    the way; one anywhere else in the gap is the boundary between two clauses, and the
    value on the far side of it is not refused ("唔好辣，想找個安靜的咖啡店" refuses the
    spicy and nothing else). Before the separator existed both sentences arrived as one
    string and the lane could not tell them apart either.

    D539: the lane reads BACKWARD too. A refusal written the Cantonese way puts the
    value first - "咖喱唔要" refuses the curry - and the forward-only lane answered
    nothing for every one of those sentences while the preference lane read the same
    refusal. Three conditions, each the mirror of a rule the polarity lane already
    reads: the gap between the value and the cue keeps EVERY separator in it (there
    the comma really did end the value's clause - "辣，唔好" leaves the 辣 alone,
    which is why this is not `forward_gap`), the cue must be final in its own clause
    (a cue with an object after it keeps that object, D537), and the existential
    question is exempt (D533).
    """
    for key, canon in constraint_hits(text):
        ex.constraints.append({"key": key, "value": canon})
    return ex


def _fill_sort(ex: IntentExtraction, text: str) -> IntentExtraction:
    low = text.lower()
    # D480: the ONE matcher - "under" inside "underground" is not a price hint, and a
    # compare cue read out of a word is not a compare turn.
    if any(cue_in(c, text, low) for c in COMPARE_CUES) \
            and len(_extract_entities(text)) >= 2:
        ex.sort_preference = "relevance"
        return ex
    for pref, tokens in SORT_RULES:
        if any(cue_in(t, text, low) for t in tokens):
            ex.sort_preference = pref
            ex.confidence["sort_preference"] = 0.8
            break
    return ex


def _fill_urgency(ex: IntentExtraction, text: str) -> IntentExtraction:
    low = text.lower()
    # D480: the ONE matcher - "now" inside "know" is not an urgent query.
    if any(cue_in(t, text, low) for t in URGENCY_NOW):
        ex.urgency = "now"
    elif any(cue_in(t, text, low) for t in URGENCY_FLEXIBLE):
        ex.urgency = "flexible"
    return ex


_COMPARE_TAILS = ("these", "the", "them")
_ENTITY_SEPARATORS = ("同埋", "vs.", "vs", "versus", " and ", "，", ",")


def _extract_entities(text: str) -> list[str]:
    """The 2-3 things a `compare` / `ask_merchant` turn points at.

    Quoted names win; otherwise the tail after the compare cue is split on
    conjunctions. Names are NOT resolved to merchants here — that is the search tool's
    job, so an unresolvable name simply stays a string (§8).
    """
    quoted = [q.strip() for q in quoted_entities(text) if len(q.strip()) >= 2]
    if len(quoted) >= 2:
        return quoted[:3]
    low = (text or "").lower()
    # D479: the cue's position is found with the ONE matcher, over the whole compare
    # table. The list that stood here held six of the table's cues, so the other nine
    # ("which", "vs", "versus", and four Chinese ones) could never find their position -
    # and a compare turn naming two things with one of them got no compare intent.
    cue_at = -1
    cue_len = 0
    for cue in COMPARE_CUES:
        for pos in cue_positions(cue, text, low):
            if cue_at < 0 or pos < cue_at:
                cue_at, cue_len = pos, len(cue)
    if cue_at < 0:
        return quoted[:3]
    # The tail is what FOLLOWS the cue. The old code took the first WHITESPACE token of
    # the text from the cue onwards, which is the cue itself for a latin cue ("compare
    # A and B") but the WHOLE string for a Chinese one - so a Chinese compare
    # ("compare Central and Mong Kok") had no tail at all, no entities, and no compare
    # intent. The cue's own LENGTH is what the tail starts after.
    tail = text[cue_at + cue_len:].strip()
    first = tail.split(" ", 1)
    if first and first[0].lower() in _COMPARE_TAILS:
        tail = first[1] if len(first) > 1 else ""
    norm = " " + tail + " "
    for sep in _ENTITY_SEPARATORS:
        norm = norm.replace(sep, " | ")
        norm = norm.replace(sep.upper(), " | ")
        norm = norm.replace(sep.title(), " | ")
    for cjk_sep in ("同", "和", "与", "及"):
        norm = norm.replace(cjk_sep, " | ")
    parts = [p.strip(" .。、?!！~") for p in norm.split("|")]
    parts = [p for p in parts if len(p) >= 2]
    if len(parts) >= 2:
        return parts[:3]
    return quoted[:3]


def _compute_unknowns(ex: IntentExtraction) -> list[str]:
    """§8: list what a competent answer still needs. Never fill it in ourselves."""
    unknowns: list[str] = []
    if ex.intent == "unknown":
        unknowns.append("intent")
    if ex.intent in ("discover_merchant", "discover_offering", "reserve") and not ex.category:
        unknowns.append("category")
    if ex.intent in ("discover_merchant", "reserve", "plan_experience"):
        if not ex.location:
            unknowns.append("location")
        elif ex.location.get("type") == "nearby" and not ex.location.get("resolved"):
            unknowns.append("location")
    if ex.intent == "reserve" and ex.party_size is None:
        unknowns.append("party_size")
    if ex.intent == "reserve" and not ex.time:
        unknowns.append("time")
    # stable order, deduped
    seen: set[str] = set()
    out: list[str] = []
    for u in unknowns:
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out
