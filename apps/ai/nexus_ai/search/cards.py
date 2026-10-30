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
from nexus_ai.trust.facts import FactBundle, SOURCE_RANK, resolve_conflicts, stable_fact_id
from nexus_ai.trust.freshness import stale_copy

#: the contract's word for the status the ranking lane reports. `AvailabilityInfo.status` is an enum
#: of four words and `full` is not one of them, while the seats being gone is exactly what
#: `unavailable` means; an unrecognised word answers `unknown`, because the card may not claim a
#: slot it did not read.
CONTRACT_AVAILABILITY_STATUS: dict[str | None, str] = {
    None: "unknown", "available": "available", "limited": "limited",
    "full": "unavailable", "unavailable": "unavailable", "unknown": "unknown",
}

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
    # D608: the walk from the station, in the merchant's own recorded minutes - not the walk
    # from the user, which `near_you` estimates from straight-line metres.
    "mtr_proximity": {"zh-HK": "港鐵 {station} 站步行 {minutes} 分鐘",
                      "zh-CN": "地铁 {station} 站步行 {minutes} 分钟",
                      "en": "{minutes} min walk from MTR {station}"},
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
    # D608: the recorded walk from the station, which is two columns of the location record the
    # geo lane already fetches. The plane keeps no transit FACT to cite - its 684 `address` facts
    # hold lat/lng/line1/line2/district and no station - so the citation is synthesised from the
    # row, on the `distance_m` fact's own shape. `source` follows what this plane already says
    # about that same location record: `merchant` on 684 of 684 address facts.
    rec = (cand.raw or {}).get("row") or (cand.raw or {})
    station, walk_min = rec.get("mtr_station"), rec.get("mtr_walk_min")
    if station and walk_min is not None:
        out["mtr_proximity"] = bundle.synth(
            subject_type=cand.subject_type, subject_id=sid, attribute="mtr_proximity",
            value={"station": str(station), "walk_min": int(walk_min)},
            source="merchant", confidence=0.9, observed_at=now)
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
                      "distance_m", "mtr_proximity", "open_state", "availability", "relevance"):
        f = computed.get(attribute) or _fact_by_subject(bundle, attribute, cand)
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
    # D589: ground the number about to be printed, before `flags` reads the bundle for a
    # conflict over it.
    rendered_price = _ground_rendered_price(bundle, cand, rec, price, subject_uuid)
    if rendered_price is not None:
        facts.insert(0, rendered_price)
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
        unverified=not bool(rec.get("ownership_verified", True)),
        # D472: the offering's price came from an estimate - the flag API_CONTRACT §2
        # names for offering cards. The query already selects `price_source`.
        estimated_price=(str(rec.get("price_source") or "").lower() == "estimated"),
        # D497: AGENT_CONTRACT §4 - a conflict creates a `trust_signals` row rather than
        # silently picking. The row is the platform's to write (the AI role has no grant on
        # `trust_signals` - filed), so the card says the value is DISPUTED instead of
        # hiding the other value. The trust layer's own resolver says which value won.
        conflicting_fact=bool(_disputed_attributes(bundle, subject_uuid)))
    if cand.sponsored and sponsor_label:
        anchor = computed.get("relevance") or (facts[0] if facts else None)
        reasons.insert(0, MatchExplanation(label="sponsored", text=sponsor_label,
                                          value=None,
                                          fact_id=(anchor.fact_id if anchor else None)))

    image = _image_of(rec)
    # D423: the card's open state and its availability brief each cite the fact they were
    # computed from - the trust primitive (§4/§19: any AI-stated fact cites one of these) -
    # and the card's construction FILTERED the keys it passed, so the field was always null
    # while the card carried the very fact it names in its own `facts` list. The same
    # filter dropped `opens_at` and `closes_at`, so a card that said "Open until 18:00"
    # never said when it closed. Both are filled from the facts the card already has.
    # D619 corrects one clause of this note: the two objects do NOT share the pointer's name.
    # `CardOpeningState` carries `source_fact_id`; the object `EntityCard.availability` points at
    # is `AvailabilityInfo`, whose properties do not include it and which names the same pointer
    # `fact_id` - so the key D428 added to the availability brief was a property the published
    # object refuses, on every card the lane has ever sent.
    # The `opens_at` / `closes_at` that compute_open produces are TIME strings ("18:00")
    # while the contract declares them as datetimes - that disagreement is filed, and it
    # is why only the fields the two shapes agree on are passed through.
    open_fields: dict[str, Any] = {k: v for k, v in (open_state or {}).items()
                                   if k in ("is_open", "text", "as_of")}
    open_fact = computed.get("open_state")
    if open_fact is not None:
        open_fields["source_fact_id"] = open_fact.fact_id
    # D619: `status` is a required enum, not an optional echo of the lane's row - a card that
    # asked the pool for a slot and got none says `unknown`, which AGENT_CONTRACT §5 and
    # DECISIONS D6 make a legal answer precisely so it does not have to fabricate a slot. The
    # `is not None` filter this replaces dropped the key instead, so 41 of the 41 cards measured
    # by `tmp/d619_dump_cards.py` sent `status: null` and matched neither branch of the block's
    # `oneOf`. `full` is the ranking lane's word (service.py:810) and is off the enum; the
    # contract's word for a slot with no seats left is `unavailable`. `as_of` is mandatory for a
    # bookable word - the freshness table puts availability's TTL at 0 - and the stamp is the
    # row clock the candidate already carries, not a new claim.
    lane_slot = (availability or {}).get("next_slot")
    contract_status = CONTRACT_AVAILABILITY_STATUS.get((availability or {}).get("status"), "unknown")
    # `available` and `limited` are bookable claims and the contract's rule refuses either without
    # an instant behind it (DECISIONS D6: never fabricate a slot), so a word the lane could not
    # stamp with a moment is reported as `unknown` - the fourth word, and the one that asks nothing.
    if contract_status in ("available", "limited") and lane_slot is None:
        contract_status = "unknown"
    availability_fields: dict[str, Any] = {"status": contract_status, "next_slot": lane_slot}
    availability_fact = computed.get("availability")
    if availability_fact is not None:
        availability_fields["fact_id"] = availability_fact.fact_id
        availability_fields["as_of"] = (cand.raw or {}).get("as_of")
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
    # D608: appended the way the district bullet is, because it is not a ranking contribution - no
    # feature score earns it a place - while still tracing to a fact (§18) or not being raised.
    transit = _fact_for("mtr_proximity", computed, bundle, cand)
    if transit is not None and "mtr_proximity" not in seen:
        transit_text = _reason_text("mtr_proximity", cand, locale=lang,
                                    open_state=open_state, query=query)
        if transit_text:
            out.append(MatchExplanation(label="mtr_proximity", text=transit_text,
                                        value=str(transit.value["walk_min"]),
                                        fact_id=transit.fact_id))
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
        # D624: a range names both ends, so the card states the band the user asked for rather
        # than half of it.
        if cand.budget_min is not None:
            return template.format(p=f"HK${cand.budget_min:g}-{cand.budget_max:g}")
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
    if label == "mtr_proximity":
        rec = (cand.raw or {}).get("row") or (cand.raw or {})
        station, walk_min = rec.get("mtr_station"), rec.get("mtr_walk_min")
        if not station or walk_min is None:
            return ""  # half a transit fact is a guess about the other half (§2)
        return template.format(station=str(station), minutes=int(walk_min))
    return template


#: The attributes this plane files under the LOCATION its geo row selects rather than under the
#: card's own subject. Measured (`tmp/d609_district_cite_probe.py`, 2026-10-29): all 684
#: `address` facts are keyed to `locations.id` and none to a merchant, while cuisine,
#: opening_hours, price and rating are keyed to the merchant or the offering - `address` is the
#: only attribute a card can print without being able to reach a fact for it.
LOCATION_KEYED_ATTRIBUTES = frozenset({"address"})


def _fact_by_subject(bundle: FactBundle, attribute: str, cand: Candidate) -> Fact | None:
    """The fact for the subject the printed word actually came from.

    A geo row names the location its district was read from (D609), so for an attribute filed
    under locations the citation is THAT location's fact and no other: 77 of this plane's 520
    merchants keep locations in more than one district and for 133 of the 145 published ones the
    nearest location sits in a different district from the primary, so falling back to a
    merchant-level address fact would vouch for a word the card is not printing. With no
    location on the row, the card's own subject is the only rung there is - and it is the right
    one, because that is where the in-memory demo lane files the same attribute
    (`demo_data.py:151`).
    """
    rec = (cand.raw or {}).get("row") or (cand.raw or {})
    if attribute in LOCATION_KEYED_ATTRIBUTES and rec.get("location_id"):
        return bundle.get(attribute, _coerce_uuid(str(rec["location_id"])))
    return bundle.get(attribute, _coerce_uuid(str(cand.subject_id)))


def _fact_for(label: str, computed: dict[str, Fact], bundle: FactBundle,
              cand: Candidate) -> Fact | None:
    key = {"near_you": "distance_m", "slot_available": "availability",
           "open_at_time": "open_state", "open_now": "open_state",
           "matches_query": "relevance", "preference_match": "relevance",
           "fresh_data": "relevance", "trending": "popularity",
           "district_match": "address", "within_budget": "price",
           "mtr_proximity": "mtr_proximity",
           "top_rated": "rating"}.get(label)
    if key and key in computed:
        return computed[key]
    if key:
        return _fact_by_subject(bundle, key, cand)
    return None


#: The attributes a card shows a fact for - the ones a conflict can be about.
DISPUTED_ATTRIBUTES: tuple[str, ...] = ("price", "avg_price_hkd", "rating",
                                        "opening_hours", "address")


def _disputed_attributes(bundle: FactBundle, subject_uuid: Any) -> list[str]:
    """The attributes whose facts DISAGREE - §4's conflicts, not a silent pick.

    The trust layer's own resolver decides which value wins (the source hierarchy, then
    the confidence, then the recency) and reports the disagreement; this asks it, so the
    rule lives in one place.
    """
    out: list[str] = []
    for attribute in DISPUTED_ATTRIBUTES:
        _chosen, disagreements = resolve_conflicts(bundle, attribute, subject_uuid)
        if disagreements:
            out.append(attribute)
    return out


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


def price_clock(rec: dict[str, Any]) -> datetime | None:
    """The row's own stamp for the price it publishes, or None when it has no such column.

    `V1__init.sql:228` annotates `offerings.price_updated_at` as "drives freshness TTL (§20)"
    and `OfferingRepository` moves it on every price write; `build_offering_query` selects it
    into the candidate row. `merchants` has no price clock, so a merchant row answers None - and
    the reader then claims nothing rather than inventing a stamp.
    """
    stamp = rec.get("price_updated_at")
    if isinstance(stamp, str):
        try:
            stamp = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            return None
    return stamp if isinstance(stamp, datetime) else None


def price_fact_source(rec: dict[str, Any]) -> str:
    """The §4 source a row's own price is vouched by, never more than the row says (D501).

    Measured on this plane, `price_source` holds `merchant` (4,710), `estimated` (559) and
    `observed` (265) offerings. `estimated` is not in the hierarchy, and a source the
    hierarchy does not know is not a merchant's claim.
    """
    source = str(rec.get("price_source") or "").strip()
    return source if source in SOURCE_RANK else "demo"


def ground_row_price(bundle: FactBundle, *, subject_type: str, subject_id: Any,
                     rec: dict[str, Any], amount: Any, currency: Any = None,
                     model: Any = None) -> Fact | None:
    """§4: a price a read renders out of its own column has to resolve to a fact.

    Two readers needed it and got it the same way: the card (`_ground_rendered_price`, D589)
    and the comparison grid's price cell (D590). Both print the row's column while the trust
    layer answers only from the `facts` table, so a subject whose price lives in a column
    renders a number with nothing to cite and no age to surface.

    The fact is stamped with the row's price clock, NOT with the request time: stamping it
    `now` would launder a 36-day-old number into a fresh one, which is what §5 forbids. Where
    the facts table already vouches for a price (or for `avg_price_hkd`) nothing is written, so
    a reader cannot manufacture a §4 conflict against its own row.
    """
    if amount is None:
        return None
    stamp = price_clock(rec)
    if stamp is None:
        return None
    if bundle.get("price", subject_id) or bundle.get("avg_price_hkd", subject_id):
        return None
    return bundle.synth(subject_type=subject_type, subject_id=subject_id, attribute="price",
                        value={"amount": amount, "currency": currency, "model": model},
                        source=price_fact_source(rec), confidence=0.9, observed_at=stamp)


def _ground_rendered_price(bundle: FactBundle, cand: Candidate, rec: dict[str, Any],
                           price: Money | None, subject_id: UUID) -> Fact | None:
    """§4: the number the card prints has to resolve to a fact - see `ground_row_price`.

    Measured at HEAD, 3,373 of this plane's 4,707 priced offerings have no `price` row for
    their own subject, so those cards print a price with nothing to cite and
    `attach_price_staleness` (§5) has nothing to read. The web's own reader names the
    consequence: `resolvedPrice` returns null for a card with no price fact, and the page
    renders the unverified marker over a merchant's own published number.
    """
    if price is None:
        return None
    return ground_row_price(bundle, subject_type=cand.subject_type, subject_id=subject_id,
                            rec=rec, amount=price.amount, currency=price.currency,
                            model=price.model)


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


def attach_price_staleness(card: EntityCard, bundle: FactBundle, *, locale: str) -> EntityCard:
    """§5: a stale price is surfaced, never silently rendered.

    `locale` is required rather than defaulted: the sentence is the card's only warning, and a
    caller that could omit the argument would print Traditional Chinese to an English reader -
    which is the defect this signature exists to close (D587's floor has the same shape: the
    wrong value has to be unrepresentable, not merely untested).
    """
    price_fact = bundle.get("price", card.id) or bundle.get("avg_price_hkd", card.id)
    if price_fact and price_fact.stale:
        card.ai_match = card.ai_match or AiMatch(score=0.0)
        card.ai_match.reasons.append(MatchExplanation(
            label="price_stale", text=stale_copy(locale), value=None,
            fact_id=price_fact.fact_id))
    return card


__all__ = ["build_card", "build_reasons", "compute_open", "meters_text", "travel_minutes",
           "attach_price_staleness", "drop_ungrounded_reasons", "synth_computed_facts",
           "ground_row_price", "price_clock", "price_fact_source",
           "REASON_COPY"]
