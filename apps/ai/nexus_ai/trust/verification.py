"""Post-hoc claim verification — AGENT_CONTRACT §4 last bullet (spec §72 hallucination rate).

> "LLM output is post-validated: every numeric/entity claim in generated text is matched
> back to retrieved facts; unmatched claims are stripped and counted in
> `hallucination_rate`. This is the single most important quality gate in the product."

How it works
------------
`extract_claims` tokenises generated copy into *claims*: money, ratings, distances, travel
minutes, clock times, counts, percentages and quoted entity names, each with the exact span
it occupied. `build_ground_set` flattens a `FactBundle` (plus explicitly allowed request
numbers such as the user's own budget or the result count) into comparable scalars.
`verify_claims` matches each claim against the ground set with a per-kind tolerance, and
`verify_text` returns a `VerificationReport` whose `text` has every ungrounded claim removed
— so an ungrounded price can never reach a screen, and the removal count is what the eval
suite reports as `hallucination_rate`.

Tolerances exist because copy rounds: "700m" grounds to a computed 683m, "4.7" to 4.65.
They are deliberately tight (2% on money, 0.06 on ratings) so a *fabricated* price such as
"HK$500" against a grounded 320 is caught, which is the behaviour the unit test pins down.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Sequence

from nexus_ai.nlu.matching import cue_in
from nexus_ai.trust.facts import FactBundle

MONEY_KIND = "money"
RATING_KIND = "rating"
DISTANCE_KIND = "distance"
MINUTES_KIND = "minutes"
TIME_KIND = "time"
COUNT_KIND = "count"
PERCENT_KIND = "percent"
NUMBER_KIND = "number"
ENTITY_KIND = "entity"

CLIPBOARD_MONEY_RE = re.compile(
    r"(?:HK\$|H\$|HKD\s*|港幣|港币|[$￥¥])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)"
    r"|(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:蚊|元|港幣|港币|HKD|hkd)")
TIME_RE = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
DISTANCE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(公里|千米|km\b|米|m\b|meters?|metres?)",
                         re.IGNORECASE)
MINUTES_RE = re.compile(r"(\d{1,3})\s*(分鐘|分钟|mins?\b|minutes?\b|min\b)", re.IGNORECASE)
RATING_RE = re.compile(r"(?:評分|评分|rating|得分)\s*[:：]?\s*(\d\.\d{1,2})|\b([0-5]\.\d)\s*(?:/|五|out of)\s*[5五]|星\b")
PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
COUNT_RE = re.compile(r"(\d{1,4})\s*(?:個|个|條|条|家|間|间|款|位|則|则|篇|reviews?|items?|results?| Choices|選擇|选择)",
                      re.IGNORECASE)
BARE_NUMBER_RE = re.compile(r"(?<![\w.:$])(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)(?![\w.,:]*\s*(?:HKD|港幣|港币|蚊|元|am|pm|%))",
                            re.IGNORECASE)
QUOTED_ENTITY_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"「([^」\n]{2,40})」"),
    re.compile(r"『([^』\n]{2,40})』"),
    re.compile(r"\"([^\n\"]{2,60})\""),
    re.compile(r"“([^”\n]{2,60})”"),
    re.compile(r"《([^》\n]{2,60})》"),
)

# D449: the kind order used to stand here, and nothing read it. The verification walks
# the kinds it knows about in its own order.

#: how far a copy value may sit from a grounded value and still be the same fact
TOLERANCE: dict[str, tuple[float, float]] = {
    MONEY_KIND: (0.02, 1.0),
    RATING_KIND: (0.0, 0.06),
    DISTANCE_KIND: (0.06, 60.0),
    MINUTES_KIND: (0.05, 1.0),
    COUNT_KIND: (0.0, 0.0),
    PERCENT_KIND: (0.0, 0.5),
    NUMBER_KIND: (0.01, 0.5),
}

ENTITY_STOPWORDS = frozenset({
    "the", "and", "for", "you", "your", "this", "that", "with", "near", "best",
    "nexus", "sponsored", "demo",
})


@dataclass
class Claim:
    """One verifiable assertion inside generated copy."""

    kind: str
    text: str
    start: int
    end: int
    value: float | None = None
    norm: str | None = None
    unit: str | None = None
    grounded: bool = False
    fact_id: Any | None = None
    grounded_value: float | str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "text": self.text, "value": self.value,
                "norm": self.norm, "grounded": self.grounded,
                "fact_id": str(self.fact_id) if self.fact_id else None,
                "grounded_value": self.grounded_value}


@dataclass
class GroundSet:
    """Every scalar the text is allowed to assert, with the fact that backs it."""

    numbers: list[tuple[float, str, Any]] = field(default_factory=list)   # (value, attribute, fact_id)
    strings: set[str] = field(default_factory=set)                         # times, names, labels
    times: set[int] = field(default_factory=set)                           # minute-of-day
    entities: set[str] = field(default_factory=set)                        # normalised names

    def add_number(self, value: float, attribute: str, fact_id: Any = None) -> None:
        self.numbers.append((float(value), attribute, fact_id))

    def add_string(self, value: str) -> None:
        v = value.strip()
        if v:
            self.strings.add(v)
            self.strings.add(v.lower())
            as_time = _clock_to_minutes(v)
            if as_time is not None:
                self.times.add(as_time)

    def add_entity(self, name: str | None) -> None:
        n = normalize_entity(name or "")
        if n and len(n) > 1:
            self.entities.add(n)

    def find(self, claim: Claim) -> tuple[bool, Any, float | str | None]:
        """(grounded, backing fact_id, grounded value)."""
        if claim.kind == ENTITY_KIND:
            hit = _entity_match(claim.norm or "", self.entities)
            return (hit, None, claim.norm if hit else None)
        if claim.kind == TIME_KIND:
            if claim.norm and (claim.norm in self.strings
                               or _norm_clock(claim.norm) in self.strings):
                return (True, None, claim.norm)
            if claim.value is not None and int(claim.value) in self.times:
                return (True, None, claim.value)
            return (False, None, None)
        if claim.value is None:
            return (False, None, None)
        rel, abs_tol = TOLERANCE.get(claim.kind, TOLERANCE[NUMBER_KIND])
        best: tuple[float, Any, float] | None = None
        for value, _attr, fact_id in self.numbers:
            diff = abs(value - claim.value)
            if diff <= max(abs_tol, rel * abs(value)):
                if best is None or diff < best[0]:
                    best = (diff, fact_id, value)
        if best is not None:
            return (True, best[1], best[2])
        # an ISO timestamp in copy is grounded if its clock is, or the exact text is stored
        if claim.norm and claim.norm in self.strings:
            return (True, None, claim.norm)
        return (False, None, None)


def build_ground_set(bundle: FactBundle | None = None, *,
                    extra_numbers: Iterable[float] = (),
                    extra_strings: Iterable[str] = (),
                    entities: Iterable[str] = (),
                    records: Iterable[dict[str, Any]] = ()) -> GroundSet:
    gs = GroundSet()
    for fact in (bundle.facts if bundle else []):
        for raw in _scalars(fact.value):
            _feed(gs, raw, fact.attribute, fact.fact_id)
        if fact.attribute:
            gs.add_string(str(fact.attribute))
    for rec in records:
        for key, val in _flatten(rec):
            _feed(gs, val, str(key), None)
        for key in ("display_name", "name", "title", "display_name_zh", "name_zh", "slug"):
            if rec.get(key):
                gs.add_entity(str(rec[key]))
    for n in extra_numbers:
        try:
            gs.add_number(float(n), "request", None)
        except (TypeError, ValueError):
            continue
    for s in extra_strings:
        gs.add_string(str(s))
    for e in entities:
        gs.add_entity(str(e))
    return gs


def _feed(gs: GroundSet, raw: Any, attribute: str, fact_id: Any) -> None:
    text = str(raw)
    num = _to_float(text)
    kind = _attr_kind(attribute)
    if num is not None and kind in (MONEY_KIND, RATING_KIND, DISTANCE_KIND, MINUTES_KIND,
                                    COUNT_KIND, PERCENT_KIND, NUMBER_KIND):
        gs.add_number(num, attribute, fact_id)
    if num is not None and attribute in ("avg_price_hkd", "price_amount", "price",
                                        "rating", "rating_agg", "distance_m", "meters",
                                        "capacity_left", "party_size", "min_spend"):
        gs.add_number(num, attribute, fact_id)
    gs.add_string(text)
    if isinstance(raw, datetime):
        gs.add_number(raw.timestamp(), attribute, fact_id)


# --------------------------------------------------------------------- extraction
def extract_claims(text: str) -> list[Claim]:
    """Every numeric/entity assertion in `text`, in document order, non-overlapping."""
    if not text:
        return []
    found: list[Claim] = []
    for rx, maker in (
        (CLIPBOARD_MONEY_RE, _money_claim),
        (TIME_RE, _time_claim),
        (DISTANCE_RE, _distance_claim),
        (MINUTES_RE, _minutes_claim),
        (RATING_RE, _rating_claim),
        (PERCENT_RE, _percent_claim),
        (COUNT_RE, _count_claim),
    ):
        for m in rx.finditer(text):
            claim = maker(m)
            if claim is not None:
                found.append(claim)
    for rx in QUOTED_ENTITY_RES:
        for m in rx.finditer(text):
            inner = m.group(1)
            if _to_float(inner) is not None:
                continue
            found.append(Claim(kind=ENTITY_KIND, text=m.group(0), start=m.start(),
                               end=m.end(), norm=normalize_entity(inner), value=None))
    # anything left that looks like a bare number is still a claim: it must be grounded too
    claimed_spans = [(c.start, c.end) for c in found]
    for m in BARE_NUMBER_RE.finditer(text):
        if any(m.start() < e and m.end() > s for s, e in claimed_spans):
            continue
        value = _to_float(m.group(1))
        if value is None:
            continue
        found.append(Claim(kind=_bare_kind(text, m.start(), m.end()), text=m.group(0),
                           start=m.start(), end=m.end(), value=value,
                           norm=m.group(1)))
    found.sort(key=lambda c: (c.start, -(c.end - c.start)))
    out: list[Claim] = []
    last_end = -1
    for c in found:
        if c.start < last_end:
            continue  # a more specific claim already covers this span
        out.append(c)
        last_end = c.end
    return out


def _money_claim(m: re.Match[str]) -> Claim | None:
    raw = m.group(1) or m.group(2)
    value = _to_float(raw)
    if value is None:
        return None
    return Claim(MONEY_KIND, m.group(0), m.start(), m.end(), value=value, norm=str(value),
                 unit="HKD")


def _time_claim(m: re.Match[str]) -> Claim | None:
    hh, mm = int(m.group(1)), int(m.group(2))
    if hh > 23 or mm > 59:
        return None
    label = f"{hh:02d}:{mm:02d}"
    return Claim(TIME_KIND, m.group(0), m.start(), m.end(),
                 value=float(hh * 60 + mm), norm=label)


def _distance_claim(m: re.Match[str]) -> Claim | None:
    value = _to_float(m.group(1))
    if value is None:
        return None
    unit = (m.group(2) or "m").lower()
    meters = value * 1000.0 if unit in ("km", "公里", "千米") else value
    return Claim(DISTANCE_KIND, m.group(0), m.start(), m.end(), value=meters,
                 norm=str(meters), unit="m")


def _minutes_claim(m: re.Match[str]) -> Claim | None:
    value = _to_float(m.group(1))
    if value is None:
        return None
    return Claim(MINUTES_KIND, m.group(0), m.start(), m.end(), value=value,
                 norm=str(value), unit="min")


def _rating_claim(m: re.Match[str]) -> Claim | None:
    raw = next((g for g in m.groups() if g), None)
    value = _to_float(raw)
    if value is None or not (0.0 <= value <= 5.0):
        return None
    return Claim(RATING_KIND, m.group(0), m.start(), m.end(), value=value, norm=str(value))


def _percent_claim(m: re.Match[str]) -> Claim | None:
    value = _to_float(m.group(1))
    if value is None:
        return None
    return Claim(PERCENT_KIND, m.group(0), m.start(), m.end(), value=value, norm=str(value),
                 unit="%")


def _count_claim(m: re.Match[str]) -> Claim | None:
    value = _to_float(m.group(1))
    if value is None:
        return None
    return Claim(COUNT_KIND, m.group(0), m.start(), m.end(), value=value, norm=str(value))


#: The words that TYPE a bare number. D482: they stood inside the reader, so the list
#: was a second copy of the vocabulary (D438) and the English "star" was missing from
#: the rating list altogether - "a 4.5 star rating" was typed as a plain number.
RATING_KEYWORDS: tuple[str, ...] = ("評", "评", "評分", "评分", "rating", "star", "星")
MONEY_KEYWORDS: tuple[str, ...] = ("预算", "預算", "budget", "price", "價", "价")

#: How far the keyword may reach to type a claim. D482: the window was SIX characters,
#: which is shorter than most English clauses - "the price is 128" put the word "price"
#: outside the window, so a price was typed as a plain number and then grounded with the
#: loose number tolerance. The polarity reader's own reach is the house's precedent:
#: sixteen characters for Latin, six for CJK (there are no spaces to bound a Chinese
#: phrase).
_KEYWORD_WINDOW_LATIN = 16
_KEYWORD_WINDOW_CJK = 6


def _keyword_window(text: str) -> int:
    """How far a keyword may reach to type a claim.

    The polarity reader's own reach is the house's precedent: sixteen characters for
    Latin, six for CJK - a Chinese phrase is short, and there are no spaces to bound it.
    """
    if any("\u3400" <= ch <= "\u9fff" for ch in text):
        return _KEYWORD_WINDOW_CJK
    return _KEYWORD_WINDOW_LATIN


def _bare_kind(text: str, start: int, end: int) -> str:
    """The kind of a bare number - the word that types it decides.

    D482: the window now reaches the word that types the claim, and the Latin keywords
    are read by the ONE matcher - "priceless" is not "price".
    """
    reach = _keyword_window(text)
    window = text[max(0, start - reach):min(len(text), end + reach)]
    low = window.lower()
    if any(cue_in(k, window, low) for k in RATING_KEYWORDS):
        return RATING_KIND
    if any(cue_in(k, window, low) for k in MONEY_KEYWORDS):
        return MONEY_KIND
    return NUMBER_KIND


# --------------------------------------------------------------------- verification
def verify_claims(claims: Sequence[Claim], ground: GroundSet) -> list[Claim]:
    for c in claims:
        ok, fact_id, value = ground.find(c)
        c.grounded = ok
        c.fact_id = fact_id
        c.grounded_value = value
    return list(claims)


def extract_and_verify(text: str, ground: GroundSet) -> list[Claim]:
    return verify_claims(extract_claims(text), ground)


@dataclass
class VerificationReport:
    """The gate every user-facing string passes through before rendering."""

    text: str = ""
    original_text: str = ""
    claims: list[Claim] = field(default_factory=list)
    stripped: list[Claim] = field(default_factory=list)
    hallucination_count: int = 0
    verified: bool = True
    note: str | None = None

    @property
    def claim_count(self) -> int:
        return len(self.claims)

    @property
    def grounded_count(self) -> int:
        return sum(1 for c in self.claims if c.grounded)

    @property
    def hallucination_rate(self) -> float:
        if not self.claims:
            return 0.0
        return round(self.hallucination_count / len(self.claims), 4)

    @property
    def ok(self) -> bool:
        return self.hallucination_count == 0

    @property
    def fact_ids(self) -> list[Any]:
        return [c.fact_id for c in self.claims if c.grounded and c.fact_id]

    def as_dict(self) -> dict[str, Any]:
        return {
            "verified": self.verified,
            "claims": len(self.claims),
            "grounded": self.grounded_count,
            "hallucinations": self.hallucination_count,
            "hallucination_rate": self.hallucination_rate,
            "stripped": [c.as_dict() for c in self.stripped],
            "note": self.note,
        }

    def bullets(self) -> list[dict[str, Any]]:
        return [c.as_dict() for c in self.claims]


def verify_text(text: str, ground: GroundSet, *, strip: bool = True,
                note: str | None = None) -> VerificationReport:
    """Verify and (by default) strip. Ungrounded claims never reach a screen (§4)."""
    claims = extract_and_verify(text or "", ground)
    ungrounded = [c for c in claims if not c.grounded]
    cleaned = _strip_spans(text or "", ungrounded) if (strip and ungrounded) else (text or "")
    if ungrounded and not strip:
        cleaned = text or ""
    return VerificationReport(
        text=cleaned, original_text=text or "", claims=claims,
        stripped=ungrounded, hallucination_count=len(ungrounded),
        verified=not ungrounded,
        note=note or ("ungrounded_claims_stripped" if ungrounded else None))


def verify_generated_text(text: str, bundle: FactBundle | None = None, *,
                          extra_numbers: Iterable[float] = (),
                          entities: Sequence[str] = (),
                          records: Iterable[dict[str, Any]] = (),
                          strip: bool = True) -> VerificationReport:
    ground = build_ground_set(bundle, extra_numbers=extra_numbers, entities=entities or (),
                              records=records)
    return verify_text(text, ground, strip=strip)



# --------------------------------------------------------------------- helpers
def normalize_entity(name: str) -> str:
    n = re.sub(r"[«»\"“”「」『』《》()（）\[\]]", " ", name or "")
    n = re.sub(r"\s+", " ", n).strip().lower()
    return n


def _entity_match(claim_norm: str, entities: set[str]) -> bool:
    if not claim_norm:
        return False
    if claim_norm in ENTITY_STOPWORDS:
        return True
    for e in entities:
        if not e:
            continue
        if claim_norm == e or claim_norm in e or e in claim_norm:
            return True
        # "龍苑 Kitchen" vs "龍苑" — token overlap of a meaningful token is enough
        for tok in (t for t in re.split(r"\s+", claim_norm) if len(t) > 1):
            if tok in e:
                return True
    return False


def _norm_clock(value: str) -> str:
    m = TIME_RE.search(value)
    if not m:
        return value
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def _clock_to_minutes(value: str) -> int | None:
    m = re.fullmatch(r"\s*([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*", value or "")
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _to_float(raw: Any) -> float | None:
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip().replace(",", "")
    if not s:
        return None
    m = re.fullmatch(r"[-+]?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _attr_kind(attribute: str) -> str:
    a = (attribute or "").lower()
    if any(k in a for k in ("price", "amount", "cost", "spend", "budget")):
        return MONEY_KIND
    if a in ("rating", "rating_agg") or "rating" in a:
        return RATING_KIND
    if "meter" in a or "distance" in a:
        return DISTANCE_KIND
    if "minute" in a or "walk" in a or "travel" in a:
        return MINUTES_KIND
    if "count" in a or "review_count" in a:
        return COUNT_KIND
    return NUMBER_KIND


def _scalars(value: Any) -> Iterable[Any]:
    if isinstance(value, dict):
        for v in value.values():
            yield from _scalars(v)
    elif isinstance(value, (list, tuple, set)):
        for v in value:
            yield from _scalars(v)
    elif value is not None:
        yield value


def _flatten(rec: dict[str, Any], prefix: str = "") -> Iterable[tuple[str, Any]]:
    for k, v in (rec or {}).items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            yield from _flatten(v, prefix=f"{key}.")
        elif isinstance(v, (list, tuple)):
            for item in v:
                if isinstance(item, dict):
                    yield from _flatten(item, prefix=f"{key}.")
                else:
                    yield key, item
        else:
            yield key, v


def _strip_spans(text: str, claims: Sequence[Claim]) -> str:
    """Remove ungrounded assertions and tidy the hole they leave behind."""
    if not claims:
        return text
    pieces: list[str] = []
    cursor = 0
    for c in sorted(claims, key=lambda x: x.start):
        pieces.append(text[cursor:c.start])
        cursor = c.end
        # drop a dangling connector the claim hung off, e.g. "，HK$500" -> ""
        tail = text[cursor:cursor + 2]
        if tail.startswith(("，", ",", "、", " · ", " ·", "：", ":")):
            step = 2 if tail.startswith(" ·") or tail.startswith("：") else 1
            cursor += step
    pieces.append(text[cursor:])
    out = "".join(pieces)
    out = re.sub(r"\s{2,}", " ", out)
    out = re.sub(r"[，,、]\s*([。.!？?])", r"\1", out)
    out = re.sub(r"[:：]\s*([。.!])", r"\1", out)
    out = re.sub(r"（\s*）|\(\s*\)", "", out)
    return out.strip()
