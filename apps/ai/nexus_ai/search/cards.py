"""EntityCard assembly — API_CONTRACT §2 + AGENT_CONTRACT §4 renderer contract.

The card is the single render contract for web, MCP and UCP, and it carries its own
provenance: `facts[]` backs every rendered number and `ai_match.reasons[].fact_id` points at
the fact for each bullet. A bullet we cannot ground gets dropped here rather than rendered
without an id, because §4 says the UI must not render it anyway.
"""

from __future__ import annotations

from datetime import datetime, time
from typing import Any, Iterable, Sequence, cast
from uuid import UUID

from nexus_ai.contract import (
    AvailabilityBrief,
    CardAction,
    CardType,
    EntityCard,
    EntityFlags,
    EntityImage,
    Fact,
    AiMatch,
    MatchExplanation,
    Money,
    OpenState,
)
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle, stable_fact_id
from nexus_ai.trust.freshness import stale_copy

#: reason label -> per-locale copy template. `{}` slots are filled from grounded values.
REASON_COPY: dict[str, dict[str, str]] = {
    "matches_query": {"zh-HK": "符合「{q}」", "zh-CN": "符合「{q}」", "en": "matches “{q}”"},
    "near_you": {"zh-HK": "距離你 {d}", "zh-CN": "距离你 {d}", "en": "{d} away"},
    "within_budget": {"zh-HK": "符合你的預算 {p}", "zh-CN": "符合你的预算 {p}",
                      "en": "within your budget of {p}"},
    "top_rated": {"zh-HK": "評分 {r}（{n} 條評價）", "zh-CN": "评分 {r}（{n} 条评价）",
                  "en": "rated {r} ({n} reviews)"},
    "open_at_time": {"zh-HK": "{when} 營業至 {close}", "zh-CN": "{when} 营业至 {close}",
                     "en": "open until {close} {when}"},
    "open_now": {"zh-HK": "現正營業", "zh-CN": "正在营业", "en": "open now"},
    "slot_available": {"zh-HK": "{when} 有位", "zh-CN": "{when} 有位",
                       "en": "availability at {when}"},
    "trending": {"zh-HK": "近期熱門", "zh-CN": "近期热门", "en": "trending"},
    "preference_match": {"zh-HK": "配合你的偏好", "zh-CN": "符合你的偏好",
                         "en": "matches your preferences"},
    "preference_named": {"zh-HK": "配合你的偏好：{p}", "zh-CN": "符合你的偏好：{p}",
                          "en": "matches your preference: {p}"},
    "preference_typed": {"zh-HK": "符合你這次的要求：{p}", "zh-CN": "符合你这次的要求：{p}",
                         "en": "matches what you asked for: {p}"},
    "fresh_data": {"zh-HK": "資料已核實", "zh-CN": "资料已核实", "en": "data verified"},
    "district_match": {"zh-HK": "位於 {district}", "zh-CN": "位于 {district}",
                       "en": "in {district}"},
    "sponsored": {"zh-HK": "廣告", "zh-CN": "广告", "en": "Sponsored"},
}

FEATURE_TO_LABEL = {
    "relevance": "matches_query",
    "distance": "near_you",
    "price_fit": "within_budget",
    "quality": "top_rated",
    "availability": "slot_available",
    "personalization": "preference_match",
    "popularity": "trending",
    "freshness": "fresh_data",
}

DEMO_ORIGINS = {"demo", "synthetic", "seed", "fixture"}


def meters_text(meters: float | None) -> str:
    if meters is None:
        return ""
    if meters >= 1000:
        return f"{meters / 1000:.1f}km"
    return f"{int(round(meters / 10.0) * 10)}m"


def travel_minutes(meters: float | None) -> int | None:
    """Walking estimate at 4.8 km/h — an estimate, so it ships as an `inferred` fact."""
    if meters is None:
        return None
    return max(1, int(round(float(meters) / 80.0)))


# --------------------------------------------------------------------------- open state
def compute_open(hours: Sequence[dict[str, Any]], *, now: datetime,
                 at: datetime | None = None) -> dict[str, Any]:
    """Opening state computed from `business_hours`, never guessed (§2).

    `hours` rows are `{weekday, opens_at, closes_at, crosses_midnight}` with weekday
    0=Mon..6=Sun (V1__init.sql). Returns `is_open=None` when the merchant has NO hours at
    all; a merchant whose hours do not cover the queried weekday is CLOSED that day, and
    says so (D422).
    """
    moment = at or now
    from nexus_ai.nlu.timeparse import HK_TZ

    local = moment.astimezone(HK_TZ) if moment.tzinfo else moment.replace(tzinfo=HK_TZ)
    wd = local.weekday()
    clock = local.time()
    today = [h for h in hours if int(h.get("weekday") or 0) == wd]
    yesterday = [h for h in hours if int(h.get("weekday") or 0) == (wd - 1) % 7
                 and h.get("crosses_midnight")]
    for h in yesterday:
        closes = _as_time(h.get("closes_at"))
        if closes and clock < closes:
            return {"is_open": True, "opens_at": None, "closes_at": _iso(closes),
                    "text": f"Open until {_hhmm(closes)}", "as_of": local.isoformat(),
                    "closes_hhmm": _hhmm(closes)}
    if not today:
        # D422: the merchant's own hours are the CLAIM. A venue that lists Mon-Sat is
        # saying it is closed on Sundays, and "closed" is the answer - not "unknown".
        # The unknown case is the one BELOW (no hours at all), and it stays unknown:
        # they are different claims, and the grid's open_state row had an EMPTY CELL
        # for ~5% of the merchants because they were treated as the second one.
        if not hours:
            return {"is_open": None, "text": None, "as_of": local.isoformat()}
        return {"is_open": False, "opens_at": None, "closes_at": None, "text": "Closed",
                "as_of": local.isoformat(), "closes_hhmm": None}
    for h in today:
        opens, closes = _as_time(h.get("opens_at")), _as_time(h.get("closes_at"))
        if not opens or not closes:
            continue
        if h.get("crosses_midnight"):
            is_open = clock >= opens or clock < closes
        else:
            is_open = opens <= clock < closes
        if is_open:
            return {"is_open": True, "opens_at": _iso(opens), "closes_at": _iso(closes),
                    "text": f"Open until {_hhmm(closes)}", "as_of": local.isoformat(),
                    "closes_hhmm": _hhmm(closes)}
    opens_today = [t for t in (_as_time(h.get("opens_at")) for h in today) if t is not None]
    nxt = min(opens_today, default=None)
    return {"is_open": False, "opens_at": _iso(nxt) if nxt else None, "closes_at": None,
            "text": f"Opens {_hhmm(nxt)}" if nxt else "Closed",
            "as_of": local.isoformat(), "closes_hhmm": None}


def _as_time(value: Any) -> time | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.time()
    if isinstance(value, time):
        return value
    try:
        parts = str(value).split(":")
        return time(int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) > 2 else 0)
    except (ValueError, IndexError):
        return None


def _hhmm(value: time | None) -> str:
    return value.strftime("%H:%M") if value else ""


def _iso(value: time | None) -> str | None:
    return _hhmm(value) or None


# --------------------------------------------------------------------- grounding a candidate
def synth_computed_facts(bundle: FactBundle, cand: Candidate, *, now: datetime,
                         open_state: dict[str, Any] | None,
                         availability: dict[str, Any] | None,
                         query: str | None) -> dict[str, Fact]:
    """Give every rendered computed number its own Fact (§4), keyed by attribute."""

    def subject_uuid() -> UUID:
        try:
            return UUID(str(cand.subject_id))
        except (ValueError, AttributeError):
            return stable_fact_id(cand.subject_type, cand.subject_id)

    sid = subject_uuid()
    out: dict[str, Fact] = {}
    if cand.distance_m is not None:
        out["distance_m"] = bundle.synth(
            subject_type=cand.subject_type, subject_id=sid, attribute="distance_m",
            value={"meters": int(round(cand.distance_m)), "text": meters_text(cand.distance_m),
                   "travel_minutes": travel_minutes(cand.distance_m)},
            source="inferred", confidence=0.95, observed_at=now)
    if open_state and open_state.get("is_open") is not None:
        out["open_state"] = bundle.synth(
            subject_type="merchant", subject_id=sid, attribute="open_state",
            value={"is_open": open_state["is_open"], "text": open_state.get("text"),
                   "closes_at": open_state.get("closes_hhmm")},
            source="merchant", confidence=0.9, observed_at=now)
    if availability:
        out["availability"] = bundle.synth(
            subject_type="merchant", subject_id=sid, attribute="availability",
            value=availability, source="observed", confidence=0.95,
            observed_at=now)
    if query:
        out["relevance"] = bundle.synth(
            subject_type=cand.subject_type, subject_id=sid, attribute="relevance",
            value={"query": query, "score": round(cand.relevance, 4)},
            source="inferred", confidence=round(cand.relevance, 3), observed_at=now)
    if cand.rating is not None and cand.rating_count:
        out["rating"] = out.get("rating") or bundle.synth(
            subject_type=cand.subject_type, subject_id=sid, attribute="rating",
            value={"value": cand.rating, "count": cand.rating_count},
            source="observed", confidence=0.85, observed_at=now)
    return out


# D450: the one-line fact lookup that used to stand here is gone - the callers
# read the bundle directly.


# ------------------------------------------------------------------------- the card
def build_card(cand: Candidate, scored: Scored | None, bundle: FactBundle, *,
               locale: str = "zh-HK", open_state: dict[str, Any] | None = None,
               availability: dict[str, Any] | None = None,
               reasons_from: Iterable[str] = (), query: str | None = None,
               sponsor_label: str | None = None,
               weights_version: str = "hybrid_v1") -> EntityCard:
    row = cand.raw or {}
    rec = row.get("row") or row
    sid = str(cand.subject_id)
    computed = synth_computed_facts(bundle, cand, now=_now(row), open_state=open_state,
                                    availability=availability, query=query)

    subject_uuid = _coerce_uuid(sid)
    facts: list[Fact] = []
    for attribute in ("price", "avg_price_hkd", "rating", "opening_hours", "address",
                      "distance_m", "open_state", "availability", "relevance"):
        f = computed.get(attribute) or bundle.get(attribute, subject_uuid)
        if f and f not in facts:
            facts.append(f)

    reasons = build_reasons(cand, scored, bundle, locale=locale, computed=computed,
                            open_state=open_state, reasons_from=reasons_from, query=query)

    card_type: CardType = "merchant"
    if cand.subject_type == "offering":
        card_type = cast(CardType, {"product": "product", "service": "service",
                                   "experience": "experience"}.get(
                                       str(rec.get("kind")), "product"))

    title = _title(rec, card_type, locale)
    price = _price_of(cand, rec, card_type)
    rating_value = cand.rating
    rating = ({"value": round(float(rating_value), 2), "count": int(cand.rating_count or 0),
               "fact_id": str(computed["rating"].fact_id)}
              if rating_value is not None and "rating" in computed
              else ({"value": round(float(rating_value), 2), "count": int(cand.rating_count or 0)}
                    if rating_value is not None else None))

    distance = None
    if cand.distance_m is not None:
        distance = {"meters": int(round(cand.distance_m)),
                    "text": meters_text(cand.distance_m),
                    "travel_minutes": travel_minutes(cand.distance_m),
                    "fact_id": str(computed["distance_m"].fact_id)}

    flags = EntityFlags(
        sponsored=bool(cand.sponsored),
        demo=str(rec.get("data_origin") or "").lower() in DEMO_ORIGINS,
        unverified=not bool(rec.get("ownership_verified", True)))
    if cand.sponsored and sponsor_label:
        anchor = computed.get("relevance") or (facts[0] if facts else None)
        reasons.insert(0, MatchExplanation(label="sponsored", text=sponsor_label,
                                          value=None,
                                          fact_id=(anchor.fact_id if anchor else None)))

    image = _image_of(rec)
    # D423: the contract's OpenState and AvailabilityBrief both carry a `source_fact_id`
    # - the trust primitive (§4/§19: any AI-stated fact cites one of these) - and the
    # card's construction FILTERED the keys it passed, so the field was always null
    # while the card carried the very fact it names in its own `facts` list. The same
    # filter dropped `opens_at` and `closes_at`, so a card that said "Open until 18:00"
    # never said when it closed. Both are filled from the facts the card already has.
    # The `opens_at` / `closes_at` that compute_open produces are TIME strings ("18:00")
    # while the contract declares them as datetimes - that disagreement is filed, and it
    # is why only the fields the two shapes agree on are passed through.
    open_fields: dict[str, Any] = {k: v for k, v in (open_state or {}).items()
                                   if k in ("is_open", "text", "as_of")}
    open_fact = computed.get("open_state")
    if open_fact is not None:
        open_fields["source_fact_id"] = open_fact.fact_id
    availability_fields: dict[str, Any] = {k: (availability or {}).get(k)
                                          for k in ("status", "next_slot")
                                          if (availability or {}).get(k) is not None}
    availability_fact = computed.get("availability")
    if availability_fact is not None:
        availability_fields["source_fact_id"] = availability_fact.fact_id
    return EntityCard(
        card_type=card_type, id=subject_uuid, slug=str(rec.get("slug") or sid),
        title=title, subtitle=_subtitle(rec, cand, card_type),
        image=image, price=price, rating=rating, distance=distance,
        open=OpenState(**open_fields) if open_state else OpenState(is_open=None),
        availability=AvailabilityBrief(**availability_fields),
        ai_match=AiMatch(score=round(float(scored.score if scored else 0.0), 4),
                         reasons=reasons),
        actions=build_actions(card_type, subject_uuid, rec, locale),
        facts=facts, flags=flags,
        organic_rank=row.get("organic_rank"),
        score_breakdown={k: round(float(v), 4)
                         for k, v in (scored.breakdown if scored else {}).items()},
    )


def build_reasons(cand: Candidate, scored: Scored | None, bundle: FactBundle, *,
                  locale: str, computed: dict[str, Fact],
                  open_state: dict[str, Any] | None,
                  reasons_from: Iterable[str], query: str | None) -> list[MatchExplanation]:
    """§18 — one bullet per top contributing feature, each carrying a `fact_id`."""
    out: list[MatchExplanation] = []
    seen: set[str] = set()
    lang = locale if locale in ("zh-HK", "zh-CN", "en") else "zh-HK"
    order = list(reasons_from) or [k for k, _v in (scored.contributions if scored else [])]
    for feature in order:
        label = FEATURE_TO_LABEL.get(feature)
        if not label or label in seen:
            continue
        text = _reason_text(label, cand, locale=lang, open_state=open_state, query=query)
        if not text:
            continue
        fact = _fact_for(label, computed, bundle, cand)
        if fact is None:
            continue  # §4: no fact id -> no bullet
        seen.add(label)
        out.append(MatchExplanation(label=label, text=text, value=_fact_value(fact),
                                    fact_id=fact.fact_id))
    if cand.district and "district_match" not in seen:
        fact = _fact_for("district_match", computed, bundle, cand)
        if fact:
            out.append(MatchExplanation(
                label="district_match",
                text=_reason_text("district_match", cand, locale=lang,
                                  open_state=open_state, query=query),
                value=cand.district, fact_id=fact.fact_id))
    return out[:5]


def _reason_text(label: str, cand: Candidate, *, locale: str,
                 open_state: dict[str, Any] | None, query: str | None) -> str:
    template = REASON_COPY[label][locale]
    if label == "matches_query":
        q = (query or "").strip()
        return template.format(q=q[:24]) if q else ""
    if label == "near_you":
        return template.format(d=meters_text(cand.distance_m)) if cand.distance_m else ""
    if label == "preference_match":
        # D392: name the preference that fired, so the bullet is not a bare claim.
        # D396: a preference TYPED in this query and one the user DECLARED earlier are
        # different claims, and the card says which.
        entries = [e for e in (cand.raw or {}).get("preference_labels") or []
                   if isinstance(e, dict) and e.get("label")]
        if not entries:
            return template
        typed = [str(e["label"]) for e in entries if e.get("source") == "typed"]
        stored = [str(e["label"]) for e in entries if e.get("source") != "typed"]
        parts: list[str] = []
        if stored:
            uniq = list(dict.fromkeys(stored))
            parts.append(REASON_COPY["preference_named"][locale].format(
                p="、".join(uniq) if locale != "en" else ", ".join(uniq)))
        if typed:
            uniq = list(dict.fromkeys(typed))
            parts.append(REASON_COPY["preference_typed"][locale].format(
                p="、".join(uniq) if locale != "en" else ", ".join(uniq)))
        return "；".join(parts) if locale != "en" else "; ".join(parts)
    if label == "within_budget":
        if cand.budget_max is None or cand.price is None:
            return ""
        return template.format(p=f"HK${cand.budget_max:g}")
    if label == "top_rated":
        if cand.rating is None or not cand.rating_count:
            return ""
        return template.format(r=f"{cand.rating:.1f}", n=f"{cand.rating_count}+")
    if label == "open_at_time":
        if not open_state or not open_state.get("closes_hhmm"):
            return ""
        return template.format(when="", close=open_state["closes_hhmm"]).strip()
    if label == "open_now":
        return template if cand.open_now else ""
    if label == "slot_available":
        nxt = (cand.raw.get("availability") or {}).get("next_slot")
        return template.format(when=nxt or "") if cand.availability == "available" else ""
    if label == "district_match":
        return template.format(district=cand.district) if cand.district else ""
    return template


def _fact_for(label: str, computed: dict[str, Fact], bundle: FactBundle,
              cand: Candidate) -> Fact | None:
    key = {"near_you": "distance_m", "slot_available": "availability",
           "open_at_time": "open_state", "open_now": "open_state",
           "matches_query": "relevance", "preference_match": "relevance",
           "fresh_data": "relevance", "trending": "popularity",
           "district_match": "address", "within_budget": "price",
           "top_rated": "rating"}.get(label)
    sid = _coerce_uuid(str(cand.subject_id))
    if key and key in computed:
        return computed[key]
    if key:
        found = bundle.get(key, sid)
        if found:
            return found
    if label in ("trending", "preference_match", "fresh_data"):
        return None
    return None


def _fact_value(fact: Fact) -> str | None:
    v = fact.value
    if isinstance(v, dict):
        for k in ("amount", "value", "meters", "text", "is_open", "query"):
            if v.get(k) is not None:
                return str(v[k])
        return None
    return None if v is None else str(v)


def _title(rec: dict[str, Any], card_type: str, locale: str) -> str:
    zh_first = locale.startswith("zh")
    if card_type == "merchant":
        a, b = rec.get("display_name"), rec.get("display_name_zh")
    else:
        a, b = rec.get("name"), rec.get("name_zh")
    parts = [p for p in (b if zh_first else a, a if zh_first else b) if p]
    return " ".join(dict.fromkeys(parts)) or str(rec.get("slug") or "NEXUS")


def _subtitle(rec: dict[str, Any], cand: Candidate, card_type: str) -> str | None:
    bits = [cand.category or rec.get("category_primary")]
    if cand.district:
        bits.append(cand.district)
    if card_type != "merchant" and rec.get("merchant_name"):
        bits.append(rec.get("merchant_name_zh") or rec.get("merchant_name"))
    text = " · ".join(str(b) for b in bits if b)
    return text or None


def _price_of(cand: Candidate, rec: dict[str, Any], card_type: str) -> Money | None:
    amount = cand.price if cand.price is not None else rec.get("avg_price_hkd")
    if amount is None:
        return None
    model = ("per_person" if card_type == "merchant"
             else (rec.get("price_model") or "fixed"))
    currency = str(rec.get("currency") or "HKD")
    return Money.of(amount, currency=currency, model=model)


def _image_of(rec: dict[str, Any]) -> EntityImage | None:
    images = rec.get("images")
    if isinstance(images, str):
        import json

        try:
            images = json.loads(images)
        except Exception:
            images = []
    if isinstance(images, list) and images:
        first = images[0]
        url = first.get("url") if isinstance(first, dict) else str(first)
        alt = first.get("alt") if isinstance(first, dict) else "demo image"
        credit = first.get("credit", "synthetic") if isinstance(first, dict) else "synthetic"
        return EntityImage(url=url, alt=alt or "demo image", credit=credit or "synthetic")
    return None


def build_actions(card_type: str, subject_id: UUID, rec: dict[str, Any],
                  locale: str = "zh-HK") -> list[CardAction]:
    labels = {
        "zh-HK": {"view": "查看", "reserve": "訂枱", "add": "加入購物車", "compare": "比較"},
        "zh-CN": {"view": "查看", "reserve": "订位", "add": "加入购物车", "compare": "比较"},
        "en": {"view": "View", "reserve": "Reserve", "add": "Add to cart",
               "compare": "Compare"},
    }
    L = labels.get(locale, labels["zh-HK"])
    slug = rec.get("slug") or str(subject_id)
    out = [CardAction(type="view", label=L["view"], endpoint=f"/api/v1/merchants/{slug}")]
    if card_type == "merchant" and rec.get("ai_agent_enabled"):
        out.append(CardAction(type="ask", label=L["view"], endpoint="/ai/v1/merchant-agent/chat",
                              payload={"merchant_id": str(subject_id)}))
    if card_type != "merchant" and rec.get("bookable"):
        out.append(CardAction(type="reserve", label=L["reserve"],
                              endpoint="/api/v1/reservations",
                              payload={"merchant_id": str(rec.get("merchant_id") or ""),
                                       "offering_id": str(subject_id)}))
    elif card_type != "merchant":
        out.append(CardAction(type="cart_add", label=L["add"], endpoint="/api/v1/carts/items",
                              payload={"offering_id": str(subject_id), "quantity": 1}))
    out.append(CardAction(type="compare", label=L["compare"], endpoint="/ai/v1/compare",
                          payload={"subject_ids": [str(subject_id)]}))
    return out


def _coerce_uuid(value: Any) -> UUID:
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return stable_fact_id("nexus", value)


def _now(row: dict[str, Any]) -> datetime:
    raw = (row or {}).get("as_of")
    if isinstance(raw, datetime):
        return raw
    return datetime.now(row.get("_tz") if isinstance(row, dict) else None) or datetime.now()


#: Reason labels that are allowed to carry no `fact_id`. These are commercial or
#: structural signals, not trust facts. `sponsored` is the deliberate one: a paid
#: placement is *labelled* as such rather than faked into a trust reason
#: (§1846 — the system must not deceive users for payment). Every other label is a
#: claimed match and §18 demands it trace to a fact.
_NO_FACT_REASON_LABELS = frozenset({"sponsored"})


def drop_ungrounded_reasons(card: EntityCard) -> tuple[EntityCard, int]:
    """§18/§19 boundary enforcement for the wire — the last line before a card ships.

    Every recommendation bullet a user sees must trace to a `fact_id`. The rules
    path (`build_reasons`) already guarantees this by skipping any feature it cannot
    ground; this guard exists so a *future* producer — an LLM/upstream mapper that
    narrates a reason without a fact — cannot ship an unverifiable claim to the user.
    The contract's `MatchExplanation.fact_id` is `Optional` by design (the UI is the
    documented dropper), but the API is where the drop actually happens, and doing
    it here keeps a malformed upstream from 500-ing the response.

    Returns ``(card, dropped)``: the same card with ungrounded non-sponsored bullets
    removed, and how many were dropped. ``dropped == 0`` means the producer already
    complied — which is the steady state for the rules path.
    """
    if card.ai_match is None:
        return card, 0
    kept = [r for r in card.ai_match.reasons
            if r.fact_id is not None or r.label in _NO_FACT_REASON_LABELS]
    dropped = len(card.ai_match.reasons) - len(kept)
    if dropped:
        card.ai_match.reasons = kept
    return card, dropped


def attach_price_staleness(card: EntityCard, bundle: FactBundle) -> EntityCard:
    """§5: a stale price is surfaced, never silently rendered."""
    price_fact = bundle.get("price", card.id) or bundle.get("avg_price_hkd", card.id)
    if price_fact and price_fact.stale:
        card.ai_match = card.ai_match or AiMatch(score=0.0)
        card.ai_match.reasons.append(MatchExplanation(
            label="price_stale", text=stale_copy("zh-HK"), value=None,
            fact_id=price_fact.fact_id))
    return card


__all__ = ["build_card", "build_reasons", "compute_open", "meters_text", "travel_minutes",
           "attach_price_staleness", "drop_ungrounded_reasons", "synth_computed_facts",
           "REASON_COPY"]
