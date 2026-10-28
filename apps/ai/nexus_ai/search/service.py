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
from nexus_ai.nlu.lexicon import (
    CONSTRAINT_RULES,
    canon_constraint,
    cuisine_matches,
)
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

#: D546: the constraint keys whose value names a thing the answer must NOT carry. The set is
#: derived from the lexicon's own `CONSTRAINT_RULES` - not copied out of it - because the
#: hand-written tuple it replaces named three of the five keys the refusal lane writes, and
#: the two it missed were the ones whose values the corpus records most often.
AVOID_CONSTRAINT_KEYS: frozenset[str] = frozenset(
    {"avoid", "exclude", *(key for key, _negations, _values in CONSTRAINT_RULES)})


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
            WHERE user_id = $1::uuid AND subject_id = ANY($2::uuid[])
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
        # D549: the merchant lane's avoid clause reads the merchant's OWN offerings too
        # (`EXISTS (SELECT 1 FROM offerings ao WHERE ao.merchant_id = m.id ...)`), so the
        # fixture lane is handed the same list the live lane would join against.
        return _filter_static(rows, text or "", filters or {}, offerings=self.offerings)

    async def offering_candidates(self, *, text=None, filters=None,
                                  party_size: int | None = None, **_kw: Any
                                  ) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.offerings]
        return _filter_static(rows, text or "", filters or {}, party_size=party_size)

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
                   filters: dict[str, Any],
                   offerings: Sequence[dict[str, Any]] = (),
                   party_size: int | None = None) -> list[dict[str, Any]]:
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
        if filters.get("category"):
            # D596: the live lane resolves the bucket into taxonomy slugs and walks one tree
            # level; this lane compared the bucket to `category_primary`, which on a live row
            # holds the leaf's DISPLAY NAME ("Tea House"). Measured at HEAD: `category=cafe`
            # kept 79 merchants live and 0 here, restaurant 184 and 0. A row that carries the
            # resolved slugs (`category_slugs`, both lanes' SELECT) is matched on them; a
            # fixture that stores the coarse bucket itself keeps the old comparison.
            from nexus_ai.search.categories import canonical_tag, resolve

            bucket = str(filters["category"])
            slugs = {canonical_tag(x) for x in resolve(bucket)}
            row_slugs = {canonical_tag(str(x)) for x in (r.get("category_slugs") or [])}
            if row_slugs:
                if not (row_slugs & slugs):
                    continue
            elif r.get("category_primary") != bucket:
                continue
        if filters.get("district") and str(r.get("district") or "").lower() != \
                str(filters["district"]).lower():
            continue
        if filters.get("max_price") is not None and r.get("avg_price_hkd") is not None \
                and float(r["avg_price_hkd"]) > float(filters["max_price"]):
            continue
        # D549: `avoid` is a HARD filter (7.1) and the live lane has always excluded on
        # it. This lane read category, district and max_price and nothing else, so the
        # fixture backend answered a different question about the same request than the
        # live one - the D488 shape, one lane over.
        if _static_avoids(r, filters.get("avoid"), offerings):
            continue
        if party_size:
            # D607: the same hard bound the live clause applies, so the two lanes answer one
            # request with one set (D449). A row that states no bound is not a small row.
            lo, hi = r.get("min_party_size"), r.get("max_party_size")
            if ((hi is not None and int(party_size) > int(hi))
                    or (lo is not None and int(party_size) < int(lo))):
                continue
        r["kw_score"] = max(float(r.get("kw_score") or 0.0), score)
        r.setdefault("vec_score", 0.0)
        r.setdefault("text_matched", bool(low))
        r.setdefault("subject_type", "merchant" if r.get("display_name") else "offering")
        out.append(r)
    return out


def _static_avoid_terms(avoid: Any) -> set[str]:
    """The spellings an `avoid` value stands for, in the corpus's own vocabulary (D549).

    This is the live lane's OWN expansion (`sql._avoid_terms`, which reads
    `categories.avoid_terms`), not a second copy of it: one word has one set of spellings
    again, so a fixture that asks to avoid seafood excludes the same rows the live clause
    does. Written as a set because the predicate below is a membership test, not an order.
    """
    from nexus_ai.search.categories import avoid_terms

    return {t.lower() for value in (avoid or []) for t in avoid_terms(str(value)) if t}


def _static_avoid_aspects(avoid: Any) -> set[str]:
    """The `weak_aspects` names the refused words stand for (D595).

    The live clause's aspect leg reads the corpus's own aspect vocabulary through
    `categories.aspect_terms`; this set is the same reader, so a fixture that asks to avoid
    noise excludes the same merchants the live clause does.
    """
    from nexus_ai.search.categories import aspect_terms

    return {t.lower() for value in (avoid or []) for t in aspect_terms(str(value)) if t}


def _static_avoid_attributes(avoid: Any) -> set[str]:
    """The boolean attributes a refused word stands for (D598).

    The live clause asks `categories.aspect_attributes`; this is the same reader, so the two
    lanes agree on which spellings of a weakness exist rather than each carrying a copy.
    """
    from nexus_ai.search.categories import aspect_attributes

    return {n.lower() for value in (avoid or []) for n in aspect_attributes(str(value)) if n}


def _static_row_avoids_aspect(row: dict[str, Any], aspects: set[str],
                              attributes: set[str] = frozenset()) -> bool:
    """The aspect legs: the `weak_aspects` list, and the boolean spellings of the same fact.

    A merchant row carries its own `attributes`; an offering row carries the MERCHANT's list
    under `merchant_weak_aspects` and the merchant's boolean leg under `merchant_<name>`,
    because the live clause reads `m.attributes` on both lanes.
    """
    if not aspects and not attributes:
        return False
    is_merchant = bool(row.get("display_name"))
    attrs: Any = row.get("attributes") if is_merchant else None
    attrs = attrs if isinstance(attrs, dict) else {}
    if attributes:
        # D598: `lively_ambience` is true exactly when the seed's noise score is low, so a
        # TRUE value is the weakness; an absent or false one is not evidence either way.
        for name in attributes:
            if is_merchant:
                if attrs.get(name) is True:
                    return True
            elif row.get("merchant_" + name) is True:
                return True
    if not aspects:
        return False
    weak: Any = attrs.get("weak_aspects") if is_merchant else None
    if not weak:
        weak = row.get("merchant_weak_aspects") or []
    return bool({str(x).strip().lower() for x in weak if x} & aspects)


def _static_row_avoids_text(row: dict[str, Any], terms: set[str]) -> bool:
    """The ILIKE leg: does the row's own prose mention a term the user refused?

    The live clause concatenates `name || name_zh || description` and matches
    case-insensitively; the keys are the live SELECT's own aliases, so a fixture row and a
    live row are read by the same names.
    """
    hay = " ".join(str(row.get(k) or "") for k in
                   ("name", "name_zh", "description")).lower()
    return any(t in hay for t in terms)


def _static_row_avoids_allergen(row: dict[str, Any], terms: set[str]) -> bool:
    """The allergens leg: `attributes->'allergens' ?| terms`, on the row's own attributes."""
    allergens = (row.get("attributes") or {}).get("allergens") or []
    return bool({str(a).strip().lower() for a in allergens} & terms)


def _static_avoids(row: dict[str, Any], avoid: Any,
                   offerings: Sequence[dict[str, Any]] = ()) -> bool:
    """Whether the live avoid clause would drop this row (D549).

    The live clause is the same legs in both lanes, and the lane only decides WHERE the last
    two of them look:

        AND NOT (m.tags && terms
                 OR m.category_primary = ANY(terms)
                 OR <the merchant's offerings match>      -- merchant lane
                 OR <the offering's own name/allergens>)  -- offering lane

    The row's own shape says which lane it is, the way `_filter_static` already decides
    `subject_type` below: a merchant row carries `display_name`, an offering row does not.
    """
    terms = _static_avoid_terms(avoid)
    if not terms:
        return False
    tags = {str(t).strip().lower() for t in (row.get("tags") or [])}
    if tags & terms:
        return True
    category = str(row.get("category_primary") or row.get("category") or "").strip().lower()
    if category in terms:
        return True
    # D595: the refused aspect the corpus records as a merchant weakness. A merchant row reads
    # its own list; an offering row reads the merchant's, carried beside it by the live SELECT.
    if _static_row_avoids_aspect(row, _static_avoid_aspects(avoid),
                                  _static_avoid_attributes(avoid)):
        return True
    if row.get("display_name"):
        # the merchant lane: the EXISTS leg looks at the merchant's OWN offerings.
        mine = str(row.get("id") or "")
        for o in offerings:
            if str(o.get("merchant_id") or "") != mine:
                continue
            if _static_row_avoids_text(o, terms) or _static_row_avoids_allergen(o, terms):
                return True
        return False
    return _static_row_avoids_text(row, terms) or _static_row_avoids_allergen(row, terms)

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
    #: D463: the merchant's OPENING hour has to be at or before this - the mirror
    #: of `open_late_after`, which asks for a CLOSING hour at or after it.
    open_early_before: int | None = None
    sort_preference: str = "relevance"
    avoid: list[str] = field(default_factory=list)
    # Soft preference signals for the ranking lane. Never a hard filter: only explicit
    # `filters.attributes` from the caller reaches the SQL containment clause (D381).
    attributes: dict[str, Any] = field(default_factory=dict)
    limit: int = 20


def _canonical_category(filters: dict[str, Any]) -> None:
    """D505: the caller's `filters.category` is the same fact as the intent's category, and
    it must be read by the SAME reader - the lexin's `match_category`.

    It used to pass the raw string through, so "escape room" (the product's own
    vocabulary) matched NOTHING while the same word in a QUERY found the bucket. The search
    resolves the bucket into taxonomy slugs (`search/categories.py`), so the filter has to
    speak the bucket.

    A word the product does not know is left alone - the reader must not invent a category
    the caller did not ask for.
    """
    if not filters.get("category"):
        return
    from nexus_ai.nlu.lexicon import match_category

    matched = match_category(str(filters["category"]))
    if matched is not None:
        filters["category"] = matched[0]


def _apply_category_leaf(plan: SearchPlan, caller_named_category: bool) -> None:
    """D601: a word in the query that NAMES one taxonomy leaf answers that leaf.

    `match_category` answers the coarse bucket the contract's `Intent.category` carries -
    `restaurant` for 拉麵, `beauty` for 按摩 - and a bucket is coarser than the leaf the user
    named: 按摩 was answered with every beauty leaf (nail salons, hair salons, skin clinics) at
    top-10 precision 0.3, and 珍珠奶茶 matched no category at all (0.0). The search FILTER is
    where that refinement belongs: it already resolves a leaf spelling exactly (D524), and both
    lanes read `filters["category"]`, so writing the leaf there keeps the live and fixture lanes
    answering the same question.

    A caller who passed their own `category` keeps it - the chip on a card outranks a word in
    the query, and overriding it would answer a filter nobody asked for.
    """
    if caller_named_category:
        return
    from nexus_ai.nlu.lexicon import match_leaf

    leaf = match_leaf(plan.query_text or "")
    if leaf:
        plan.filters["category"] = leaf


def _keep_category_spelling(filters: dict[str, Any], raw: Any) -> None:
    """D524: the caller's OWN spelling of the category, kept beside the bucket.

    `match_category` answers with a COARSER fact than a taxonomy leaf. The word "coffee" is
    a word inside the slug `specialty-coffee` - hyphens are word boundaries - so the leaf
    reads as the bucket `cafe`, and the bucket stands for every cafe in the taxonomy. A
    caller who named ONE leaf then got its whole root: measured on the live corpus,
    `filters={"category": "specialty-coffee"}` answered 79 merchants where the corpus holds
    33, `cocktail-bar` answered 39 where it holds 13, `hair-salon` 39 where it holds 11.

    The taxonomy is the only plane that knows which slugs are leaves, so the caller's
    spelling travels to the SQL, which asks it: an exact leaf wins, and the bucket walk is
    the fallback for a root or a word.
    """
    if raw is None or not str(raw).strip():
        return
    from nexus_ai.search.categories import canonical_tag

    filters["category_spelling"] = canonical_tag(str(raw))


def _canonical_district(filters: dict[str, Any]) -> None:
    """D508: the caller's `filters.district` is the same fact as the intent's district, and
    it must be read by the SAME reader - the lexin's `match_district`.

    It used to pass the raw string through, so "中環" (the product's own vocabulary alias)
    matched NOTHING while the same word in a QUERY found the district. The search resolves
    the district into coordinates (`search/service.py`), so the filter has to speak the
    canonical district name.

    A word the product does not know is left alone - the reader must not invent a district
    the caller did not ask for.
    """
    if not filters.get("district"):
        return
    from nexus_ai.nlu.lexicon import match_district

    matched = match_district(str(filters["district"]))
    if matched is not None:
        filters["district"] = matched[0]


def _canonical_tags(filters: dict[str, Any]) -> None:
    """D509/D516: the caller's `filters.tags` is the same fact as the intent's tags, and
    it must be read by the ONE spelling reader the product has - `categories.canonical_tag`,
    the same function the seed's aliases and the SQL readers fold through. The seed is the
    writer and the SQL `&&` predicate is the reader: the corpus stores every tag as a
    lowercase hyphen slug, so a caller who spelled the tag the way prose does ("Cantonese",
    "escape_room", "dim sum") got an empty page.

    The reader RESPELLS and never REWORDS - case and separators fold, no alias table, no
    lexicon resolve - so a word the product does not know keeps its word and still matches
    nothing, rather than being resolved into a tag the caller never asked for.
    """
    if not filters.get("tags"):
        return
    from nexus_ai.search.categories import canonical_tag

    raw = filters["tags"]
    if isinstance(raw, str):
        # `{"tags": "ramen"}` is ONE tag; iterating the string would hand the predicate
        # five tags, none of which any merchant carries.
        filters["tags"] = [canonical_tag(raw)]
    else:
        filters["tags"] = [canonical_tag(str(t)) for t in raw]


def _canonical_kind(filters: dict[str, Any]) -> None:
    """D510: the caller's `filters.kind` is the same fact as the intent's intent kind,
    and it must be read by the SAME vocabulary mapping — the intent's KIND_TO_SUBJECT
    mapping, which defines the canonical kind terms.

    The filter used to pass the raw string through, so a caller who used a synonym
    like "shop" or "store" would not match the intent's "merchant" kind. The intent
    maps its intent type through KIND_TO_SUBJECT, so the filter must speak the same
    canonical kind terms.

    A word the product does not know is left alone — the reader must not invent a
    kind the caller did not ask for.
    """
    if not filters.get("kind"):
        return
    from nexus_ai.search.service import KIND_TO_SUBJECT

    # Canonical kind terms from the intent mapping
    canonical_kinds: set[str] = set()
    for kinds in KIND_TO_SUBJECT.values():
        canonical_kinds.update(kinds)
    # The filter uses "merchant", "product", "service", "experience"
    # Map common synonyms to canonical terms
    synonyms = {
        "shop": "merchant",
        "store": "merchant",
        "place": "merchant",
        "venue": "merchant",
        "item": "product",
        "goods": "product",
        "service_type": "service",
        "activity": "experience",
        "event": "experience",
    }

    raw = filters["kind"]
    if isinstance(raw, str):
        raw_lower = raw.lower().strip()
        if raw_lower in synonyms:
            filters["kind"] = synonyms[raw_lower]
        elif raw_lower not in canonical_kinds:
            # Unknown kind - leave alone, do not resolve into a different kind
            pass


def plan_from_intent(intent: Intent | None, *, query: str | None = None,
                     geo: Any = None, filters: Any = None, now: datetime | None = None,
                     limit: int = 20, locale: str = "zh-HK") -> SearchPlan:
    from nexus_ai.nlu.lexicon import DISTRICTS

    now = now or datetime.now(timezone.utc)
    plan = SearchPlan(now=now, limit=limit)
    plan.query_text = (query or (intent.raw_query if intent else "") or "").strip()
    caller_named_category = bool(_plain(filters).get("category"))
    if intent is None:
        plan.filters = _plain(filters)
        _keep_category_spelling(plan.filters, (plan.filters or {}).get("category"))
        _canonical_category(plan.filters)
        _apply_category_leaf(plan, caller_named_category)
        _canonical_district(plan.filters)
        _canonical_tags(plan.filters)
        _canonical_kind(plan.filters)
        _apply_geo(plan, geo)
        return plan

    plan.subject_types = KIND_TO_SUBJECT.get(intent.intent, ("merchant",))
    if filters and _plain(filters).get("kind") in ("product", "service", "experience"):
        plan.subject_types = ("offering",)
    out = plan.filters = _plain(filters)
    _keep_category_spelling(out, out.get("category"))
    out.setdefault("category", intent.category)
    _canonical_category(out)
    _apply_category_leaf(plan, caller_named_category)
    _canonical_district(out)
    _canonical_tags(out)
    _canonical_kind(out)
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
        # D463: the quality carries HHMM and the filter wants the HOUR -
        # 1000 hours is 41 days, and its time part is four in the afternoon.
        plan.open_late_after = int(intent.time.quality.split(":", 1)[1]) // 100
    if intent.time and intent.time.quality and intent.time.quality.startswith("before:"):
        # D463: the same HHMM -> HOUR, for the same reason.
        plan.open_early_before = int(intent.time.quality.split(":", 1)[1]) // 100
    if intent.time and intent.time.type == "unspecified" and not plan.at:
        plan.at = None
    if intent.urgency == "now":
        plan.open_now = True
    for c in intent.constraints:
        # D546: EVERY refusal the lane reads reaches the avoid lane. This used to name three
        # of the five keys the refusal lane writes - `cuisine_avoid`, plus the caller's own
        # `avoid` / `exclude` - so a sentence the lane read arrived at the plan with its
        # refusal already dropped: "唔食花生" wrote `diet_avoid:peanut` and the plan carried
        # nothing, and so did "no gluten", "唔好嘈" and "唔想排隊". The key set is now DERIVED
        # from the lexicon's own `CONSTRAINT_RULES` rather than copied out of it, so a rule
        # added to the table reaches the filter by construction instead of by somebody
        # remembering this line. The value goes through the ONE canon reader
        # (`canon_constraint`), the same reader `_fill_constraints` uses, so a caller who
        # hands the planner a surface form gets the term set the lane's own reading writes.
        if c.key in AVOID_CONSTRAINT_KEYS:
            value = canon_constraint(c.value)
            # D546: deduped here too, the way the caller's list is merged below. Measured
            # at HEAD, an Intent carrying the same refusal twice under two spellings
            # ("花生" and "peanut") left `plan.avoid == ['peanut', 'peanut']`; the merge
            # cleaned it up on its way into the filters, so nothing downstream ever saw
            # the duplicate - which is exactly why it survived.
            if value and value not in plan.avoid:
                plan.avoid.append(value)
    # `preferences` are SOFT (§7.1: "ambience: quiet" is a preference, not a constraint) and
    # must not become WHERE clauses. The old mapping wrote `{"occasion": true}` into the JSONB
    # attribute filter, which no seeded merchant carries, so a Chinese sentence whose only
    # signal was a preference returned zero rows before ranking ever ran (D381). The value was
    # also lost in the collapse to `True`, so even a matching key could not match its value.
    # They stay on the Intent for the ranking lane; only the caller's explicit
    # `filters.attributes` is a hard containment filter.
    # D517: the caller's explicit `filters.avoid` is a hard filter too (§7.1: the request's
    # filters are hard). This line used to be a plain assignment, so `plan.avoid` - which
    # holds only what the INTENT's constraints named - overwrote it: a caller who asked to
    # avoid pork alongside an intent that named nothing got an empty avoid list, and the
    # sweep below then dropped the key altogether. The caller's list is kept and the
    # intent's constraints are merged into it, deduped and order-stable.
    merged_avoid: list[str] = []
    for a in [*(out.get("avoid") or []), *plan.avoid]:
        if a and a not in merged_avoid:
            merged_avoid.append(a)
    out["avoid"] = merged_avoid
    out["attributes"] = {**out.get("attributes", {}), **plan.attributes}
    out["open_now"] = plan.open_now
    if plan.open_late_after is not None:
        out["min_closing_hour"] = plan.open_late_after
    if plan.open_early_before is not None:
        out["max_opening_hour"] = plan.open_early_before
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


#: the merchant row's own columns that the `attributes` JSONB does NOT carry. A preference
#: reader handed only the JSONB reads an empty category and no tags at all - and a cuisine
#: matcher that cannot see either one never fires (D522).
_ROW_FIELDS = ("avg_price_hkd", "district", "category_primary", "tags")


def _sided(w: float, *, liked: bool) -> float:
    """The score a preference gives, on the side of neutral the USER is on.

    D527: the boolean matchers read a weight as `w if liked else 1 - w`, which is only
    correct while w > 0.5. Below it the two sides CROSS: a user who says "step-free
    access matters a little" (weight 0.4) was served the merchants that have none at 0.6
    and the merchants that have it at 0.4 - the platform ranking the thing the user asked
    for BELOW the thing they did not, which is the D522 inversion one signal over. A weak
    preference is weak evidence FOR, never evidence AGAINST. So the distance from neutral
    carries the strength and the side of neutral carries the sign: reflecting at 0.5 keeps
    every weight in [0, 1] on the user's own side, and leaves w > 0.5 exactly where it was.
    """
    strength = abs(float(w) - 0.5)
    return 0.5 + strength if liked else 0.5 - strength


#: (kind, key) whose attribute is not spelled `{value}_{kind}` or `{kind}_{value}`.
#: One fact, one reader, one spelling (D527): the name is the one the stored branch
#: below reads, so a preference the user TYPES and the same preference they DECLARED
#: are answered by the same fact in the corpus. A new row here must name an
#: attribute the seed actually writes -
#: `test_the_typed_preference_speaks_the_corpus_spelling.py` holds the two planes
#: to each other.
_INTENT_ATTR_ALIASES: dict[tuple[str, str], tuple[str, ...]] = {
    ("time_pref", "open_late"): ("opens_late",),
}


def _enriched_attrs(row: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    """The merchant's attributes with the ROW's own columns folded in.

    `category_primary` and `tags` are columns on the merchant row, not keys of the
    `attributes` JSONB (measured on this corpus: the JSONB carries the booleans -
    `quiet_ambience`, `wheelchair_access`, `opens_late` - and never the category or the
    tags). The stored-preference path folds them in; until D522 the transient intent path
    did not, so a cuisine preference taken from the query the user just typed was read
    against an empty category and an empty tag list - which never matches, and whose
    non-matching branch scores a DISLIKED cuisine 1.0 and a LIKED one 0.5.
    """
    out = dict(attrs)
    for column in _ROW_FIELDS:
        if row.get(column) is not None:
            out[column] = row.get(column)
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


def _pool_total(rows: Sequence[dict[str, Any]]) -> int:
    """The lane's own row count, read from the window column when the backend answers it.

    `pool_total` is `count(*) OVER ()` in the candidate SELECT, i.e. the size of the WHOLE
    filtered pool before its LIMIT (D599). A fixture backend has no LIMIT to hit and no window
    column, so the rows it returned ARE its pool.
    """
    if not rows:
        return 0
    value = rows[0].get("pool_total")
    return int(value) if value is not None else len(rows)


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

    # D418: the text that is MATCHED against the corpus's index is the canonical form of
    # the query. The corpus is indexed as it is, and 0 of its 470 published rows hold a
    # character the canonical table changes - so this can only add matches: the query
    # 餐厅 (simplified) reaches 0 rows raw and 52 canonicalised. The card still shows
    # the user's own words (plan.query_text is untouched).
    from nexus_ai.nlu.canonical import canonical

    # D599: `total_estimate` answers how many subjects the query matched, not how many fit in
    # the candidate page. The page is capped at `max(60, plan.limit * 3)`, so `len(ranked)`
    # could never exceed that cap: a caller naming the `restaurant` root (184 merchants) was
    # told 150. Each lane's SELECT carries `pool_total` (a window count taken before its
    # ORDER BY / LIMIT) when asked, and the response reports that sum; a backend that does not
    # answer the column keeps `len(ranked)`, and the larger of the two wins so a page that was
    # not capped by the pool never shrinks its answer.
    common = dict(tenant_id=str(tenant_id), text=canonical(plan.query_text) or None,
                  filters=plan.filters, geo=plan.geo, radius_m=plan.radius_m,
                  limit=max(60, plan.limit * 3), with_total=True)
    pool_total = 0
    if "merchant" in plan.subject_types:
        merchant_rows = await backend.merchant_candidates(
            embedding=list(embedding) if embedding else None, **common)
        rows += merchant_rows
        pool_total += _pool_total(merchant_rows)
    if "offering" in plan.subject_types:
        # D607: the party a request names is a hard bound on which OFFERINGS can answer it, the
        # same way it already bounds slot capacity. It goes to the offering lane only -
        # `merchants` carries no party columns, and aggregating a merchant's offerings into a
        # merchant-level rule is undocumented (filed in PLAN).
        offering_rows = await backend.offering_candidates(
            **{k: v for k, v in common.items() if k != "embedding"},
            party_size=plan.party_size)
        rows += offering_rows
        pool_total += _pool_total(offering_rows)
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
                                    return _sided(w, liked=True)
                                return _sided(w, liked=False)
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
                                        return _sided(w, liked=True)
                                    if attrs.get("lively_ambience") is True:
                                        return _sided(w, liked=False)
                                elif amb == "lively":
                                    if attrs.get("lively_ambience") is True:
                                        return _sided(w, liked=True)
                                    if attrs.get("quiet_ambience") is True:
                                        return _sided(w, liked=False)
                                return None
                            return _match
                        match_fn = make_ambience_match(str(ambience), float(weight))
                
                # AMBIENCE: quiet / lively -> boolean
                elif kind == "ambience" and key in ("quiet", "lively"):
                    # D531: the NLU's own PREFERENCE_RULES emits `ambience/quiet` and
                    # `ambience/lively` - the words a user actually types - and the
                    # seed's own comment names them ("Ambience preferences (NLU:
                    # ambience/quiet, ambience/lively)"), but this chain had a branch
                    # only for `style/ambience`, whose value is the STRING "quiet". A
                    # preference stored in the spelling the product itself emits
                    # answered `personalization = None` for every merchant on the
                    # corpus, while the very same fact typed into the query box was
                    # read correctly (the intent path derives `quiet_ambience`). One
                    # fact, two readers, and the persistent one was the broken one -
                    # the D518 shape again. §33: the user can inspect and delete their
                    # preferences, and a preference whose effect they cannot see is
                    # one they cannot inspect.
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        want = "quiet_ambience" if key == "quiet" else "lively_ambience"
                        other = "lively_ambience" if key == "quiet" else "quiet_ambience"

                        def make_ambience_flag_match(want_key, other_key, v, w):
                            def _match(attrs):
                                # D527's lesson, applied again: accept either witness.
                                # A matcher that demands its own attribute answers None
                                # for every merchant the corpus leaves it out of.
                                if attrs.get(want_key) is True:
                                    return _sided(w, liked=v)
                                if attrs.get(other_key) is True:
                                    return _sided(w, liked=not v)
                                if attrs.get(want_key) is False:
                                    return _sided(w, liked=not v)
                                return None
                            return _match
                        match_fn = make_ambience_flag_match(want, other, val,
                                                             float(weight))

                # ACCESS: pet_friendly -> boolean
                elif kind == "access" and key == "pet_friendly":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_pet_match(v, w):
                            def _match(attrs):
                                if attrs.get("pet_friendly_access") is True:
                                    return _sided(w, liked=v)
                                if attrs.get("pet_friendly_access") is False:
                                    return _sided(w, liked=not v)
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
                            # D528: the weight is the caller's and it is READ here. This
                            # matcher used to answer the hardcoded 1.0 / 0.0 whatever the
                            # weight said, so an occasion the user cares about a little
                            # swung the personalization signal over its whole range and one
                            # they care about a lot swung it no further. The weight is the
                            # only thing that says how much.
                            if attrs.get(occ_key) is True:
                                return _sided(w, liked=True)
                            if attrs.get(occ_key) is False:
                                return _sided(w, liked=False)
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
                                    return _sided(w, liked=v)
                                if attrs.get("scenic_view") is False:
                                    return _sided(w, liked=not v)
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
                                    return _sided(w, liked=v)
                                if attrs.get("outdoor_style") is True:
                                    return _sided(w, liked=not v)
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
                                    return _sided(w, liked=v)
                                if attrs.get("opens_late") is False:
                                    return _sided(w, liked=not v)
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
                                    return _sided(w, liked=v)
                                if attrs.get("spicy_cuisine") is False:
                                    return _sided(w, liked=not v)
                                return None
                            return _match
                        match_fn = make_spicy_match(val, float(weight))

                # CUISINE: vegetarian
                elif kind == "cuisine" and key == "vegetarian":
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_vegetarian_match(v, w):
                            def _match(attrs):
                                # D554: the seed writes the preference as the boolean
                                # attribute `<kind>_<key>` (`cuisine_vegetarian`), the same
                                # fact spelled the way the attribute-name gate reads
                                # (`<key>_<kind>` for occasions, `<kind>_<key>` here).
                                if attrs.get("cuisine_vegetarian") is True:
                                    return _sided(w, liked=v)
                                if attrs.get("cuisine_vegetarian") is False:
                                    return _sided(w, liked=not v)
                                return None
                            return _match
                        match_fn = make_vegetarian_match(val, float(weight))

                # WEAKNESS: <aspect> -> the merchant's `weak_aspects` LIST (D581)
                elif kind == "weakness" and key:
                    # D581: the seed writes a merchant's weaknesses as the LIST attribute
                    # `weak_aspects` (the ASPECT names the merchant is weak at - `noise`,
                    # `service`, ...), and a preference that names a weakness is the user
                    # refusing it or asking for strength there. The boolean matchers could
                    # not read a list, so this branch never fired and a declared weakness
                    # answered nobody - the merchant's own weakness was invisible to the
                    # preference plane.
                    val = value.get("value") if isinstance(value, dict) else None
                    if isinstance(val, bool):
                        def make_weakness_match(key_name, v, w):
                            def _match(attrs):
                                weak = {str(x) for x in (attrs.get("weak_aspects") or []) if x}
                                is_weak = key_name in weak
                                # D581: a merchant weak at a named aspect fails a requirement
                                # for strength there; a merchant that is not weak answers on
                                # the user's own side of the preference.
                                return _sided(w, liked=not is_weak) if v else None
                            return _match
                        match_fn = make_weakness_match(str(key), val, float(weight))
                # STYLE: outdoor, indoor
                elif kind == "style" and key in ("outdoor", "indoor"):
                    # D527: the row's VALUE says which way it points. This branch used to
                    # read only the key, so {"key": "outdoor", "value": false} - a refusal
                    # of the outdoors - was served as a request for it.
                    val = value.get("value") if isinstance(value, dict) else None
                    if not isinstance(val, bool):
                        val = True
                    is_outdoor = (key == "outdoor") == bool(val)
                    def make_outdoor_match(is_outdoor_pref, w):
                        def _match(attrs):
                            if is_outdoor_pref:
                                if attrs.get("outdoor_style") is True:
                                    return _sided(w, liked=True)
                                # D594: the seating fact is answered BEFORE the indoor
                                # fallback. `indoor_style` is written True on every row the
                                # seed generates ("most HK venues are indoor" - its own
                                # comment), so as a fallback it answered for the whole corpus
                                # and the 111 merchants that record `outdoor_seating` never
                                # reached their own leg: measured on the live plane, all 470
                                # scored 0.5 for an outdoor preference at weight 0.5.
                                if attrs.get("outdoor_seating") is True:
                                    return _sided(w * 0.8, liked=True)
                                if attrs.get("indoor_style") is True:
                                    return _sided(w, liked=False)
                            else:
                                if attrs.get("indoor_style") is True:
                                    return _sided(w, liked=True)
                                if attrs.get("outdoor_style") is True:
                                    return _sided(w, liked=False)
                                if attrs.get("outdoor_seating") is True:
                                    return _sided(w * 0.8, liked=False)
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
                                    return _sided(w, liked=v)
                                # D527: OR, not AND - see the accessible matcher above.
                                if attrs.get("mtr_near_access") is False or attrs.get("mtr_within_5min") is False:
                                    return _sided(w, liked=not v)
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
                                    return _sided(w, liked=v)
                                # D527: OR, not AND. Demanding BOTH attributes say False
                                # makes a merchant the corpus describes with only one of them
                                # read as UNKNOWN, and the preference then demotes nobody.
                                # Measured on the live corpus: 267 merchants answer True and
                                # 0 answer False, because only `wheelchair_access` is written
                                # there - the whole avoiding half of the preference was dead.
                                if attrs.get("accessible_access") is False or attrs.get("wheelchair_access") is False:
                                    return _sided(w, liked=not v)
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
                                    return _sided(w, liked=v)
                                if attrs.get("parking_access") is False:
                                    return _sided(w, liked=not v)
                                return None
                            return _match
                        match_fn = make_parking_match(val, float(weight))
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
                    enriched_attrs = _enriched_attrs(r, attrs)
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
            attrs = _enriched_attrs(r, merchant_attrs[mid])
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
                        # D529: the merchant is not the refused cuisine, and that is
                        # NOT evidence that it fits. Answering the maximum here made
                        # a refusal evidence FOR everything else at full strength,
                        # and because the aggregation is a maximum (D397) it wiped
                        # out every other preference the user had: measured on the
                        # live corpus, a declared `quiet` at 0.9 plus a typed
                        # refusal of Japanese left all 442 non-Japanese merchants at
                        # 1.0, quiet and loud indistinguishable. A LIKE already
                        # answers neutral for a non-match; a DISLIKE must too.
                        intent_pref_scores.append(0.5)
                    continue

                # D530: `time_pref/open_late` is the one preference whose attribute is
                # not spelled `{value}_{kind}` or `{kind}_{value}`. The stored branch
                # below reads `opens_late`; the two derived names are
                # `open_late_time_pref` and `time_pref_open_late`, and no corpus writes
                # either. Measured on the live plane, a user typing a late-night
                # request changed 0 of 470 merchants: the corpus splits 266 / 204 on
                # `opens_late`, the stored path scores those halves 0.9 / 0.1, and the
                # typed one scored nothing at all. One fact, two readers, and the one
                # serving the live query was the broken one (D518/D522 again).
                attr_keys = [f"{pref_value}_{pref_kind}",   # date_occasion
                             f"{pref_kind}_{pref_value}"]   # occasion_date
                attr_keys += [a for a in _INTENT_ATTR_ALIASES.get(
                    (str(pref_kind), str(pref_value)), ()) if a not in attr_keys]

                for attr_key in attr_keys:
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
        cards.append(attach_price_staleness(card, bundle, locale=locale))

    took_ms = int((time.perf_counter() - started) * 1000)
    # D593: the strategy string names the lanes that SCORED, not the lanes that were asked
    # for. Measured on the plane this service reads: 0 of 2118 chunks carry an embedding, so
    # every candidate's `vec_score` is 0.0 while the response still answered
    # `hybrid_v1+postgres+vector` - a lane named by the request flag rather than by its work.
    # The leg is named only when at least one ranked row carried a non-zero score; whether a
    # chunk is embedded is the corpus's own fact, and this reader can see it in the rows it
    # just ranked.
    vector_contributed = bool(vector_lane) and any(
        float((s.candidate.raw.get("row") or {}).get("vec_score") or 0.0) > 0.0
        for s in ranked)
    strategy = f"{w.version}+{backend.name}"
    if vector_contributed:
        strategy += "+vector"
    response = SearchResponse(
        items=cards, facets=facets, took_ms=took_ms, strategy=strategy,
        degraded=False, provider="none", total_estimate=max(len(ranked), pool_total),
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
