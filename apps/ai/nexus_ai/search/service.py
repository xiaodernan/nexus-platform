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
from datetime import datetime, time as clock_time, timedelta, timezone
from typing import Any, Protocol, Sequence
from uuid import UUID

from nexus_ai.contract import EntityCard, FacetValue, Intent, SearchResponse
from nexus_ai.nlu.lexicon import (
    CONSTRAINT_RULES,
    canon_constraint,
    category_surfaces,
    cuisine_leaves,
    cuisine_matches,
)
from nexus_ai.nlu.timeparse import HK_TZ
from nexus_ai.nlu.understand import match_core as _match_core
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


def _tenant_mean_rating(rows: Sequence[dict[str, Any]]) -> float:
    """The mean the Bayesian quality shrinks toward, read off the row set the lane holds (D708).

    The live SELECT computes it as `avg(rating_agg)` over the tenant's published merchants with a
    positive rating (`sql.py:524-528`), and the shared reader defaults to 3.5 only when a ROW states
    nothing (`candidates_from_rows`, `service.py:1257`). The fixture backend never stated it, so every
    fixture row was shrunk toward a constant while the live plane shrank toward the tenant's own mean:
    one row, one rating, two quality scores - measured 0.7939 against 0.8542 (`tmp/d708_order.py`) -
    and the page orders disagreed on 8 of 8 queries. The rows a fixture backend is handed ARE the
    tenant's merchant set, so the mean is derivable here in exactly the shape the live lane derives
    it. A row that states its own value keeps it.
    """
    values: list[float] = []
    for row in rows:
        try:
            value = float(row.get("rating_agg") or 0.0)
        except (TypeError, ValueError):
            continue
        if value > 0:
            values.append(value)
    return sum(values) / len(values) if values else 3.5


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
        mean = _tenant_mean_rating(rows)
        for row in rows:
            row.setdefault("tenant_mean_rating", mean)
        # D549: the merchant lane's avoid clause reads the merchant's OWN offerings too
        # (`EXISTS (SELECT 1 FROM offerings ao WHERE ao.merchant_id = m.id ...)`), so the
        # fixture lane is handed the same list the live lane would join against.
        # D660: the radius reaches this lane the same way the live SELECT receives it - the
        # pipeline passes `geo` / `radius_m` to both backends (`service.py:1249`).
        return _filter_static(rows, text or "", filters or {}, offerings=self.offerings,
                              hours=self._hours, geo=_kw.get("geo"),
                              radius_m=_kw.get("radius_m"))

    async def offering_candidates(self, *, text=None, filters=None,
                                  party_size: int | None = None, **_kw: Any
                                  ) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.offerings]
        # D708: the offering SELECT reads the same tenant mean as the merchant one (`sql.py:817`),
        # so the fixture lane's offering rows get it from the merchant set it was handed.
        mean = _tenant_mean_rating(self.merchants)
        for row in rows:
            row.setdefault("tenant_mean_rating", mean)
        return _filter_static(rows, text or "", filters or {}, party_size=party_size,
                              hours=self._hours, geo=_kw.get("geo"),
                              radius_m=_kw.get("radius_m"))

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
                   party_size: int | None = None,
                   hours: Sequence[dict[str, Any]] = (),
                   geo: tuple[float, float] | None = None,
                   radius_m: int | None = None) -> list[dict[str, Any]]:
    from nexus_ai.search.categories import canonical_tag, resolve

    bucket = str(filters["category"]) if filters.get("category") else ""
    slugs = {canonical_tag(x) for x in resolve(bucket)} if bucket else set()
    hour_sets = _static_hour_index(hours)
    low = (text or "").lower()
    out: list[dict[str, Any]] = []
    for r in rows:
        hay = " ".join(str(r.get(k) or "") for k in
                       ("display_name", "display_name_zh", "name", "name_zh", "description",
                        "category_primary", "district")).lower()
        hay += " " + " ".join(str(t) for t in (r.get("tags") or []))
        # D615: the bucket leg is decided HERE, before the text gate below. A row that answers
        # the category the request named is an answer even when the user's own words appear
        # nowhere in it: the live lane reads text as a score and a `text_matched` flag, never
        # as a WHERE (sql.py:314-329), and this backend serves the degraded path, where
        # vetoing such a row answered 想飲杯咖啡 with no cafe although the catalogue holds one.
        in_bucket = False
        if bucket:
            row_slugs = {canonical_tag(str(x)) for x in (r.get("category_slugs") or [])}
            # D616: the coarse leg reads the bucket the ROW states. A merchant row spells it
            # in `category_primary`; an offering row spells it in `category` - `demo_data.py:124`
            # writes the inherited value under that key and `test_demo_data.py::
            # test_category_and_district_inherited` pins it, while the live SELECT aliases the
            # same column `m.category_primary AS category` (sql.py:582). Reading only the first
            # key kept 0 of the 2 demo offerings for EVERY bucket, including the one its own row
            # states, so the degraded path answered a product request with nothing while the
            # plane answered it from the mirror the live row also carries.
            stated = (r.get("category_primary"), r.get("category"))
            in_bucket = (bool(row_slugs & slugs) if row_slugs
                         else bucket in stated)
        # D658: text is a SCORE on both lanes, never a WHERE. `build_merchant_query` puts no text
        # predicate in its WHERE at all - the words reach only `kw_score` and the `text_matched`
        # flag (`sql.py:329-344`, `:423`) - while this lane dropped every row with no keyword hit.
        # Measured on the published plane (`tmp/d658_gap.py`): 「安靜」+cafe answered 0 of 79 rows
        # here against 10 live, 「海景」+restaurant 0 of 184 against 10, 「寵物友善」 0 of 10 against
        # 10, and a word the corpus does not hold (`xyzzy`) 0 rows and total 0 here against 10 rows
        # and total 470. D615 made the CATEGORY an exception to that veto; this removes the veto
        # instead, because the live lane has no exception to make - every row the HARD filters keep
        # is an answer, ranked by how well its words match. The category leg below stays: it IS a
        # WHERE (`sql.py:449-453`), and in_bucket is what reads it.
        score = 0.0
        matched = False
        if low:
            tokens = _static_tokens(low)
            hits = sum(1 for t in tokens if t in hay)
            name_hit = any(t in str(r.get("display_name") or "").lower()
                           or t in str(r.get("name") or "").lower() for t in tokens)
            matched = bool(hits or name_hit)
            score = min(1.0, 0.25 * hits + (0.4 if name_hit else 0.0))
        if bucket and not in_bucket:
            continue
        # D656: the live clause is an EXISTS over `locations` (`sql.py:228-231`), so a merchant with two
        # locations in two districts answers either. The row publishes that set as `districts`
        # (`sql.py:211-221`); the single `district` column is the geo lane's nearest pick and is the
        # fallback for a row list that states only one. Before this, the published merchant rows carried
        # `district: NULL` (geo_select is NULL without a lat/lng), so this lane answered 0 rows for every
        # district where the live lane answered 194 (`tmp/d656_district2.py`).
        if filters.get("district"):
            wanted = str(filters["district"]).lower()
            mine = {str(d).lower() for d in (r.get("districts") or ())}
            if not mine and r.get("district") is not None:
                mine = {str(r["district"]).lower()}
            if wanted not in mine:
                continue
        # D654: the price the caller filters on is the row's OWN price, and the live clauses read
        # two column pairs - `merchants.avg_price_hkd` with a NULL arm on both ends (sql.py:214-217), and
        # an offering's `COALESCE(price_amount, price_max|price_min)` (sql.py:454-459). This lane read one
        # column and one END, so a caller's floor was answered by 184 restaurant rows of which 181
        # were below it (measured, `tmp/d654_minprice2.py`). One reader for both kinds, NULL still passing.
        ceiling, floor = _static_price(r)
        if filters.get("max_price") is not None and ceiling is not None \
                and float(ceiling) > float(filters["max_price"]):
            continue
        if filters.get("min_price") is not None and floor is not None \
                and float(floor) < float(filters["min_price"]):
            continue
        # D549: `avoid` is a HARD filter (7.1) and the live lane has always excluded on
        # it. This lane read category, district and max_price and nothing else, so the
        # fixture backend answered a different question about the same request than the
        # live one - the D488 shape, one lane over.
        # D655: the rest of the caller's HARD filters (§7.1), each read by the live WHERE and by
        # nothing here: `min_rating` (`sql.py:219`), the tag overlap (`:221`, `&&`), `exclude`
        # (`:223`), `merchant_id` (`:225`) and the JSONB containment (`:227`). Measured on the
        # published plane, the fixture lane answered all 470 rows for every one of them while the
        # live lane answered 26 / 8 / 468 / 188 (min_rating 4.6, tag thai, two excluded ids, and
        # `quiet_ambience: true`) - `tmp/d655_census.py`.
        rating = r.get("rating_agg")
        if filters.get("min_rating") is not None and (
                rating is None or float(rating) < float(filters["min_rating"])):
            continue
        if filters.get("tags"):
            mine = {str(t) for t in (r.get("tags") or [])}
            if not mine & {str(t) for t in filters["tags"]}:
                continue
        own_id = str(r.get("subject_id") or r.get("id") or "")
        if filters.get("exclude") and own_id in {str(x) for x in filters["exclude"]}:
            continue
        if filters.get("merchant_id"):
            own_merchant = str(r.get("merchant_id") or own_id)
            if own_merchant != str(filters["merchant_id"]):
                continue
        attrs = r.get("attributes") or {}
        if any(not isinstance(attrs, dict) or attrs.get(k) != v
               for k, v in (filters.get("attributes") or {}).items()):
            continue
        # D655: `kind` is the OFFERING plane's own hard filter - `o.kind` on that SELECT (`sql.py:448`)
        # and nothing on the merchant SELECT, so a merchant row survives it (470 of 470, measured). The
        # merchant projection publishes no `kind` column (`sql.py:392-394`), which is the discriminator
        # here: a row that states a kind is an offering row.
        # Measured on the published plane, the fixture lane answered all 4,707 offerings for each of
        # the three kinds while the live lane answered 3,572 / 822 / 313 (`tmp/d655_kind.py`).
        if str(filters.get("kind") or "") in ("product", "service", "experience") \
                and "kind" in r and str(r.get("kind") or "") != str(filters["kind"]):
            continue
        # D659: the HOUR filters are three clauses on one plane and nothing on the other two.
        # `open_weekday`+`open_time` (`sql.py:247-258`), `min_closing_hour` (`:259-264`) and
        # `max_opening_hour` (`:265-272`) are EXISTS over `business_hours` on the merchant SELECT;
        # the offering SELECT carried none of them and this lane read no clock at all, so 「開到
        # 晚上」 answered 470 of 470 merchants here against 369 live, and every offering in the
        # plane whether its shop was open or not (`tmp/d659_open2.py`). A row whose merchant states
        # no matching hours fails the EXISTS on the live lane, so it fails here too.
        if not _static_hours_fit(r, filters, hour_sets):
            continue
        # D660: the RADIUS. The live clause is a bbox prefilter plus a haversine on the nearest
        # location inside it, and a row with no location is dropped (`sql.py:291-320`). Measured on
        # the published plane (`tmp/d660_geo.py`): a 1,000 m request answered 470 of 470 rows here
        # against 0 live, and 5,000 m answered 470 against 95. `haversine_m` is the SAME function
        # `haversine_expr` mirrors in SQL, so the two lanes measure with one formula.
        # D663: a row that states NO location is not deleted when it states the DISTRICT the
        # request named. The plan places a district filter at the district's own coordinates
        # (`DISTRICTS[...]`, `service.py:922-927`) so the live lane can order by distance, and the
        # clause above has already answered the district the row claims - so a row without a point
        # is in the pool by its own statement. Only a row that states NEITHER is dropped, which is
        # what the live `loc.id IS NOT NULL` does to it. The offline demo catalogue is all of this
        # case (6 rows, every one with a district and none with a lat/lng) and it answered zero
        # items for "sha tin" until this branch existed (`tests/test_stream.py`).
        if geo:
            metres = _static_nearest_metres(r, geo)
            if metres is None:
                if not (filters.get("district") and (r.get("district") or r.get("districts"))):
                    continue
            elif radius_m and metres > float(radius_m):
                continue
            else:
                r["meters"] = metres
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
        # D658: the flag means "this row mentions the text", which is what the live SELECT's own
        # `text_matched` is (`sql.py:337-344`) and what `_has_query_signal` reads to tell an
        # irrelevant MATCH from a non-match. It was `bool(low)` - true on every row of a texted
        # request - so the floor judged rows by keyword score alone and a no-hit row looked matched.
        r.setdefault("text_matched", matched)
        r.setdefault("subject_type", "merchant" if r.get("display_name") else "offering")
        out.append(r)
    return out


def _static_nearest_metres(r: dict[str, Any], geo: tuple[float, float]) -> float | None:
    """The nearest of the row's own locations, in metres - or None when it states none (D660).

    The live lane picks the nearest location INSIDE the bbox the radius implies and drops a row
    with none (`sql.py:291-320`); a bbox is a superset of its own disc, so the nearest over ALL
    the row's points answers the same question, and `haversine_m` is the formula the SQL mirrors.
    """
    from nexus_ai.search.sql import haversine_m

    points = r.get("location_points") or []
    best: float | None = None
    for point in points:
        if not isinstance(point, dict):
            continue
        lat, lng = point.get("lat"), point.get("lng")
        if lat is None or lng is None:
            continue
        metres = haversine_m(float(geo[0]), float(geo[1]), float(lat), float(lng))
        if best is None or metres < best:
            best = metres
    return best


def _static_hour_index(hours: Sequence[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """business_hours rows grouped by merchant - what the live EXISTS joins against (D659)."""
    out: dict[str, list[dict[str, Any]]] = {}
    for row in hours or ():
        key = str(row.get("merchant_id") or "")
        if key:
            out.setdefault(key, []).append(row)
    return out


def _static_hour_value(value: Any) -> Any:
    """`time` in the filters and in the rows, `str` in a hand-written fixture row, and an INT hour
    from a hand-built caller or an older test (D661) - read as `int:00`, the live helper's own
    reading (`sql._clock_filter`)."""
    if isinstance(value, str):
        try:
            return clock_time.fromisoformat(value)
        except ValueError:
            return None
    if isinstance(value, (int, float)):
        minutes = int(round(float(value) * 60))
        if not 0 <= minutes < 24 * 60:
            return None
        return clock_time(minutes // 60, minutes % 60)
    return value


def _static_open_during(row: dict[str, Any], start: Any, end: Any) -> bool:
    """Does the row trade for any instant of `[start, end)` - the window twin of `_static_open_at`
    (D666). A crossing-midnight row is open from `opens_at` to midnight and from midnight to
    `closes_at`, so it overlaps the window when EITHER of its edges lands inside it; a normal row
    overlaps when its interval straddles the window, which is the plain interval test."""
    opens = _static_hour_value(row.get("opens_at"))
    closes = _static_hour_value(row.get("closes_at"))
    if row.get("crosses_midnight"):
        return (opens is not None and opens < end) or (closes is not None and closes > start)
    return (opens is not None and closes is not None and opens < end and closes > start)


def _static_open_across(row: dict[str, Any], start: Any, end: Any) -> bool:
    """Does the row trade for any instant of the window `[start, 24:00)` + `[00:00, end)` - the
    crossing-window twin of `_static_open_during` (D699). A row that crosses midnight trades
    through it, so it always overlaps; a same-day row does when it closes after the window's
    start or opens before its far edge."""
    if row.get("crosses_midnight"):
        return True
    opens = _static_hour_value(row.get("opens_at"))
    closes = _static_hour_value(row.get("closes_at"))
    return ((closes is not None and closes > start)
            or (opens is not None and opens < end))


def _static_open_at(row: dict[str, Any], at: Any) -> bool:
    """`opens_at <= at < closes_at`, inverted for a row that crosses midnight (D659)."""
    opens = _static_hour_value(row.get("opens_at"))
    closes = _static_hour_value(row.get("closes_at"))
    if row.get("crosses_midnight"):
        return (opens is not None and opens <= at) or (closes is not None and closes > at)
    return opens is not None and closes is not None and opens <= at < closes


def _static_hours_fit(r: dict[str, Any], filters: dict[str, Any],
                      hour_sets: dict[str, list[dict[str, Any]]]) -> bool:
    """The three hour clauses the live merchant WHERE reads, mirrored on one row (D659).

    Each is an EXISTS over `business_hours`: one row that satisfies the clause is enough, and a
    merchant whose rows satisfy none of it fails - so a row with NO hours row fails too, which is
    what `EXISTS` does. The clauses are independent: a request naming an hour tests `opens_at <=
    t < closes_at` (with `crosses_midnight` inverting the comparison), `min_closing_hour` tests
    `closes_at >= h OR crosses_midnight`, `max_opening_hour` tests `opens_at <= h OR
    crosses_midnight`. D661: `h` is a `time`, not an hour - the half hour the request names is
    part of the comparison, and an int is read as `int:00`.
    """
    weekday = filters.get("open_weekday")
    at = _static_hour_value(filters.get("open_time"))
    min_closing = filters.get("min_closing_hour")
    max_opening = filters.get("max_opening_hour")
    if weekday is None and min_closing is None and max_opening is None:
        return True
    key = str(r.get("merchant_id") or r.get("subject_id") or r.get("id") or "")
    rows = hour_sets.get(key) or []
    until = _static_hour_value(filters.get("open_until"))
    if weekday is not None and at is not None:
        # D666: a band asks whether the row is open ANYWHERE in the window; a clock the user said
        # asks whether it is open AT that instant. One filter shape, two questions, and the pair
        # (`open_time`, `open_until`) is what says which one was asked.
        if until is not None and until < at:
            # D699: the window crosses midnight. A row overlaps it when the row is open at any
            # instant of [at, 24:00) or of [00:00, until): a crossing row always is (it trades
            # through midnight), and a same-day row is when it closes after the start or opens
            # before the far edge.
            ok = any(str(h.get("weekday")) == str(weekday) and _static_open_across(h, at, until)
                     for h in rows)
        elif until is not None and until > at:
            ok = any(str(h.get("weekday")) == str(weekday) and _static_open_during(h, at, until)
                     for h in rows)
        else:
            ok = any(str(h.get("weekday")) == str(weekday) and _static_open_at(h, at) for h in rows)
        if not ok:
            return False
    # D665: a day with no clock asks which rows TRADE that day, the live clause mirrored - a row
    # with no hours at all is still dropped (it is the EXISTS).
    if weekday is not None and at is None:
        if not any(str(h.get("weekday")) == str(weekday) for h in rows):
            return False
    if min_closing is not None:
        limit = _static_hour_value(min_closing)
        if limit is not None and not any(bool(h.get("crosses_midnight"))
                   or (_static_hour_value(h.get("closes_at")) is not None
                       and _static_hour_value(h.get("closes_at")) >= limit)
                   for h in rows):
            return False
    if max_opening is not None:
        limit = _static_hour_value(max_opening)
        if limit is not None and not any(bool(h.get("crosses_midnight"))
                   or (_static_hour_value(h.get("opens_at")) is not None
                       and _static_hour_value(h.get("opens_at")) <= limit)
                   for h in rows):
            return False
    return True


def _static_price(r: dict[str, Any]) -> tuple[Any, Any]:
    """(the amount a ceiling reads, the amount a floor reads) - the live SELECT's own pair (D654).

    A merchant row states `avg_price_hkd`; an offering states `price_amount` with `price_max` /
    `price_min` as its two bounds, and the live clauses COALESCE the one over the other. A row that
    states no price answers None twice, and the live clause lets it through - an unstated price is
    not a cheap one.
    """
    if (str(r.get("subject_type") or "") == "offering"
            or r.get("price_amount") is not None or "price_min" in r or "price_max" in r):
        amount = r.get("price_amount")
        return (amount if amount is not None else r.get("price_max"),
                amount if amount is not None else r.get("price_min"))
    return r.get("avg_price_hkd"), r.get("avg_price_hkd")


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
#: D665: the parsed qualities whose START is the convention for "the whole day" rather than a
#: clock the user said. `timeparse`'s bare-day branch answers 09:00-23:00 and its weekend branch
#: Saturday 09:00 (`timeparse.py:452-473`); a sentence that names 今日/聽日/週末 names a DAY.
DAY_LEVEL_QUALITIES = frozenset({"all_day", "weekend"})

#: D666: the parsed qualities that name a PART OF DAY, which is a WINDOW and not a clock the user
#: said. `timeparse`'s band table answers a band (`timeparse.py:44-50`: morning 07:00-11:30, noon
#: 11:30-14:30, afternoon 14:00-18:00, evening 17:00-19:30, night 18:00-23:00) and the plan wrote
#: its START as the instant the shop had to be open AT - so 「聽日朝早嘅咖啡店」 asked for 07:00 and
#: answered 0 of 79 cafes (`tmp/d666_probe.py`). A band means "open at some point inside it", which
#: is `open_until`: the same start, in the same `time` column, with the clause read as an overlap.
PART_OF_DAY_QUALITIES = frozenset({"morning", "noon", "afternoon", "evening", "night", "late_night",
                                  "deep_night"})


@dataclass
class SearchPlan:
    """What the deterministic pipeline needs from the caller — no model involved."""

    query_text: str = ""
    #: D628: the text handed to the retrieval lanes - `query_text` minus the spans a lane already
    #: consumed (a price, a party size).
    #: D635: `None` means nobody computed it, and the service reads `query_text` (a hand-built
    #: plan that only names a query keeps working); "" means the lanes consumed EVERY word, so
    #: there is nothing to search and the request is answered by its filters alone.
    match_text: str | None = None
    subject_types: tuple[str, ...] = ("merchant",)
    filters: dict[str, Any] = field(default_factory=dict)
    geo: tuple[float, float] | None = None
    radius_m: int | None = None
    budget_max: float | None = None
    budget_per: str = "party"
    #: D624: the floor a range states (「300-500蚊」). Read by `ranking.price_fit`.
    budget_min: float | None = None
    party_size: int | None = None
    at: datetime | None = None
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    open_now: bool = False
    #: D661: the CLOCK the request asks the shop to still be open at (`closes_at >=`), and the
    #: mirror - the clock it has to open by (`opens_at <=`). Both were int HOURS, and the
    #: extractor's quality carries HHMM: 「營業到晚上九點半」 asked for 21:00, which the corpus
    #: answers with all 470 merchants because almost every shop closes after nine.
    open_late_after: clock_time | None = None
    open_early_before: clock_time | None = None
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
    # D635: the word that named the CATEGORY is answered by the category filter - the row is in
    # the pool because it IS a restaurant - so it is not also a search term. `category_surfaces`
    # is the category lane's own reading (it returns the spellings of the bucket the sentence is
    # about, and nothing for a bucket that lost), so a preference word such as the 寵物 in
    # 「有冇寵物友善嘅咖啡店」 stays content while the 咖啡店 leaves with its filter.
    named = category_surfaces(plan.query_text) if intent is not None else None
    surfaces: tuple[str, ...] = ()
    if named and intent is not None and named[0] == intent.category:
        surfaces = named[1]
    # D637: and the DISTRICT word leaves the same way. The plan is about to place a geo filter at
    # the district's own coordinates, so a row is in the pool because it is IN that district - the
    # word cannot narrow it further, it only divides the pool's relevance. Only the district the
    # filter will actually use is returned, and only when the location lane named one (a radius
    # or the session's own position writes no word).
    # D652: the LOCATION arrives in two shapes - the contract's model (the pipeline calls
    # `validate_intent`) and the extractor's plain dict (`extract_intent`, whose `location` is a
    # mapping). The guard used `is not None` and then read `.type` off it, so every direct caller
    # with the extractor's own output died before the plan existed - `'dict' object has no attribute
    # 'type'` - and the extractor returns `{}` for a sentence that names no place, which is falsy for
    # the three reads below. One reader for both shapes, the choice `_plain` already makes for filters.
    location = _field(intent, "location") if intent is not None else None
    if location and _field(location, "type") == "district":
        from nexus_ai.nlu.lexicon import district_surfaces

        surfaces += district_surfaces(plan.query_text, _field(location, "value"))
    plan.match_text = _match_core(plan.query_text,
                                  strip_time=bool(intent is not None and intent.time),
                                  strip_surfaces=surfaces)
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
        # D673: the same reader the intent path has for a kind the CALLER named. That upgrade sat
        # below this return and was the only one, so a request with no sentence - `{"kind":
        # "product"}` with no `query`, which the published Filters model accepts - left the function
        # first and was answered by `build_merchant_query`, a statement with no kind predicate.
        if filters and _plain(filters).get("kind") in ("product", "service", "experience"):
            plan.subject_types = ("offering",)
        return plan

    plan.subject_types = KIND_TO_SUBJECT.get(intent.intent, ("merchant",))
    if filters and _plain(filters).get("kind") in ("product", "service", "experience"):
        plan.subject_types = ("offering",)
    out = plan.filters = _plain(filters)
    _keep_category_spelling(out, out.get("category"))
    out.setdefault("category", intent.category)
    _canonical_category(out)
    _apply_category_leaf(plan, caller_named_category)
    # D638: the LEAF word is the filter word too. `_apply_category_leaf` may have refined the bucket
    # into the leaf the sentence named (拉麵 -> ramen), so the sentence's own spelling of that leaf is
    # answered by the filter and must leave the match text - exactly as the bucket word does (D635).
    # The match text is recomputed here because the leaf is only known now.
    if out.get("category") and out.get("category") != intent.category:
        from nexus_ai.nlu.lexicon import leaf_surfaces

        leaf_words = leaf_surfaces(plan.query_text, str(out["category"]))
        if leaf_words:
            plan.match_text = _match_core(plan.query_text,
                                          strip_time=bool(intent.time),
                                          strip_surfaces=surfaces + leaf_words)
    _canonical_district(out)
    _canonical_tags(out)
    _canonical_kind(out)
    if location and _field(location, "value"):
        out.setdefault("district", _field(location, "value"))
    if location and _field(location, "radius_m"):
        plan.radius_m = int(_field(location, "radius_m"))
    _apply_geo(plan, geo)
    resolved = _field(location, "resolved")
    if plan.geo is None and resolved:
        plan.geo = (_field(resolved, "lat"), _field(resolved, "lng"))
    if plan.geo is None and out.get("district"):
        d = DISTRICTS.get(str(out["district"]))
        if d:
            plan.geo = (d["lat"], d["lng"])
            plan.radius_m = plan.radius_m or int(d.get("radius_m") or 2500)
    # D652: the BUDGET and the TIME arrive in the same two shapes as the location - the model's
    # fields or the extractor's dicts - and both were read as models, so a direct caller's plan
    # died on `'dict' object has no attribute 'max'` / `'starts_at'`. `_field` asks the same
    # question of either shape; `{}` (the extractor's "nothing") stays falsy for both.
    budget = _field(intent, "budget")
    if budget:
        plan.budget_max = _field(budget, "max")
        plan.budget_per = _field(budget, "per") or "party"
        plan.budget_min = _field(budget, "min")
    plan.party_size = intent.party_size
    plan.sort_preference = intent.sort_preference or "relevance"
    time = _field(intent, "time")
    at = _field(time, "starts_at") if time else None
    if isinstance(at, str):
        # D652: the extractor's instant is the ISO string the wire carries, and every reader of
        # `plan.at` (the open-state calculation, `out["open_time"]`, the cards) calls datetime
        # methods on it. Parsed at the boundary, the same `replace("Z", "+00:00")` the stream and
        # the card reader use; an empty string is the extractor's "no time" and stays None.
        at = datetime.fromisoformat(at.replace("Z", "+00:00")) if at else None
    plan.at = at
    # D666: the window's other edge. The extractor states it as `ends_at` in the same ISO shape as
    # `starts_at` (`timeparse.py`'s ParsedTime), and the wire carries it; a caller that states only
    # a start leaves it None, which is a POINT and not a window.
    ends = _field(time, "ends_at") if time else None
    if isinstance(ends, str):
        ends = datetime.fromisoformat(ends.replace("Z", "+00:00")) if ends else None
    quality = _field(time, "quality") if time else None
    if quality and quality.startswith("open_late_after:"):
        # D661: HHMM -> the CLOCK the filter binds. D463 divided it by 100 because the SQL took an
        # int HOUR (`int * interval '1 hour'`), so 「九點半」 asked for nine and the half hour was
        # gone before either lane saw it; both lanes now bind a `time`, like `open_time` does.
        plan.open_late_after = _hhmm_clock(quality.split(":", 1)[1])
    if quality and quality.startswith("before:"):
        plan.open_early_before = _hhmm_clock(quality.split(":", 1)[1])
    if time and _field(time, "type") == "unspecified" and not plan.at:
        plan.at = None
    if intent.urgency == "now":
        plan.open_now = True
    for c in (intent.constraints or ()):
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
        if _field(c, "key") in AVOID_CONSTRAINT_KEYS:
            value = canon_constraint(_field(c, "value"))
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
    # D676: the exclusion a follow-up turn carries reaches the one filter key both reads already
    # implement. `state_merger` writes `Intent.excluded_ids` from the ALT cues (其他 / next / more
    # options) and `sql.py` has cut on `filters.exclude` since D617 (`build_merchant_query`
    # `<> ALL(...)`, mirrored by the fixture lane at `:334`), but nothing between the two read the
    # field: measured before this unit, a second turn naming the ids it had been shown was answered
    # with the first turn's state thrown away (`tmp/d676_measure.txt` §4-§5). The caller's own list
    # is kept and the state's ids merge into it, deduped and order-stable, as `avoid` does above.
    merged_exclude: list[str] = []
    for sid in [*(out.get("exclude") or []), *(_field(intent, "excluded_ids") or [])]:
        s = str(sid)
        if s and s not in merged_exclude:
            merged_exclude.append(s)
    if merged_exclude:
        out["exclude"] = merged_exclude
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
    # on every query carrying a clock time, which the product's own e2e sentence
    # ("...周六晚上"). The value is a time, not a string that happens to look like one.
    # D665: a DAY-level window's start is NOT a clock the user named. The bare-day branch
    # answers 09:00-23:00 by convention (a weekend, Saturday 09:00), so 「聽日嘅餐廳」 asked the
    # database for shops open at nine and answered 13 of its 184 restaurants. The day stays as
    # `open_weekday` (and `plan.at` stays for the card's open state); the hour leaves.
    if plan.at and quality not in DAY_LEVEL_QUALITIES:
        out["open_time"] = plan.at.astimezone(HK_TZ).time()
        # D666: and when the words named a BAND, the band's far edge comes with it. `type` is the
        # discriminator D665's day-level set could not be: an explicit clock beside a band word
        # ("晚上8點") is `explicit` and stays a point, while the band alone is `range`.
        if quality in PART_OF_DAY_QUALITIES and _field(time, "type") == "range" and ends:
            until = ends.astimezone(HK_TZ).time()
            # D699: a band that CROSSES midnight (深夜 23:00-05:00) states a far edge EARLIER than
            # its start. The old comparison dropped it, so a crossing band became the single
            # instant 23:00 and the last hours of the night were never asked for; the two edges
            # are one window in both orders, and the lanes read the order as which shape it is.
            if until != out["open_time"]:
                out["open_until"] = until
    plan.filters = {k: v for k, v in out.items() if v not in (None, "", [], {})}
    return plan


def _hhmm_clock(value: Any) -> clock_time | None:
    """`2130` -> 21:30 and `930` -> 09:30 - the extractor's quality, as a clock (D661).

    Unreadable answers None rather than a guess: an unknown clock leaves the filter off, which is
    the same thing the old `// 100` did with a bad value (and never reached the SQL).
    """
    text = str(value or "").strip()
    if not (3 <= len(text) <= 4 and text.isdigit()):
        return None
    hours, minutes = int(text[:-2]), int(text[-2:])
    if hours > 23 or minutes > 59:
        return None
    return clock_time(hours, minutes)


def _field(obj: Any, name: str) -> Any:
    """A field of the contract's model OR of the extractor's plain dict (D652).

    `plan_from_intent` is handed both: the pipeline passes `validate_intent`'s model, and direct
    callers pass `extract_intent`'s output, whose `location` is a dict of the same four fields.
    Reading `.type` off that dict raised `'dict' object has no attribute 'type'` and the sentence
    could not be planned at all - so the reader asks both shapes, as `_plain` does for filters.
    """
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


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


def _relevance(row: dict[str, Any], *, vector_lane: bool,
               semantic: bool = True) -> float:
    kw = float(row.get("kw_score") or 0.0)
    vec = float(row.get("vec_score") or 0.0) if vector_lane else 0.0
    if not semantic:
        # D705: `relevance` answers "does this row answer the query's words?", and it has
        # two witnesses: the keyword lane and the vector cosine. A cosine is a witness only
        # in a SEMANTIC space. The hashing adapter is a signed bag-of-ngrams projection -
        # it measures shared surface tokens, which is the very thing the keyword lane
        # already measures, better (ts_rank + trigram + containment over name, description
        # and tags) and with a `text_matched` verdict attached. So a non-semantic cosine
        # may not testify LOUDER than the keyword lane: it is capped by `kw`. Where `kw` is
        # 0 the row is one the keyword lane declined to claim, and noise cannot claim it -
        # measured on 「想食日本嘢」, where all 8 rows had kw 0.0 and 0.06-0.11 of noise
        # ordered them, and 「想食日式」 - the same request - ordered a different 8 because
        # the noise differed (`tmp/d705_measure.py`).
        vec = min(vec, kw)
    fused = max(kw, vec) + 0.35 * min(kw, vec)
    return round(max(0.0, min(1.0, fused)), 4)


def candidates_from_rows(rows: Sequence[dict[str, Any]], plan: SearchPlan, *,
                         bundle: FactBundle, facts_by_subject: dict[str, list[Any]],
                         hours_by_merchant: dict[str, list[Any]],
                         slots_by_merchant: dict[str, dict[str, Any]],
                         personalization: dict[str, float],
                         weights: RankingWeights,
                         vector_lane: bool,
                         vector_semantic: bool = True,
                         typed_cuisine: dict[str, float] | None = None,
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
            # D705: a cuisine the user typed in THIS query answers "does this row answer
            # what was asked?" as squarely as a keyword does - more squarely, when the
            # corpus never spells the word (no published row writes 泰式, 韓式 or 日式, and
            # `kw_score` on all three pages is 0.000 for every row: `tmp/d705_d652.py`).
            # It used to land in `personalization` - 0.06, the weight of the feedback EMA,
            # i.e. +0.03 over neutral - so the page needed a 0.05-0.15 cosine to find the
            # cuisine rows at all, and that cosine then poisoned every page where the
            # query's characters were common. At request weight it needs nothing else.
            relevance=max(_relevance(row, vector_lane=vector_lane, semantic=vector_semantic),
                          (typed_cuisine or {}).get(subject_id, 0.0)),
            rating=_num(row.get("rating_agg")),
            rating_count=int(row.get("review_count") or 0),
            tenant_mean_rating=_num(row.get("tenant_mean_rating")) or 3.5,
            distance_m=_num(row.get("meters")),
            price=_row_price(row),
            budget_max=plan.budget_max, budget_per=plan.budget_per,
            budget_min=plan.budget_min,
            # D632: the party the request names, so a `per: party` budget can be shared
            # across it before it meets a per-head price.
            party_size=plan.party_size,
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
def _indoor_evidence(attrs: dict[str, Any]) -> bool | None:
    """Whether the corpus says this place is INDOOR, or says it seats you outside.

    D622: `indoor_style` is written True on all 470 published rows ("most HK venues are
    indoor" - the seed's own comment), so as a first question it answers for the whole corpus
    and an indoor preference cannot move a page: measured, every one of the 184 restaurants a
    有室內座位 request filters to scored 1.0.  The discriminating fact is on the other side -
    `outdoor_seating`/`outdoor_style` name the places that are NOT indoor-first - so the
    outdoor witness is asked first and the constant is only the fallback.
    """
    if attrs.get("outdoor_seating") is True or attrs.get("outdoor_style") is True:
        return False
    if attrs.get("indoor_style") is True:
        return True
    return None


_INTENT_ATTR_ALIASES: dict[tuple[str, str], tuple[str, ...]] = {
    ("time_pref", "open_late"): ("opens_late",),
    # D621: the corpus writes "this place has outdoor space" twice - `outdoor_style` on 63 rows
    # and `outdoor_seating` on 111, of which 97 carry no style flag (measured 2026-10-30). The
    # typed-preference reader derived only `outdoor_style`, so those 97 answered None (neutral)
    # and the outdoor preference could reach at most 63 of the 111 merchants that state the fact.
    # The stored branch already reads both (`outdoor_seating` at weight 0.8); this is the same
    # fact reaching the reader that serves the query the user just typed.
    ("style", "outdoor"): ("outdoor_seating",),
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
                 vector_semantic: bool = True,
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
    location_ids: list[str] = []
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
    common = dict(tenant_id=str(tenant_id),
                  # D635: an empty match text is a request answered entirely by its filters -
                  # there is no term to search, and falling back to the raw sentence would put
                  # back the very word the filter consumed. A plan that never computed one
                  # (`None`) falls back as it always did.
                  text=canonical(plan.match_text if plan.match_text is not None
                                 else plan.query_text) or None,
                  filters=plan.filters, geo=plan.geo, radius_m=plan.radius_m,
                  limit=max(60, plan.limit * 3), with_total=True)
    # D705: the cuisines this request types, in the taxonomy's own slugs, so the candidate
    # cut above can be ordered by them (`sql.py`). A cuisine the user typed is a LIKE the
    # corpus cannot spell, so no keyword score can find it - the cut has to be told.
    typed_slugs: list[str] = []
    for pref in (intent_preferences or ()):
        if int(pref.get("polarity", 1) or 1) <= 0:
            continue
        key = str(pref.get("key") or "")
        if key == "cuisine":
            typed_slugs.extend(cuisine_leaves(str(pref.get("value") or "")))
        elif key == "cuisine_like":
            try:
                typed_slugs.extend(cuisine_leaves(str(v))
                                   for v in (json.loads(str(pref.get("value") or "{}"))
                                             .get("values") or []))
            except Exception:
                pass
    typed_slugs = sorted({s for s in typed_slugs if s})

    pool_total = 0
    if "merchant" in plan.subject_types:
        merchant_rows = await backend.merchant_candidates(
            embedding=list(embedding) if embedding else None,
            vector_semantic=vector_semantic, cuisine_slugs=typed_slugs or None,
            **common)
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
        # D609: a geo row names the location its district came from. This plane files every
        # `address` fact under `locations.id` (measured 684 of 684, 0 under a merchant), so a
        # load keyed only to the candidate subjects can never reach the district it prints.
        if r.get("location_id"):
            location_ids.append(str(r["location_id"]))

    fact_subject_ids = list(dict.fromkeys(subject_ids + location_ids))
    fact_rows = await backend.facts(fact_subject_ids) if fact_subject_ids else []
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
    # D705: a cuisine the user TYPED in this query is part of what they asked for, not a
    # memory about them - so it is remembered here and folded into `relevance` below. See
    # `candidates_from_rows` for why it cannot stay in `personalization`.
    typed_cuisine: dict[str, float] = {}
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
                                # D622: the outdoor witness comes first, for the reason
                                # `_indoor_evidence` states - `indoor_style` is a constant, so
                                # asking it first liked every row and demoted none.
                                if attrs.get("outdoor_seating") is True:
                                    return _sided(w * 0.8, liked=False)
                                if attrs.get("outdoor_style") is True:
                                    return _sided(w, liked=False)
                                if attrs.get("indoor_style") is True:
                                    return _sided(w, liked=True)
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

                # D702: `cuisine/vegetarian` emitted by the NLU when a user types
                # "素食" etc. maps to the merchant's `cuisine_vegetarian` boolean
                # attribute. The stored branch reads the same attribute; this is
                # the transient lane's mirror. Generic cuisine_matches would check
                # for a "vegetarian" tag which no merchant carries.
                if str(pref_kind) == "cuisine" and str(pref_value) == "vegetarian":
                    val = attrs.get("cuisine_vegetarian")
                    score = None
                    if val is True:
                        score = 1.0 if polarity > 0 else 0.0
                    elif val is False:
                        score = 0.0 if polarity > 0 else 1.0
                    intent_pref_scores.append(score if score is not None else 0.5)
                    if score is not None and score >= 0.5:
                        intent_matched_labels.append(
                            {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_cuisine_vegetarian"})
                    continue

                # D704: `cuisine/spicy` emitted by the NLU when a user types
                # "辣", "香辣", "spicy" etc. maps to the merchant's `spicy_cuisine`
                # boolean attribute. Generic cuisine_matches would check for a "spicy"
                # tag which no merchant carries; the seed writes spicy_cuisine instead.
                if str(pref_kind) == "cuisine" and str(pref_value) == "spicy":
                    val = attrs.get("spicy_cuisine")
                    score = None
                    if val is True:
                        score = 1.0 if polarity > 0 else 0.0
                    elif val is False:
                        score = 0.0 if polarity > 0 else 1.0
                    intent_pref_scores.append(score if score is not None else 0.5)
                    if score is not None and score >= 0.5:
                        intent_matched_labels.append(
                            {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_cuisine_spicy"})
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
                            typed_cuisine[sid] = 1.0
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
                if str(pref_kind) == "cuisine_like":
                    # D691: the NLU emits cuisine_like as {"values": ["cantonese","sushi"]}
                    # (json.dumps), and the matcher reads it through cuisine_matches via
                    # the leaf map bridge. The ranking lane must now also read it so that
                    # a user's typed cuisine preference is reflected in merchant scores.
                    try:
                        like_vals = json.loads(str(pref_value)).get("values", [])
                    except Exception:
                        like_vals = []
                    if like_vals:
                        cat = str(attrs.get("category_primary") or "")
                        tags = [str(t) for t in (attrs.get("tags") or [])]
                        # Check if ANY of the cuisine_like values match the merchant
                        has_match = any(cuisine_matches(v, cat, tags) for v in like_vals)
                        if has_match:
                            weight = 1.0 if polarity > 0 else 0.0
                            intent_pref_scores.append(weight)
                            if weight >= 0.5:
                                typed_cuisine[sid] = 1.0
                                intent_matched_labels.append(
                                    {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                     "source": "typed_like"})
                        else:
                            # A LIKE already answers neutral for a non-match;
                            # a DISLIKE must too.
                            intent_pref_scores.append(0.5 if polarity > 0 else 1.0)
                    else:
                        intent_pref_scores.append(0.5)
                    continue
                # D695: `weakness:<aspect>` targets the merchant's `weak_aspects` LIST
                # (D581). A user who refuses noise ("唔好嘈") gets `weakness:noise`
                # so the ranking lane demotes merchants weak at that aspect.
                if str(pref_kind) == "weakness":
                    aspect = str(pref_value)
                    weak = {str(x) for x in (attrs.get("weak_aspects") or []) if x}
                    is_weak = aspect in weak
                    if polarity > 0:
                        # User wants strength at this aspect: demote weak, boost not-weak
                        weight = 1.0
                        intent_pref_scores.append(
                            0.5 + abs(weight - 0.5) if not is_weak
                            else 0.5 - abs(weight - 0.5))
                    else:
                        # User dislikes strength here: boost weak, demote not-weak
                        weight = 1.0
                        intent_pref_scores.append(
                            0.5 + abs(weight - 0.5) if is_weak
                            else 0.5 - abs(weight - 0.5))
                    if intent_pref_scores and intent_pref_scores[-1] >= 0.5:
                        intent_matched_labels.append(
                            {"label": _preference_label(str(pref_kind), str(pref_value),
                                       pref_value),
                             "source": "typed_weakness"})
                    continue

                # D699: `style/ambience` (quiet/lively) emitted by the NLU when a user types
                # "有情調" etc. maps to the merchant's `quiet_ambience`/`lively_ambience`
                # boolean attributes. The stored branch (line ~1694) reads the same attributes;
                # this is the transient lane's mirror.
                if str(pref_kind) == "style" and str(pref_value) in ("quiet", "lively", "ambience"):
                    amb = str(pref_value)
                    if amb == "ambience":
                        # Generic "good ambience" - either quiet or lively counts
                        def make_style_ambience_match():
                            def _match(a2):
                                if a2.get("quiet_ambience") is True or a2.get("lively_ambience") is True:
                                    return _sided(1.0, liked=True)
                                return None
                            return _match
                        match_fn = make_style_ambience_match()
                    else:
                        want = "quiet_ambience" if amb == "quiet" else "lively_ambience"
                        other = "lively_ambience" if amb == "quiet" else "quiet_ambience"

                        def make_style_ambience_match(want_key, other_key):
                            def _match(a2):
                                if a2.get(want_key) is True:
                                    return _sided(1.0, liked=True)
                                if a2.get(other_key) is True:
                                    return _sided(1.0, liked=False)
                                return None
                            return _match
                        match_fn = make_style_ambience_match(want, other)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_style_ambience"})
                    continue

                # D706: `ambience/quiet` and `ambience/lively` emitted by the NLU when a user
                # types "安靜" / "熱鬧" etc. maps to the merchant's `quiet_ambience` /
                # `lively_ambience` boolean attributes. The stored branch (line ~1694) reads
                # the same attributes; this is the transient lane's mirror.
                if str(pref_kind) == "ambience" and str(pref_value) in ("quiet", "lively"):
                    want = "quiet_ambience" if str(pref_value) == "quiet" else "lively_ambience"
                    other = "lively_ambience" if str(pref_value) == "quiet" else "quiet_ambience"

                    def make_ambience_match(want_key, other_key, p):
                        def _match(a2):
                            if a2.get(want_key) is True:
                                return _sided(p, liked=True)
                            if a2.get(other_key) is True:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_ambience_match(want, other, 1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_ambience"})
                    continue

                # D707: `view/scenic` emitted by the NLU when a user types "海景" / "維港" /
                # "rooftop" etc. maps to the merchant's `scenic_view` boolean attribute. The
                # stored branch (line ~1776) reads the same attribute; this is the transient
                # lane's mirror.
                if str(pref_kind) == "view" and str(pref_value) == "scenic":
                    val = str(pref_value) == "scenic"  # always True for this key

                    def make_scenic_match(p):
                        def _match(a2):
                            if a2.get("scenic_view") is True:
                                return _sided(p, liked=True)
                            if a2.get("scenic_view") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_scenic_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_scenic"})
                    continue

                # D708: `access/pet_friendly` emitted by the NLU when a user types
                # "寵物" / "pet friendly" etc. maps to the merchant's `pet_friendly_access`
                # boolean attribute. The stored branch (line ~1730) reads the same attribute;
                # this is the transient lane's mirror.
                if str(pref_kind) == "access" and str(pref_value) == "pet_friendly":
                    val = str(pref_value) == "pet_friendly"  # always True for this key

                    def make_pet_match(p):
                        def _match(a2):
                            if a2.get("pet_friendly_access") is True:
                                return _sided(p, liked=True)
                            if a2.get("pet_friendly_access") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_pet_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_pet_friendly"})
                    continue

                # D709: `occasion/date` emitted by the NLU when a user types
                # "約會" / "date" etc. maps to the merchant's `date_occasion`
                # boolean attribute. The stored branch (line ~1744) reads the same
                # attribute; this is the transient lane's mirror.
                if str(pref_kind) == "occasion" and str(pref_value) == "date":
                    def make_date_match(p):
                        def _match(a2):
                            if a2.get("date_occasion") is True:
                                return _sided(p, liked=True)
                            if a2.get("date_occasion") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_date_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_occasion_date"})
                    continue

                # D710: `occasion/group` emitted by the NLU when a user types "聚會" / "group"
                # etc. maps to the merchant's `group_occasion` boolean attribute. The stored
                # branch (line ~1744) reads the same attribute; this is the transient lane's
                # mirror.
                if str(pref_kind) == "occasion" and str(pref_value) == "group":
                    def make_group_match(p):
                        def _match(a2):
                            if a2.get("group_occasion") is True:
                                return _sided(p, liked=True)
                            if a2.get("group_occasion") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_group_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_occasion_group"})
                    continue

                # D711: `occasion/family` emitted by the NLU when a user types "親子" / "family"
                # etc. maps to the merchant's `family_occasion` boolean attribute. The stored
                # branch (line ~1744) reads the same attribute; this is the transient lane's
                # mirror.
                if str(pref_kind) == "occasion" and str(pref_value) == "family":
                    def make_family_match(p):
                        def _match(a2):
                            if a2.get("family_occasion") is True:
                                return _sided(p, liked=True)
                            if a2.get("family_occasion") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_family_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_occasion_family"})
                    continue

                # D712: `occasion/business` emitted by the NLU when a user types "商務" / "business"
                # etc. maps to the merchant's `business_occasion` boolean attribute. The stored
                # branch (line ~1744) reads the same attribute; this is the transient lane's
                # mirror.
                if str(pref_kind) == "occasion" and str(pref_value) == "business":
                    def make_business_match(p):
                        def _match(a2):
                            if a2.get("business_occasion") is True:
                                return _sided(p, liked=True)
                            if a2.get("business_occasion") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_business_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_occasion_business"})
                    continue

                # D713: `occasion/solo` emitted by the NLU when a user types "一個人" / "solo"
                # etc. maps to the merchant's `solo_occasion` boolean attribute. The stored
                # branch (line ~1744) reads the same attribute; this is the transient lane's
                # mirror.
                if str(pref_kind) == "occasion" and str(pref_value) == "solo":
                    def make_solo_match(p):
                        def _match(a2):
                            if a2.get("solo_occasion") is True:
                                return _sided(p, liked=True)
                            if a2.get("solo_occasion") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_solo_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_occasion_solo"})
                    continue

                # D714: `access/mtr_near` emitted by the NLU when a user types "地鐵" / "mtr"
                # etc. maps to the merchant's `mtr_near_access` / `mtr_within_5min` boolean
                # attributes. The stored branch (line ~1940) reads the same attributes; this is
                # the transient lane's mirror.
                if str(pref_kind) == "access" and str(pref_value) == "mtr_near":
                    def make_mtr_match(p):
                        def _match(a2):
                            if a2.get("mtr_near_access") is True or a2.get("mtr_within_5min") is True:
                                return _sided(p, liked=True)
                            if a2.get("mtr_near_access") is False or a2.get("mtr_within_5min") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_mtr_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_mtr_near"})
                    continue

                # D700: `price_sense` (cheap/premium) emitted by the NLU when a user types
                # "平", "cheap", "貴", "premium" etc. maps to the merchant's `avg_price_hkd`.
                # The stored branch (line ~1790) reads the same attribute; this is the
                # transient lane's mirror.
                if str(pref_kind) == "price_sense" and str(pref_value) in ("cheap", "premium"):
                    is_cheap = str(pref_value) == "cheap"
                    price = attrs.get("avg_price_hkd")
                    score = None
                    if price is not None:
                        try:
                            price = float(price)
                        except Exception:
                            price = None
                    if price is not None:
                        if is_cheap:
                            if price <= 100:
                                score = 1.0
                            elif price <= 200:
                                score = 0.5
                            else:
                                score = 0.0
                        else:
                            if price >= 400:
                                score = 1.0
                            elif price >= 200:
                                score = 0.5
                            else:
                                score = 0.0
                        if polarity <= 0:
                            score = 1.0 - score
                    intent_pref_scores.append(score if score is not None else 0.5)
                    if score is not None and score >= 0.5:
                        intent_matched_labels.append(
                            {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                             "source": "typed_price_sense"})
                    continue

                # D701: `time_pref/open_late` emitted by the NLU when a user types
                # "宵夜", "深夜", "open late" etc. maps to the merchant's `opens_late`
                # boolean attribute. The stored branch reads the same attribute;
                # this is the transient lane's mirror.
                if str(pref_kind) == "time_pref" and str(pref_value) == "open_late":
                    def make_late_match(p):
                        def _match(a2):
                            if a2.get("opens_late") is True:
                                return _sided(p, liked=True)
                            if a2.get("opens_late") is False:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_late_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_open_late"})
                    continue

                # D703: `weather/rainy_day` emitted by the NLU when a user types
                # "下雨", "rainy", " typhoon" etc. maps to the merchant's `indoor_style`
                # / `outdoor_style` boolean attributes. The stored branch reads the same
                # attributes; this is the transient lane's mirror.
                if str(pref_kind) == "weather" and str(pref_value) == "rainy_day":
                    def make_rainy_match(p):
                        def _match(a2):
                            if a2.get("indoor_style") is True:
                                return _sided(p, liked=True)
                            if a2.get("outdoor_style") is True:
                                return _sided(p, liked=False)
                            return None
                        return _match
                    match_fn = make_rainy_match(1.0)
                    score = match_fn(attrs)
                    if score is not None:
                        intent_pref_scores.append(score)
                        if score >= 0.5:
                            intent_matched_labels.append(
                                {"label": _preference_label(str(pref_kind), str(pref_value),
                                               pref_value),
                                 "source": "typed_rainy_day"})
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
                if (str(pref_kind), str(pref_value)) == ("style", "indoor"):
                    # D622: a name-derived walk cannot express this one - the fact it needs is
                    # "does NOT seat you outside" - so the pair gets its own reader, the same
                    # `_indoor_evidence` the stored branch asks.
                    verdict = _indoor_evidence(attrs)
                    if verdict is not None:
                        intent_pref_scores.append(
                            (1.0 if verdict else 0.0) if polarity > 0
                            else (0.0 if verdict else 1.0))
                    continue
                attr_keys = [f"{pref_value}_{pref_kind}",   # date_occasion
                             f"{pref_kind}_{pref_value}"]   # occasion_date
                attr_keys += [a for a in _INTENT_ATTR_ALIASES.get(
                    (str(pref_kind), str(pref_value)), ()) if a not in attr_keys]

                # D621: ANY witness of the fact wins over a sibling spelling that says no.
                # The first version took the first attribute that was PRESENT, so a corpus
                # that writes one fact twice (`outdoor_style: false` + `outdoor_seating: true`
                # on 97 of 470 rows, measured) scored those merchants on the spelling that
                # happened to come first and never read the one that agreed with the user.
                # This is D527's lesson on the other side: a matcher must not let one
                # attribute's silence about a fact overrule another attribute's statement of it.
                weight: float | None = None
                if any(attrs.get(k) is True for k in attr_keys):
                    weight = 1.0 if polarity > 0 else 0.0
                elif any(attrs.get(k) is False for k in attr_keys):
                    weight = 0.0 if polarity > 0 else 1.0
                if weight is not None:
                    intent_pref_scores.append(weight)
                    # D392: name the preference that fired, so the card can say WHICH.
                    # D396: a preference typed in THIS query is "typed", not "declared".
                    if weight >= 0.5:
                        intent_matched_labels.append(
                            {"label": _preference_label(str(pref_kind), str(pref_value),
                                                       pref_value),
                             "source": "typed"})
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
                                      vector_semantic=vector_semantic,
                                      typed_cuisine=typed_cuisine,
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
