"""The deterministic hybrid search pipeline — API_CONTRACT §7 `/ai/v1/search`, §105 fallback.

Hard properties of this module:

* **zero LLM calls.** `search()` runs SQL → features → weights → cards and never touches a
  model router, so it is the endpoint the SSE stream can fall back to when the LLM is down
  (§105). `provider` is reported as `"none"` to make that visible in the response.
* **organic first, sponsored second.** `organic_rank()`, then the order the user's own words
  named (§34: `apply_sort_preference()`), then `apply_sponsored()` — sponsored is still placed
  last, capped at 1-in-top-5, organic best match never displaced, label attached (§66-67).
* **tenant scoping is structural** — every candidate query carries `tenant_id` as a bound
  parameter, and the merchant agent path additionally binds `merchant_id`.
* nothing is invented: availability only ever comes from `availability_slots` rows, opening
  state only from `business_hours`, prices/ratings from columns or `facts` rows; an absent
  value stays absent rather than defaulting to something plausible.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol, Sequence
from uuid import UUID

from nexus_ai.contract import EntityCard, FacetValue, Intent, SearchResponse
from nexus_ai.nlu.lexicon import cuisine_matches
from nexus_ai.nlu.timeparse import HK_TZ
from nexus_ai.search import sql as S
from nexus_ai.search.cards import build_card, compute_open, attach_price_staleness
from nexus_ai.search.ranking import (
    Candidate,
    RankingWeights,
    Scored,
    apply_sponsored,
    apply_sort_preference,
    facet_counts,
    load_ranking_weights,
    organic_rank,
    personalization_signal,
    sponsor_label,
)
from nexus_ai.trust.facts import FactBundle, facts_from_rows
from nexus_ai.trust.freshness import mean_remaining_fraction

log = logging.getLogger("nexus_ai.search")

KIND_TO_SUBJECT = {
    "discover_merchant": ("merchant",),
    "reserve": ("merchant", "offering"),
    "purchase": ("offering",),
    "compare": ("merchant", "offering"),
    "plan_experience": ("merchant", "offering"),
    "ask_merchant": ("merchant",),
    "unknown": ("merchant",),
}
DEFAULT_TENANT_ID = UUID("00000000-0000-0000-0000-000000000001")


class SearchBackend(Protocol):
    """DECISIONS D3: Postgres-only for phase 1, behind one seam so a real engine can slot in."""

    name: str

    async def merchant_candidates(self, **kw: Any) -> list[dict[str, Any]]: ...

    async def offering_candidates(self, **kw: Any) -> list[dict[str, Any]]: ...

    async def facts(self, subject_ids: Sequence[str]) -> list[dict[str, Any]]: ...

    async def hours(self, merchant_ids: Sequence[str]) -> list[dict[str, Any]]: ...

    async def slots(self, merchant_ids: Sequence[str], starts_at: datetime,
                    ends_at: datetime, party_size: int | None) -> list[dict[str, Any]]: ...

    async def feedback(self, user_id: str, subject_ids: Sequence[str]) -> list[dict[str, Any]]: ...

    async def user_preferences(self, user_id: str, kinds: Sequence[str] | None = None
                               ) -> list[dict[str, Any]]: ...


class PostgresBackend:
    """All SQL here is the parameterized builders in `nexus_ai.search.sql`."""

    name = "postgres"

    def __init__(self, database: Any, *, search_path: str = "public") -> None:
        self.db = database
        self.search_path = search_path

    async def merchant_candidates(self, **kw: Any) -> list[dict[str, Any]]:
        q = S.build_merchant_query(**kw)
        return await self.db.readonly(q.sql, *q.params, schema=self.search_path)

    async def offering_candidates(self, **kw: Any) -> list[dict[str, Any]]:
        q = S.build_offering_query(**kw)
        return await self.db.readonly(q.sql, *q.params, schema=self.search_path)

    async def facts(self, subject_ids: Sequence[str]) -> list[dict[str, Any]]:
        sql_text, params = S.facts_for(subject_ids)
        if not sql_text:
            return []
        return await self.db.readonly(sql_text, *params, schema=self.search_path)

    async def hours(self, merchant_ids: Sequence[str]) -> list[dict[str, Any]]:
        sql_text, params = S.hours_for(merchant_ids)
        if not sql_text:
            return []
        return await self.db.readonly(sql_text, *params, schema=self.search_path)

    async def slots(self, merchant_ids: Sequence[str], starts_at: datetime,
                    ends_at: datetime, party_size: int | None) -> list[dict[str, Any]]:
        sql_text, params = S.slots_for(merchant_ids, starts_at, ends_at, party_size)
        if not sql_text:
            return []
        return await self.db.readonly(sql_text, *params, schema=self.search_path)

    async def feedback(self, user_id: str, subject_ids: Sequence[str]) -> list[dict[str, Any]]:
        if not user_id or not subject_ids:
            return []
        sql_text = """
            SELECT subject_id::text AS subject_id, signal, value
            FROM feedback_events
            WHERE user_id::text = $1::uuid AND subject_id::text = ANY($2::text[])
            ORDER BY created_at DESC LIMIT 200
        """
        try:
            return await self.db.readonly(sql_text, str(user_id),
                                          [str(s) for s in subject_ids],
                                          schema=self.search_path)
        except Exception:  # pragma: no cover - telemetry must never break a search
            log.info("feedback read failed", exc_info=True)
            return []

    async def user_preferences(self, user_id: str, kinds: Sequence[str] | None = None
                               ) -> list[dict[str, Any]]:
        if not user_id:
            return []
        sql_text, params = S.user_preferences_for(user_id, kinds)
        if not sql_text:
            return []
        try:
            return await self.db.readonly(sql_text, *params, schema=self.search_path)
        except Exception:  # pragma: no cover - telemetry must never break a search
            log.info("user_preferences read failed", exc_info=True)
            return []


class StaticBackend:
    """Fixture-driven backend: keeps ranking/card/eval logic testable without a database."""

    name = "static"

    def __init__(self, merchants: Sequence[dict[str, Any]] = (),
                 offerings: Sequence[dict[str, Any]] = (),
                 facts: Sequence[dict[str, Any]] = (),
                 hours: Sequence[dict[str, Any]] = (),
                 slots: Sequence[dict[str, Any]] = ()) -> None:
        self.merchants = list(merchants)
        self.offerings = list(offerings)
        self._facts = list(facts)
        self._hours = list(hours)
        self._slots = list(slots)

    async def merchant_candidates(self, *, text=None, filters=None, **_kw: Any
                                  ) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.merchants]
        return _filter_static(rows, text or "", filters or {})

    async def offering_candidates(self, *, text=None, filters=None, **_kw: Any
                                  ) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.offerings]
        return _filter_static(rows, text or "", filters or {})

    async def facts(self, subject_ids: Sequence[str]) -> list[dict[str, Any]]:
        ids = {str(s) for s in subject_ids}
        return [dict(r) for r in self._facts if str(r.get("subject_id")) in ids]

    async def hours(self, merchant_ids: Sequence[str]) -> list[dict[str, Any]]:
        ids = {str(m) for m in merchant_ids}
        return [dict(r) for r in self._hours if str(r.get("merchant_id")) in ids]

    async def slots(self, merchant_ids, starts_at, ends_at, party_size) -> list[dict[str, Any]]:
        ids = {str(m) for m in merchant_ids}
        out = []
        for row in self._slots:
            if str(row.get("merchant_id")) not in ids:
                continue
            starts = row.get("starts_at")
            if isinstance(starts, datetime) and not (starts_at <= starts <= ends_at):
                continue
            if int(row.get("capacity_left") or 0) <= 0:
                continue
            out.append(dict(row))
        return out

    async def feedback(self, user_id: str, subject_ids: Sequence[str]) -> list[dict[str, Any]]:
        return []

    async def user_preferences(self, user_id: str, kinds: Sequence[str] | None = None
                               ) -> list[dict[str, Any]]:
        return []


def _filter_static(rows: list[dict[str, Any]], text: str,
                   filters: dict[str, Any]) -> list[dict[str, Any]]:
    low = (text or "").lower()
    out: list[dict[str, Any]] = []
    for r in rows:
        hay = " ".join(str(r.get(k) or "") for k in
                       ("display_name", "display_name_zh", "name", "name_zh", "description",
                        "category_primary", "district")).lower()
        hay += " " + " ".join(str(t) for t in (r.get("tags") or []))
        score = 0.0
        if low:
            tokens = _static_tokens(low)
            hits = sum(1 for t in tokens if t in hay)
            name_hit = any(t in str(r.get("display_name") or "").lower()
                           or t in str(r.get("name") or "").lower() for t in tokens)
            if hits == 0 and not name_hit:
                continue
            score = min(1.0, 0.25 * hits + (0.4 if name_hit else 0.0))
        if filters.get("category") and r.get("category_primary") != filters["category"]:
            continue
        if filters.get("district") and str(r.get("district") or "").lower() != \
                str(filters["district"]).lower():
            continue
        if filters.get("max_price") is not None and r.get("avg_price_hkd") is not None \
                and float(r["avg_price_hkd"]) > float(filters["max_price"]):
            continue
        r["kw_score"] = max(float(r.get("kw_score") or 0.0), score)
        r.setdefault("vec_score", 0.0)
        r.setdefault("text_matched", bool(low))
        r.setdefault("subject_type", "merchant" if r.get("display_name") else "offering")
        out.append(r)
    return out


def _static_tokens(low: str) -> list[str]:
    """Whitespace tokens plus CJK bigrams — Chinese queries carry no spaces, so a
    naive `split()` would filter every demo row out of a Chinese query.

    D405: the CJK bigram rule is `search/tokens.py`'s (`cjk_bigrams`), the one the live
    retrieval lane reads. This function used to carry its own copy of the CJK range,
    and two copies of a range are how two lanes start disagreeing about what a Chinese
    word is. Its OUTPUT is unchanged — the tokens, their order and their set are the
    same as before, which is why the offline search's own tests did not move."""
    from nexus_ai.search.tokens import cjk_bigrams

    toks = [t for t in low.split() if t]
    out: list[str] = []
    for t in toks:
        out.append(t)
        out.extend(cjk_bigrams(t))
    return sorted(set(out))


# --------------------------------------------------------------------------- request shaping
@dataclass
class SearchPlan:
    """What the deterministic pipeline needs from the caller — no model involved."""

    query_text: str = ""
    subject_types: tuple[str, ...] = ("merchant",)
    filters: dict[str, Any] = field(default_factory=dict)
    geo: tuple[float, float] | None = None
    radius_m: int | None = None
    budget_max: float | None = None
    budget_per: str = "party"
    party_size: int | None = None
    at: datetime | None = None
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    open_now: bool = False
    open_late_after: int | None = None
    sort_preference: str = "relevance"
    avoid: list[str] = field(default_factory=list)
    # Soft preference signals for the ranking lane. Never a hard filter: only explicit
    # `filters.attributes` from the caller reaches the SQL containment clause (D381).
    attributes: dict[str, Any] = field(default_factory=dict)
    limit: int = 20


def plan_from_intent(intent: Intent | None, *, query: str | None = None,
                     geo: Any = None, filters: Any = None, now: datetime | None = None,
                     limit: int = 20, locale: str = "zh-HK") -> SearchPlan:
    from nexus_ai.nlu.lexicon import DISTRICTS

    now = now or datetime.now(timezone.utc)
    plan = SearchPlan(now=now, limit=limit)
    plan.query_text = (query or (intent.raw_query if intent else "") or "").strip()
    if intent is None:
        plan.filters = _plain(filters)
        _apply_geo(plan, geo)
        return plan

    plan.subject_types = KIND_TO_SUBJECT.get(intent.intent, ("merchant",))
    if filters and _plain(filters).get("kind") in ("product", "service", "experience"):
        plan.subject_types = ("offering",)
    out = plan.filters = _plain(filters)
    out.setdefault("category", intent.category)
    if intent.location and intent.location.value:
        out.setdefault("district", intent.location.value)
    if intent.location and intent.location.radius_m:
        plan.radius_m = int(intent.location.radius_m)
    _apply_geo(plan, geo)
    if plan.geo is None and intent.location and intent.location.resolved:
        plan.geo = (intent.location.resolved.lat, intent.location.resolved.lng)
    if plan.geo is None and out.get("district"):
        d = DISTRICTS.get(str(out["district"]))
        if d:
            plan.geo = (d["lat"], d["lng"])
            plan.radius_m = plan.radius_m or int(d.get("radius_m") or 2500)
    if intent.budget:
        plan.budget_max = intent.budget.max
        plan.budget_per = intent.budget.per or "party"
    plan.party_size = intent.party_size
    plan.sort_preference = intent.sort_preference or "relevance"
    plan.at = intent.time.starts_at if intent.time else None
    if intent.time and intent.time.quality and intent.time.quality.startswith(
            "open_late_after:"):
        plan.open_late_after = int(intent.time.quality.split(":", 1)[1])
    if intent.time and intent.time.type == "unspecified" and not plan.at:
        plan.at = None
    if intent.urgency == "now":
        plan.open_now = True
    for c in intent.constraints:
        if c.key in ("cuisine_avoid", "avoid", "exclude"):
            plan.avoid.append(c.value)
    # `preferences` are SOFT (§7.1: "ambience: quiet" is a preference, not a constraint) and
    # must not become WHERE clauses. The old mapping wrote `{"occasion": true}` into the JSONB
    # attribute filter, which no seeded merchant carries, so a Chinese sentence whose only
    # signal was a preference returned zero rows before ranking ever ran (D381). The value was
    # also lost in the collapse to `True`, so even a matching key could not match its value.
    # They stay on the Intent for the ranking lane; only the caller's explicit
    # `filters.attributes` is a hard containment filter.
    out["avoid"] = plan.avoid
    out["attributes"] = {**out.get("attributes", {}), **plan.attributes}
    out["open_now"] = plan.open_now
    if plan.open_late_after is not None:
        out["min_closing_hour"] = plan.open_late_after
    out["open_weekday"] = plan.at.astimezone(HK_TZ).weekday() if plan.at else None
    # D399: the open-at-time filter binds a `time` COLUMN, and a `time` column needs a
    # `datetime.time` - a string made asyncpg raise
    # `invalid input for query argument $7: '18:00:00' ('str' object has no attribute 'hour')`
    # on every query carrying a clock time, which is the product's own e2e sentence
    # ("...周六晚上"). The value is a time, not a string that happens to look like one.
    out["open_time"] = plan.at.astimezone(HK_TZ).time() if plan.at else None
    plan.filters = {k: v for k, v in out.items() if v not in (None, "", [], {})}
    return plan


def _plain(filters: Any) -> dict[str, Any]:
    if filters is None:
        return {}
    if isinstance(filters, dict):
        return dict(filters)
    return dict(filters.model_dump(exclude_none=True))


def _apply_geo(plan: SearchPlan, geo: Any) -> None:
    if geo is None:
        return
    if isinstance(geo, dict):
        lat, lng = geo.get("lat"), geo.get("lng")
    else:
        lat, lng = getattr(geo, "lat", None), getattr(geo, "lng", None)
    if lat is not None and lng is not None:
        plan.geo = (float(lat), float(lng))
        plan.radius_m = plan.radius_m or 5000


# --------------------------------------------------------------------------- the pipeline
def _row_price(row: dict[str, Any]) -> float | None:
    for key in ("price_amount", "avg_price_hkd", "price_min"):
        if row.get(key) is not None:
            return float(row[key])
    return None


def _row_sponsored(row: dict[str, Any]) -> bool:
    attrs = row.get("attributes") or {}
    if isinstance(attrs, str):
        try:
            attrs = json.loads(attrs)
        except Exception:
            attrs = {}
    return bool(attrs.get("sponsored") or attrs.get("promoted"))


def _relevance(row: dict[str, Any], *, vector_lane: bool) -> float:
    kw = float(row.get("kw_score") or 0.0)
    vec = float(row.get("vec_score") or 0.0) if vector_lane else 0.0
    fused = max(kw, vec) + 0.35 * min(kw, vec)
    return round(max(0.0, min(1.0, fused)), 4)


def candidates_from_rows(rows: Sequence[dict[str, Any]], plan: SearchPlan, *,
                         bundle: FactBundle, facts_by_subject: dict[str, list[Any]],
                         hours_by_merchant: dict[str, list[Any]],
                         slots_by_merchant: dict[str, dict[str, Any]],
                         personalization: dict[str, float],
                         weights: RankingWeights,
                         vector_lane: bool,
                         preference_labels: dict[str, list[dict[str, str]]] | None = None,
                         ) -> list[Candidate]:
    out: list[Candidate] = []
    for row in rows:
        subject_type = str(row.get("subject_type") or "merchant")
        subject_id = str(row.get("subject_id") or row.get("id"))
        merchant_id = str(row.get("merchant_id") or row.get("merchant_id_key") or subject_id)
        av_row = slots_by_merchant.get(merchant_id)
        availability = None
        if av_row:
            left = int(av_row.get("capacity_left") or 0)
            need = int(plan.party_size or 1)
            availability = "available" if left >= need else ("limited" if left else "full")
        open_state = compute_open(hours_by_merchant.get(merchant_id, []), now=plan.now,
                                  at=plan.at) if subject_type == "merchant" else None
        cand = Candidate(
            subject_type=subject_type, subject_id=subject_id, merchant_id=merchant_id,
            relevance=_relevance(row, vector_lane=vector_lane),
            rating=_num(row.get("rating_agg")),
            rating_count=int(row.get("review_count") or 0),
            tenant_mean_rating=_num(row.get("tenant_mean_rating")) or 3.5,
            distance_m=_num(row.get("meters")),
            price=_row_price(row),
            budget_max=plan.budget_max, budget_per=plan.budget_per,
            availability=availability,
            popularity=_num(row.get("popularity_score")) or 0.0,
            freshness=mean_remaining_fraction(facts_by_subject.get(subject_id, []),
                                              now=plan.now),
            personalization=personalization.get(subject_id),
            sponsored=_row_sponsored(row),
            open_now=None if (open_state or {}).get("is_open") is None
            else bool((open_state or {}).get("is_open")),
            district=row.get("district") or (row.get("area")),
            category=row.get("category") or row.get("category_primary") or row.get("kind"),
            raw={"row": row, "text_matched": bool(row.get("text_matched")),
                 "as_of": plan.now, "organic_rank": None,
                 "preference_labels": list((preference_labels or {}).get(subject_id, [])),
                 "availability": ({"status": availability,
                                   "next_slot": _iso(av_row.get("starts_at"))}
                                  if av_row else None),
                 "open_state": open_state,
                 "slot": av_row},
        )
        out.append(cand)
    return out


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _slot_window(plan: SearchPlan) -> tuple[datetime, datetime] | None:
    if plan.at is None:
        if not plan.open_now:
            return None
        start = plan.now
        return start, start + timedelta(hours=3)
    at = plan.at if plan.at.tzinfo else plan.at.replace(tzinfo=timezone.utc)
    return at - timedelta(minutes=30), at + timedelta(hours=2)


async def search(*, backend: SearchBackend, plan: SearchPlan,
                 weights: RankingWeights | None = None,
                 tenant_id: UUID | str = DEFAULT_TENANT_ID,
                 embedding: Sequence[float] | None = None,
                 vector_lane: bool = False,
                 user_id: str | None = None,
                 intent_preferences: Sequence[dict[str, Any]] | None = None,
                 locale: str = "zh-HK",
                 include_sponsored: bool = True) -> tuple[list[EntityCard], SearchResponse,
                                                          FactBundle, list[Scored]]:
    """Deterministic search end-to-end. Returns cards, the response, the grounding bundle and
    the scored list (the latter two feed `/ai/v1/recommend`, compare and the eval harness).

    `intent_preferences`: optional NLU-extracted preferences from the current query's Intent.
    These are transient per-query signals (e.g., occasion=date from "帮我找一个适合情侣约会的地方"),
    distinct from persistent `user_preferences` stored in the database.
    """
    started = time.perf_counter()
    w = weights or load_ranking_weights(_default_weights_path())
    bundle = FactBundle()
    subject_ids: list[str] = []
    merchant_ids: list[str] = []
    rows: list[dict[str, Any]] = []

    common = dict(tenant_id=str(tenant_id), text=plan.query_text or None,
                  filters=plan.filters, geo=plan.geo, radius_m=plan.radius_m,
                  limit=max(60, plan.limit * 3))
    if "merchant" in plan.subject_types:
        rows += await backend.merchant_candidates(embedding=list(embedding) if embedding
                                                  else None, **common)
    if "offering" in plan.subject_types:
        rows += await backend.offering_candidates(**{k: v for k, v in common.items()
                                                     if k != "embedding"})
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for r in rows:
        subject_key = f"{r.get('subject_type')}:{r.get('subject_id') or r.get('id')}"
        if subject_key in seen:
            continue
        seen.add(subject_key)
        deduped.append(r)
        subject_ids.append(str(r.get("subject_id") or r.get("id")))
        merchant_ids.append(str(r.get("merchant_id") or r.get("merchant_id_key")
                                or r.get("id")))

    fact_rows = await backend.facts(subject_ids) if subject_ids else []
    for fact in facts_from_rows(fact_rows, now=plan.now):
        bundle.add(fact)
    facts_by_subject: dict[str, list[Any]] = {}
    for raw in fact_rows:
        facts_by_subject.setdefault(str(raw.get("subject_id")), []).append(raw)

    hours_rows = await backend.hours(list(dict.fromkeys(merchant_ids))) if merchant_ids else []
    hours_by_merchant: dict[str, list[Any]] = {}
    for raw in hours_rows:
        hours_by_merchant.setdefault(str(raw.get("merchant_id")), []).append(raw)

    slots_by_merchant: dict[str, dict[str, Any]] = {}
    window = _slot_window(plan)
    if window and merchant_ids:
        slot_rows = await backend.slots(list(dict.fromkeys(merchant_ids)), window[0],
                                        window[1], plan.party_size)
        for raw in slot_rows:
            mid = str(raw.get("merchant_id"))
            cur = slots_by_merchant.get(mid)
            if cur is None or (raw.get("starts_at") and cur.get("starts_at")
                               and raw["starts_at"] < cur["starts_at"]):
                slots_by_merchant[mid] = raw

    personalization: dict[str, float] = {}
    # D392: which preference fired for which subject, so the card can name it.
    preference_labels: dict[str, list[dict[str, str]]] = {}

    # Build merchant_attrs map once for all preference types
    merchant_attrs: dict[str, dict] = {}
    for r in deduped:
        mid = str(r.get("merchant_id") or r.get("id"))
        attrs = r.get("attributes")
        if attrs and mid not in merchant_attrs:
            if isinstance(attrs, str):
                try:
                    attrs = json.loads(attrs)
                except Exception:
                    attrs = {}
            merchant_attrs[mid] = attrs

    # 1. Feedback-based personalization (requires user_id and subject_ids)
    grouped: dict[str, list[float]] = {}
    if user_id and subject_ids:
        fb_rows = await backend.feedback(str(user_id), subject_ids)
        for raw in fb_rows:
            val = _feedback_value(raw)
            if val is not None:
                grouped.setdefault(str(raw.get("subject_id")), []).append(val)
        for sid, values in grouped.items():
            sig = personalization_signal(values, w.personalization)
            if sig is not None:
                personalization[sid] = sig

    # 2. Persistent user_preferences from database (D382, requires user_id)
    # Applies to ALL candidates, not just those with feedback
    if user_id:
        pref_rows = await backend.user_preferences(str(user_id))
        if pref_rows:
            # Parse structured preference values and build matching rules
            pref_rules: list[dict[str, Any]] = []
            for p in pref_rows:
                kind = p.get("kind")
                key = p.get("key")
                weight = p.get("weight")
                raw_value = p.get("value")
                if not (kind and key and weight is not None):
                    continue
                
                try:
                    value = json.loads(raw_value) if isinstance(raw_value, str) else raw_value
                except Exception:
                    value = {}
                
                match_fn = None
                
                # FOOD: cuisine_like / cuisine_dislike -> array of cuisines
                if kind == "food" and key in ("cuisine_like", "cuisine_dislike"):
                    cuisines = value.get("values") if isinstance(value, dict) else []
                    if cuisines:
                        is_like = key == "cuisine_like"
                        def make_cuisine_match(cats, is_like_pref, w):
                            def _match(attrs):
                                # D394: the named cuisine and the merchant's taxonomy are
                                # different vocabularies ("japanese" vs "sushi"), so the
                                # match goes through the lexicon's leaf map.
                                cat = str(attrs.get("category_primary") or "")
                                tags = [str(t) for t in (attrs.get("tags") or [])]
                                has_match = any(cuisine_matches(c, cat, tags) for c in cats)
                                if has_match:
                                    # Match found: like -> the preference's weight,
                                    # dislike -> its inverse (a dislike is a negative signal).
                                    return w if is_like_pref else 1.0 - w
                                else:
                                    # No match: like -> neutral (0.5), dislike -> the
                                    # weight (not having a disliked cuisine is a mild positive).
                                    return 0.5 if is_like_pref else w
                            return _match
                        match_fn = make_cuisine_match(cuisines, is_like, float(weight))
                
                # BUDGET: per_person_max_hkd -> numeric budget
                elif kind == "budget" and key == "per_person_max_hkd":
                    budget_val = value.get("value") if isinstance(value, dict) else None
                    if budget_val is not None:
                        def make_budget_match(budget, w):
                            def _match(attrs):
                                price = attrs.get("avg_price_hkd")
                                if price is None:
                                    return None
                                try:
                                    price = float(price)
                                except Exception:
                                    return None
                                if price <= budget:
                                    return w
                                return max(0.0, 1.0 - w)
                            return _match
                        match_fn = make_budget_match(float(budget_val), float(weight))
                
                # LOCATION: home_district -> district match
                elif kind == "location" and key == "home_district":
                    district = value.get("value") if isinstance(value, dict) else None
                    if district:
                        def make_district_match(dist, w):
                            def _match(attrs):
                                mer_dist = str(attrs.get("district") or "").lower()
                                if mer_dist == dist.lower():
                                    return w
                                return None
                            return _match
                        match_fn = make_district_match(str(district), float(weight))
                
                # STYLE: ambience -> string enum (quiet, lively, etc.)
                elif kind == "style" and key == "ambience":
                    ambience = value.get("value") if isinstance(value, dict) else None
                    if ambience:
                        def make_ambience_match(amb, w):
                            def _match(attrs):
                                if amb == "quiet":
                                    if attrs.get("quiet_ambience") is True:
                                        return w
                                    if attrs.get("lively_ambience") is True:
                                        return 1.0 - w
                                elif amb == "lively":
                                    if attrs.get("lively_ambience") is True:
                                        return w
                                    if attrs.get("quiet_ambience") is True:
                                        return 1.0 - w
                                return None
                            return _match
                        match_fn = make_ambience_match(str(ambience), float(weight))
                
                # ACCESS: pet_friendly -> boolean
                elif kind == "access" and key == "pet_friendly":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_pet_match(v, w):
                            def _match(attrs):
                                if attrs.get("pet_friendly_access") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("pet_friendly_access") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_pet_match(val, float(weight))

                # OCCASION: date, group, family, business, solo -> boolean
                elif kind == "occasion" and key in ("date", "group", "family", "business", "solo"):
                    val = value.get("value") if isinstance(value, dict) else None
                    # For occasion, the value is the occasion type (e.g., "date", "group")
                    # We check if the merchant has the corresponding occasion attribute
                    occasion_key = f"{key}_occasion"
                    if key == "solo":
                        occasion_key = "solo_occasion"
                    elif key == "group":
                        occasion_key = "group_occasion"
                    elif key == "family":
                        occasion_key = "family_occasion"
                    elif key == "business":
                        occasion_key = "business_occasion"
                    elif key == "date":
                        occasion_key = "date_occasion"

                    def make_occasion_match(occ_key, w):
                        def _match(attrs):
                            if attrs.get(occ_key) is True:
                                return 1.0
                            if attrs.get(occ_key) is False:
                                return 0.0
                            return 0.5  # neutral if not specified
                        return _match
                    match_fn = make_occasion_match(occasion_key, float(weight))

                # VIEW: scenic -> boolean
                elif kind == "view" and key == "scenic":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_scenic_match(v, w):
                            def _match(attrs):
                                if attrs.get("scenic_view") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("scenic_view") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_scenic_match(val, float(weight))

                # PRICE SENSE: cheap, premium
                elif kind == "price_sense" and key in ("cheap", "premium"):
                    is_cheap = key == "cheap"
                    def make_price_sense_match(is_cheap_pref, w):
                        def _match(attrs):
                            price = attrs.get("avg_price_hkd")
                            if price is None:
                                return None
                            try:
                                price = float(price)
                            except Exception:
                                return None
                            if is_cheap_pref:
                                # cheap: prefer lower prices
                                if price <= 100:
                                    return w
                                elif price <= 200:
                                    return w * 0.5
                                return 0.0
                            else:
                                # premium: prefer higher prices
                                if price >= 400:
                                    return w
                                elif price >= 200:
                                    return w * 0.5
                                return 0.0
                        return _match
                    match_fn = make_price_sense_match(is_cheap, float(weight))

                # WEATHER: rainy_day -> boolean
                elif kind == "weather" and key == "rainy_day":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_rainy_match(v, w):
                            def _match(attrs):
                                # rainy_day preference: prefer indoor venues
                                if attrs.get("indoor_style") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("outdoor_style") is True:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_rainy_match(val, float(weight))

                # TIME PREF: open_late -> boolean
                elif kind == "time_pref" and key == "open_late":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_late_match(v, w):
                            def _match(attrs):
                                if attrs.get("opens_late") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("opens_late") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_late_match(val, float(weight))

                # CUISINE: spicy
                elif kind == "cuisine" and key == "spicy":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_spicy_match(v, w):
                            def _match(attrs):
                                if attrs.get("spicy_cuisine") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("spicy_cuisine") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_spicy_match(val, float(weight))

                # STYLE: outdoor, indoor
                elif kind == "style" and key in ("outdoor", "indoor"):
                    is_outdoor = key == "outdoor"
                    def make_outdoor_match(is_outdoor_pref, w):
                        def _match(attrs):
                            if is_outdoor_pref:
                                if attrs.get("outdoor_style") is True:
                                    return w
                                if attrs.get("indoor_style") is True:
                                    return 1.0 - w
                                if attrs.get("outdoor_seating") is True:
                                    return w * 0.8
                            else:
                                if attrs.get("indoor_style") is True:
                                    return w
                                if attrs.get("outdoor_style") is True:
                                    return 1.0 - w
                                if attrs.get("outdoor_seating") is True:
                                    return 1.0 - w * 0.8
                            return None
                        return _match
                    match_fn = make_outdoor_match(is_outdoor, float(weight))

                # ACCESS: mtr_near -> boolean
                elif kind == "access" and key == "mtr_near":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_mtr_match(v, w):
                            def _match(attrs):
                                if attrs.get("mtr_near_access") is True or attrs.get("mtr_within_5min") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("mtr_near_access") is False and attrs.get("mtr_within_5min") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_mtr_match(val, float(weight))

                # ACCESS: accessible -> boolean
                elif kind == "access" and key == "accessible":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_accessible_match(v, w):
                            def _match(attrs):
                                if attrs.get("accessible_access") is True or attrs.get("wheelchair_access") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("accessible_access") is False and attrs.get("wheelchair_access") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_accessible_match(val, float(weight))

                # ACCESS: parking -> boolean
                elif kind == "access" and key == "parking":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_parking_match(v, w):
                            def _match(attrs):
                                if attrs.get("parking_access") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("parking_access") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_parking_match(val, float(weight))

                # ACCESS: pet_friendly -> boolean
                elif kind == "access" and key == "pet_friendly":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_pet_match(v, w):
                            def _match(attrs):
                                if attrs.get("pet_friendly_access") is True:
                                    return w if v else (1.0 - w)
                                if attrs.get("pet_friendly_access") is False:
                                    return 1.0 - w if v else w
                                return None
                            return _match
                        match_fn = make_pet_match(val, float(weight))
                
                if match_fn:
                    pref_rules.append({
                        "kind": kind,
                        "key": key,
                        "label": _preference_label(kind, key, value),
                        # D396: where the preference came from. "declared" is the user
                        # telling us, "inferred" is the platform's reading of their
                        # behaviour, "transaction" is something they did.
                        "source": str(p.get("source") or "declared"),
                        "weight": float(weight),
                        "match_fn": match_fn
                    })
            
            # Apply user_preferences to ALL candidates (not just those with feedback)
            if pref_rules:
                for r in deduped:
                    sid = str(r.get("subject_id") or r.get("id"))
                    mid = str(r.get("merchant_id") or r.get("id"))
                    if mid not in merchant_attrs:
                        continue
                    attrs = merchant_attrs[mid]
                    # Also include relevant top-level fields for budget/district matching
                    enriched_attrs = dict(attrs)
                    for field in ("avg_price_hkd", "district", "category_primary", "tags"):
                        if r.get(field) is not None:
                            enriched_attrs[field] = r.get(field)
                    pref_scores: list[float] = []
                    matched_labels: list[dict[str, str]] = []
                    for rule in pref_rules:
                        score = rule["match_fn"](enriched_attrs)
                        if score is not None:
                            pref_scores.append(score)
                            # D392: name the preference that actually fired, so the card can
                            # say WHICH preference matched instead of "matches your preferences".
                            # D396: the source travels with the name, so a preference the
                            # user declared and one they typed in this query are
                            # distinguishable on the card.
                            if score >= 0.5:
                                matched_labels.append(
                                    {"label": rule["label"], "source": rule["source"]})
                    if pref_scores:
                        avg_score = sum(pref_scores) / len(pref_scores)
                        existing = personalization.get(sid)
                        # D397: the preference and the feedback answer the SAME question
                        # ("does this fit this user") from two different kinds of
                        # evidence, so the better evidence wins rather than the average
                        # of the two. Averaging let a weak click history dilute a
                        # preference the user DECLARED at 0.95 down to 0.675, which is
                        # the platform saying "you said you want quiet, but we think
                        # you do not" - a claim it cannot make.
                        personalization[sid] = (avg_score if existing is None
                                                else max(existing, avg_score))
                    if matched_labels:
                        preference_labels.setdefault(sid, []).extend(matched_labels)

    # 3. Transient NLU intent_preferences from current query (D382 follow-up)
    # Works without user_id - applies to all candidates
    if intent_preferences and merchant_attrs:
        # D392: the labels dict is declared above, so a query with no stored preferences
        # still records which one fired.
        for r in deduped:
            sid = str(r.get("subject_id") or r.get("id"))
            mid = str(r.get("merchant_id") or r.get("id"))
            if mid not in merchant_attrs:
                continue
            attrs = merchant_attrs[mid]
            intent_pref_scores: list[float] = []
            intent_matched_labels: list[dict[str, str]] = []
            for pref in intent_preferences:
                pref_kind = pref.get("key")
                pref_value = pref.get("value")
                polarity = pref.get("polarity", 1)
                if not pref_kind or not pref_value:
                    continue

                # D394: a typed cuisine ("japanese") meets the taxonomy ("sushi") through
                # the lexicon's leaf map, not through an attribute name.
                if str(pref_kind) == "cuisine":
                    cat = str(attrs.get("category_primary") or "")
                    tags = [str(t) for t in (attrs.get("tags") or [])]
                    if cuisine_matches(str(pref_value), cat, tags):
                        weight = 1.0 if polarity > 0 else 0.0
                        intent_pref_scores.append(weight)
                        if weight >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                                           pref_value),
                                 "source": "typed"})
                    else:
                        intent_pref_scores.append(0.5 if polarity > 0 else 1.0)
                    continue

                attr_key1 = f"{pref_value}_{pref_kind}"  # date_occasion
                attr_key2 = f"{pref_kind}_{pref_value}"  # occasion_date
                
                for attr_key in (attr_key1, attr_key2):
                    if attrs.get(attr_key) is True:
                        weight = 1.0 if polarity > 0 else 0.0
                        intent_pref_scores.append(weight)
                        # D392: name the preference that fired, so the card can say WHICH.
                        # D396: a preference typed in THIS query is "typed", not "declared".
                        if weight >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                                           pref_value),
                                 "source": "typed"})
                        break
                    elif attrs.get(attr_key) is False:
                        weight = 0.0 if polarity > 0 else 1.0
                        intent_pref_scores.append(weight)
                        if weight >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                                           pref_value),
                                 "source": "typed"})
                        break
            if intent_pref_scores:
                avg_score = sum(intent_pref_scores) / len(intent_pref_scores)
                existing = personalization.get(sid)
                # D397: the better evidence wins; see the stored path above.
                personalization[sid] = (avg_score if existing is None
                                        else max(existing, avg_score))
            if intent_matched_labels:
                preference_labels.setdefault(sid, []).extend(intent_matched_labels)

    candidates = candidates_from_rows(deduped, plan, bundle=bundle,
                                      facts_by_subject=facts_by_subject,
                                      hours_by_merchant=hours_by_merchant,
                                      slots_by_merchant=slots_by_merchant,
                                      personalization=personalization, weights=w,
                                      vector_lane=vector_lane,
                                      preference_labels=preference_labels)
    ranked = organic_rank(candidates, w)
    ranked = apply_sort_preference(ranked, plan.sort_preference)
    ranked = apply_sponsored(ranked, w) if include_sponsored else ranked

    facets_raw = facet_counts([s.candidate for s in ranked], w.facets)
    facets = {k: [FacetValue(value=v, count=c) for v, c in
                 sorted(d.items(), key=lambda x: (-x[1], x[0]))]
              for k, d in facets_raw.items() if d}

    top = ranked[: max(1, plan.limit)]
    cards: list[EntityCard] = []
    for scored in top:
        cand = scored.candidate
        card = build_card(cand, scored, bundle, locale=locale,
                          open_state=cand.raw.get("open_state"),
                          availability=cand.raw.get("availability"),
                          query=plan.query_text,
                          sponsor_label=(sponsor_label(locale, w) if cand.sponsored else None))
        cards.append(attach_price_staleness(card, bundle))

    took_ms = int((time.perf_counter() - started) * 1000)
    strategy = f"{w.version}+{backend.name}"
    if vector_lane:
        strategy += "+vector"
    response = SearchResponse(
        items=cards, facets=facets, took_ms=took_ms, strategy=strategy,
        degraded=False, provider="none", total_estimate=len(ranked),
        agent_run_id=None, relevance_floor_applied=True)
    return cards, response, bundle, top


#: How a preference is named on a card, in the user's words. The key is the
#: preference's (kind, key) pair; the entry is what the card prints.
_PREFERENCE_LABEL_COPY: dict[tuple[str, str], dict[str, str]] = {
    ("style", "ambience"): {"zh-HK": "氣氛偏好", "zh-CN": "氛围偏好", "en": "your ambience"},
    ("ambience", "quiet"): {"zh-HK": "安靜", "zh-CN": "安静", "en": "quiet"},
    ("ambience", "lively"): {"zh-HK": "熱鬧", "zh-CN": "热闹", "en": "lively"},
    ("occasion", "date"): {"zh-HK": "約會場合", "zh-CN": "约会场合", "en": "a date"},
    ("occasion", "group"): {"zh-HK": "聚會場合", "zh-CN": "聚会场合", "en": "a group outing"},
    ("occasion", "family"): {"zh-HK": "家庭聚餐", "zh-CN": "家庭聚餐", "en": "a family meal"},
    ("occasion", "business"): {"zh-HK": "商務宴請", "zh-CN": "商务宴请", "en": "a business meal"},
    ("occasion", "solo"): {"zh-HK": "一個人用餐", "zh-CN": "一个人用餐", "en": "dining alone"},
    ("access", "mtr_near"): {"zh-HK": "近地鐵", "zh-CN": "近地铁", "en": "near the MTR"},
    ("access", "accessible"): {"zh-HK": "無障礙", "zh-CN": "无障碍", "en": "step-free access"},
    ("access", "parking"): {"zh-HK": "有停車位", "zh-CN": "有停车位", "en": "parking"},
    ("access", "pet_friendly"): {"zh-HK": "可帶寵物", "zh-CN": "可带宠物", "en": "pet-friendly"},
    ("view", "scenic"): {"zh-HK": "好景觀", "zh-CN": "好景观", "en": "a good view"},
    ("price_sense", "cheap"): {"zh-HK": "價錢相宜", "zh-CN": "价钱相宜", "en": "good value"},
    ("price_sense", "premium"): {"zh-HK": "高檔次", "zh-CN": "高档次", "en": "premium"},
    ("weather", "rainy_day"): {"zh-HK": "下雨天都合適", "zh-CN": "下雨天都合适", "en": "good on a rainy day"},
    ("time_pref", "open_late"): {"zh-HK": "營業至夜深", "zh-CN": "营业至夜深", "en": "open late"},
    ("cuisine", "spicy"): {"zh-HK": "辣味", "zh-CN": "辣味", "en": "spicy"},
    ("style", "outdoor"): {"zh-HK": "戶外", "zh-CN": "户外", "en": "outdoor"},
    ("style", "indoor"): {"zh-HK": "室內", "zh-CN": "室内", "en": "indoor"},
}

#: A preference whose VALUE is itself the thing the user asked for (an enum, not a
#: boolean) is named by that value: "quiet" says more than "ambience" does.
_PREFERENCE_VALUE_LABEL_COPY: dict[str, dict[str, str]] = {
    "quiet": {"zh-HK": "安靜", "zh-CN": "安静", "en": "quiet"},
    "lively": {"zh-HK": "熱鬧", "zh-CN": "热闹", "en": "lively"},
    "ambience": {"zh-HK": "氣氛", "zh-CN": "氛围", "en": "ambience"},
    "date": {"zh-HK": "約會", "zh-CN": "约会", "en": "a date"},
    "group": {"zh-HK": "聚會", "zh-CN": "聚会", "en": "a group"},
    "family": {"zh-HK": "家庭聚餐", "zh-CN": "家庭聚餐", "en": "a family meal"},
    "business": {"zh-HK": "商務宴請", "zh-CN": "商务宴请", "en": "a business meal"},
    "solo": {"zh-HK": "一個人用餐", "zh-CN": "一个人用餐", "en": "dining alone"},
    "scenic": {"zh-HK": "好景觀", "zh-CN": "好景观", "en": "a good view"},
    "cheap": {"zh-HK": "價錢相宜", "zh-CN": "价钱相宜", "en": "good value"},
    "premium": {"zh-HK": "高檔次", "zh-CN": "高档次", "en": "premium"},
    "spicy": {"zh-HK": "辣味", "zh-CN": "辣味", "en": "spicy"},
    "outdoor": {"zh-HK": "戶外", "zh-CN": "户外", "en": "outdoor"},
    "indoor": {"zh-HK": "室內", "zh-CN": "室内", "en": "indoor"},
    "mtr_near": {"zh-HK": "近地鐵", "zh-CN": "近地铁", "en": "near the MTR"},
    "accessible": {"zh-HK": "無障礙", "zh-CN": "无障碍", "en": "step-free access"},
    "parking": {"zh-HK": "有停車位", "zh-CN": "有停车位", "en": "parking"},
    "pet_friendly": {"zh-HK": "可帶寵物", "zh-CN": "可带宠物", "en": "pet-friendly"},
    "rainy_day": {"zh-HK": "下雨天都合適", "zh-CN": "下雨天都合适", "en": "good on a rainy day"},
    "open_late": {"zh-HK": "營業至夜深", "zh-CN": "营业至夜深", "en": "open late"},
}


def _preference_label(kind: str, key: str, value: Any) -> str:
    """A short, human name for the preference that fired (D392).

    The card says WHICH preference matched, not merely that one did. An enum-valued
    preference is named by its value ("安靜"), because the value is what the user
    asked for; a boolean one is named by its key ("近地鐵"). The copy is per locale,
    and a pair the copy does not know falls back to the raw value, which is still
    better than a bullet that names nothing.
    """
    # The stored value is the preference's JSONB; the thing the user asked for is
    # usually the inner "value" ("quiet"), so that is what the card names.
    inner = value.get("value") if isinstance(value, dict) else value
    if isinstance(inner, str) and inner:
        by_value = _PREFERENCE_VALUE_LABEL_COPY.get(inner.lower())
        if by_value:
            return by_value.get("zh-HK", inner)
    copy = _PREFERENCE_LABEL_COPY.get((str(kind), str(key)))
    if copy:
        return copy.get("zh-HK", str(key))
    if isinstance(inner, str) and inner:
        return inner
    return str(key)


def _feedback_value(row: dict[str, Any]) -> float | None:
    signal = str(row.get("signal") or "")
    value = row.get("value")
    if isinstance(value, dict):
        for k in ("rating", "value", "score"):
            if value.get(k) is not None:
                try:
                    return float(value[k]) / 5.0 if float(value[k]) > 1 else float(value[k])
                except (TypeError, ValueError):
                    return None
    return {"save": 1.0, "favorite": 1.0, "click": 0.6, "reserve": 1.0, "purchase": 1.0,
            "dismiss": 0.0, "hide": 0.0, "share": 0.9}.get(signal)


def _default_weights_path() -> Any:
    from nexus_ai.config import get_settings

    return get_settings().ranking_weights_path


__all__ = ["SearchBackend", "PostgresBackend", "StaticBackend", "SearchPlan",
           "plan_from_intent", "search", "candidates_from_rows", "DEFAULT_TENANT_ID"]
