"""Deterministic query understanding to the §7.1 `Intent` schema.

This is the engine behind `MockAdapter`'s `intent_extract` task, and also the *floor*
the real providers are checked against: the rule path always runs, and its per-field
confidence is what lets us honour §8 "不要强行猜测" — a field we cannot resolve stays
`null` and is listed in `unknowns`, never filled in with a plausible-looking default.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from nexus_ai.nlu.lexicon import (
    canon_constraint,
    COMPARE_CUES,
    NEARBY_TERMS,
    PREFERENCE_RULE_VALUES,
    proper_nouns,
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
    match_cuisines,
    match_district,
    normalize_query,
)
from nexus_ai.nlu.timeparse import HK_TZ, parse_time

# --------------------------------------------------------------------------- patterns
BUDGET_MAX_RE = re.compile(
    r"(?:预算|預算|budget)\s*(?:系|是|為|为)?\s*(?:最多|唔超過|不超过|內|內|以内|以內)?\s*"
    r"(?:hk\$|hkd|港幣|港币|蚊|\$)?\s*(\d{2,5})(?:\.\d{1,2})?",
    re.IGNORECASE,
)
BUDGET_WORD_RE = re.compile(
    r"(?:under|less than|below|within|max|最多|唔超過|不超过|以下|以內|以内|少過|唔多過)\s*"
    r"(?:hk\$|hkd|港幣|港币|\$)?\s*(\d{2,5})",
    re.IGNORECASE,
)
BUDGET_MIN_RE = re.compile(
    r"(?:over|above|at least|超過|超过|以上|最少|至少)\s*(?:hk\$|hkd|\$)?\s*(\d{2,5})"
    r"|(?:hk\$|hkd|\$)\s*(\d{2,5})\s*(?:以上|over|起跳)",
    re.IGNORECASE,
)
CURRENCY_AMOUNT_RE = re.compile(
    r"(?:hk\$|hkd|港幣|港币)\s*(\d{2,5})(?:\.\d{1,2})?", re.IGNORECASE
)
PER_PERSON_RE = re.compile(r"(?:每人|人均|per ?person|p/?p|per head|人頭)", re.IGNORECASE)
PER_ITEM_RE = re.compile(r"(?:每件|每款|each|per item|一双|一对|一對)", re.IGNORECASE)

#: CJK counters need no trailing boundary (they are word chars); latin units do.
PARTY_RE = re.compile(
    r"(?:\D|^)\s*(?:我哋|我們|我们)?\s*(\d{1,2})\s*(?:個|个|位|人)"
    r"|(?:party(?:\s*of)?|for)\s*(\d{1,2})\b"
    r"|(\d{1,2})\s*(?:people|pax|persons?|guests|diners)\b",
    re.IGNORECASE,
)
RADIUS_RE = re.compile(
    r"(\d{1,3})\s*(?:公里|公里|km|千米)", re.IGNORECASE
)
METERS_RE = re.compile(r"(\d{3,5})\s*(?:米|m\b)", re.IGNORECASE)
WALK_MIN_RE = re.compile(r"(?:行|walk|步行|走)\s*(\d{1,2})\s*(?:分鐘|分钟|min|minute)", re.IGNORECASE)

OPEN_PRICE_WORDS = ("預算", "预算", "budget", "price", "價錢", "价钱", "多少錢", "多少钱", "平", "貴", "贵")


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
            "preferences": self.preferences,
            "constraints": self.constraints,
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

    ex.language = str(context.get("locale") or detect_language(text))
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
    has = lambda cues: any(c.lower() in low for c in cues)  # noqa: E731

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
    elif has(DISCOVER_CUES) or _looks_like_discovery(text):
        ex.intent, ex.confidence["intent"] = "discover_merchant", 0.75
    elif match_category(text) or match_cuisines(text) or has(NEARBY_TERMS)             or has(PREFERENCE_RULE_VALUES) or _has_budget_word(text):
        # "预算 300 港币，想吃日料" names *what* they want without a discovery verb.
        ex.intent, ex.confidence["intent"] = "discover_merchant", 0.6
    else:
        ex.intent, ex.confidence["intent"] = "unknown", 0.2
    return ex


def _looks_like_discovery(text: str) -> bool:
    return bool(re.search(r"(搵|找|推薦|推荐|邊間|邊度|哪间|哪裡|哪里|find|recommend|where|any)",
                          text, re.IGNORECASE))


#: A stated price/quantity limit with no discovery verb is still a discovery request.
_BUDGET_WORDS = ("預算", "预算", "budget", "hk$", "hkd", "港幣", "港币", "蚊", "too expensive",
                 "cheap", "平啲", "貴啲", "under", "within", "less than", "以內", "以内")


def _has_budget_word(text: str) -> bool:
    low = (text or "").lower()
    return any(w in low for w in _BUDGET_WORDS)


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

        # cuisine_like: {values: [...]} -> the category that cuisine lives in
        if key == "cuisine_like" and isinstance(value, dict):
            for cuisine in value.get("values") or []:
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
    nearby = any(t.lower() in low for t in NEARBY_TERMS)
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


def _fill_budget(ex: IntentExtraction, text: str) -> IntentExtraction:
    budget: dict[str, Any] = {"min": None, "max": None, "currency": "HKD", "per": None}
    found = False
    for rx in (BUDGET_MAX_RE, BUDGET_WORD_RE):
        m = rx.search(text)
        if m:
            budget["max"] = float(m.group(1))
            ex.confidence["budget"] = 0.9 if rx is BUDGET_MAX_RE else 0.85
            found = True
            break
    if not found:
        m = CURRENCY_AMOUNT_RE.search(text)
        if m and any(w in text.lower() for w in OPEN_PRICE_WORDS):
            budget["max"] = float(m.group(1))
            ex.confidence["budget"] = 0.8
            found = True
    if not found:
        m = BUDGET_MIN_RE.search(text)
        if m:
            budget["min"] = float(m.group(1) or m.group(2))
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
    m = PARTY_RE.search(text)
    if m:
        raw = next((g for g in m.groups() if g), None)
        n = int(raw)
        if 1 <= n <= 40:
            ex.party_size = n
            ex.confidence["party_size"] = 0.9
    # NOTE: "情侣"/"date" is deliberately NOT turned into party_size=2. §8 forbids
    # guessing it and AGENT_CONTRACT §1 lists inventing party_size as a must-not.
    return ex


def _fill_preferences(ex: IntentExtraction, text: str) -> IntentExtraction:
    low = text.lower()
    seen: set[tuple[str, str]] = set()
    for key, value, tokens, polarity in PREFERENCE_RULES:
        for tok in tokens:
            t = tok.lower()
            if t and t in low and (key, value) not in seen:
                seen.add((key, value))
                ex.preferences.append({"key": key, "value": value, "polarity": polarity})
                break
    return ex


def _fill_constraints(ex: IntentExtraction, text: str) -> IntentExtraction:
    """Negation window only: "唔食辣" ⇒ constraint, "食辣" ⇒ preference (§8)."""
    seen: set[tuple[str, str]] = set()
    for key, negs, values in CONSTRAINT_RULES:
        for neg in negs:
            for m in re.finditer(re.escape(neg.strip()), text):
                window = text[m.end(): m.end() + 8]
                for v in values:
                    if v.strip() in window:
                        canon = canon_constraint(v)
                        if (key, canon) in seen:
                            continue
                        seen.add((key, canon))
                        ex.constraints.append({"key": key, "value": canon})
    return ex


def _fill_sort(ex: IntentExtraction, text: str) -> IntentExtraction:
    low = text.lower()
    if any(c.lower() in low for c in COMPARE_CUES) and len(_extract_entities(text)) >= 2:
        ex.sort_preference = "relevance"
        return ex
    for pref, tokens in SORT_RULES:
        if any(t.lower() in low for t in tokens):
            ex.sort_preference = pref
            ex.confidence["sort_preference"] = 0.8
            break
    return ex


def _fill_urgency(ex: IntentExtraction, text: str) -> IntentExtraction:
    low = text.lower()
    if any(t.lower() in low for t in URGENCY_NOW):
        ex.urgency = "now"
    elif any(t.lower() in low for t in URGENCY_FLEXIBLE):
        ex.urgency = "flexible"
    return ex


_COMPARE_CUES_LOW = ("比較", "比较", "対比", "对比", "邊間好", "边间好")
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
    cue_at = -1
    for cue in _COMPARE_CUES_LOW:
        pos = low.find(cue.lower())
        if pos >= 0:
            cue_at = pos if cue_at < 0 else min(cue_at, pos)
    if cue_at < 0:
        for token in ("compare", "contrast"):
            pos = low.find(token)
            if pos >= 0:
                cue_at = pos if cue_at < 0 else min(cue_at, pos)
    if cue_at < 0:
        return quoted[:3]
    tail = (text[cue_at:][len(text[cue_at:].split()[0]):] if text[cue_at:].split() else "")
    tail = tail.strip()
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
    if ex.intent == "compare" and len(ex.mentioned_entities) < 2:
        unknowns.append("compare_targets")
    # stable order, deduped
    seen: set[str] = set()
    return [u for u in unknowns if not (u in seen or seen.add(u))]
