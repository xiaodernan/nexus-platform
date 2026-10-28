"""Parameterized candidate SQL — tsvector ∪ pg_trgm ∪ pgvector ∪ metadata ∪ geo.

DECISIONS D3: Postgres-only in phase 1 — `to_tsvector('simple')` + `pg_trgm` + pgvector
HNSW + bbox prefilter then haversine (no PostGIS in the image).

Rule enforced throughout this module: **values are never concatenated into SQL**. Every
user-supplied value goes through `Params`, which emits `$n` placeholders and returns the
bound list. The only inlined literals are the `tsvector` config name (allow-listed) and
structural SQL text.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, time
from typing import Any, Iterable

from nexus_ai.search.categories import (aspect_terms, avoid_terms,
                                     resolve as resolve_category)
from nexus_ai.search.tokens import cjk_keywords

TS_CONFIG_ALLOWLIST = {"simple", "english"}
EARTH_RADIUS_M = 6371008.8
VECTOR_FLOOR = 0.05
"""Cosine floor for a chunk hit to count as a vector candidate."""


def _avoid_terms(avoid: Iterable[Any]) -> list[str]:
    """Every spelling the avoided words stand for, deduped and order-stable (D517).

    `plan.avoid` carries the lexin's canonical constraint value; the corpus records the fact
    in the `tags` column under the taxonomy leaf. Reading only the raw token is what let
    `avoid=["seafood"]` past all 15 merchants tagged `seafood-grill`.
    """
    terms: list[str] = []
    for value in avoid:
        for term in avoid_terms(str(value)):
            if term not in terms:
                terms.append(term)
    return terms

def _avoid_aspects(avoid: Iterable[Any]) -> list[str]:
    """The `weak_aspects` names the refused words stand for (D595).

    `avoid` is the plan's canonical constraint values; the corpus records a merchant's
    weaknesses as the LIST attribute `weak_aspects`, in its own aspect vocabulary. Measured
    at HEAD, `avoid=["noise"]` and `["queue"]` each removed 0 of 470 published merchants while
    the corpus names `noise` on 15 and `waiting_time` on 15 - the fact existed and no reader
    joined it. Empty when no refused word has an aspect spelling, so a cuisine-only refusal
    adds no leg.
    """
    out: list[str] = []
    for value in avoid:
        for term in aspect_terms(str(value)):
            if term not in out:
                out.append(term)
    return out


def category_clause(p: Params, bucket: str, merchant_ref: str,
                    spelling: str | None = None) -> str | None:
    """Merchant categories live in the `categories` tree (10 roots + 67 leaves), while the
    NLU answers with one coarse bucket. Comparing the bucket to the denormalised
    `category_primary` label matched no live row, so resolve it and walk one tree level.

    None means the bucket has no counterpart in the taxonomy: the caller drops the filter
    rather than silently pretending it matched.

    D524: `spelling` is the caller's OWN value, and the taxonomy is asked whether it names a
    LEAF. It does for 21 of the 67 leaves - `specialty-coffee`, `cocktail-bar`,
    `hair-salon`, ... - whose names contain a word the bucket reader also knows, so the
    bucket they were rewritten into stands for the whole root. An exact leaf therefore wins
    and the bucket walk is the fallback, which is what a root ("cafe") and a plain word
    ("coffee") need.
    """
    slugs = resolve_category(bucket)
    if not slugs:
        return None
    ph = p.add(slugs)
    exact = p.add(resolve_category(spelling)) if spelling else None
    leaf = (f"c.slug = ANY({exact}::text[])" if exact else None)
    walked = f"(c.slug = ANY({ph}::text[]) OR pc.slug = ANY({ph}::text[]))"
    if leaf is None:
        legs = walked
    else:
        # the bucket walk only runs when the caller's spelling is not a leaf of its own
        legs = (f"({leaf} OR (NOT EXISTS (SELECT 1 FROM categories "
                f"WHERE slug = ANY({exact}::text[]) AND parent_id IS NOT NULL) "
                f"AND {walked}))")
    return ("EXISTS (SELECT 1 FROM merchant_categories mc "
            f"JOIN categories c ON c.id = mc.category_id "
            f"LEFT JOIN categories pc ON pc.id = c.parent_id "
            f"WHERE mc.merchant_id = {merchant_ref} AND {legs})")


class Params:
    """Ordered placeholder builder. `add(value)` -> `$n`; nothing is ever inlined."""

    def __init__(self) -> None:
        self.values: list[Any] = []

    def add(self, value: Any) -> str:
        self.values.append(value)
        return f"${len(self.values)}"

    def extend(self, values: Iterable[Any]) -> list[str]:
        return [self.add(v) for v in values]


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle metres; `haversine_sql` mirrors it in the database."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    return EARTH_RADIUS_M * math.acos(max(-1.0, min(1.0,
        math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl))))


def bbox(center_lat: float, center_lng: float, radius_m: float) -> tuple[float, float, float, float]:
    """(lat_min, lat_max, lng_min, lng_max) — the indexable prefilter (§6)."""
    d_lat = radius_m / 111320.0
    cos_lat = max(1e-4, math.cos(math.radians(center_lat)))
    d_lng = radius_m / (111320.0 * cos_lat)
    return (center_lat - d_lat, center_lat + d_lat, center_lng - d_lng, center_lng + d_lng)


def haversine_expr(lat_ph: str, lng_ph: str, col_lat: str, col_lng: str) -> str:
    """Correct spherical law-of-cosines expression, float8-cast for asyncpg."""
    la = f"radians({col_lat}::float8)"
    lo = f"radians({col_lng}::float8)"
    cla = f"radians({lat_ph}::float8)"
    clo = f"radians({lng_ph}::float8)"
    inner = (f"cos({cla}) * cos({la}) * cos({lo} - {clo}) + sin({cla}) * sin({la})")
    return f"({EARTH_RADIUS_M} * acos(greatest(-1.0, least(1.0, {inner}))))::float8"


@dataclass
class CandidateQuery:
    sql: str
    params: list[Any]
    ts_config: str = "simple"


def _tsconfig(ts_config: str) -> str:
    return ts_config if ts_config in TS_CONFIG_ALLOWLIST else "simple"


# --------------------------------------------------------------------- merchants
def build_merchant_query(
    *,
    tenant_id: str,
    text: str | None,
    embedding: list[float] | None,
    ts_config: str = "simple",
    filters: dict[str, Any] | None = None,
    geo: tuple[float, float] | None = None,
    radius_m: int | None = None,
    limit: int = 60,
) -> CandidateQuery:
    p = Params()
    cfg = _tsconfig(ts_config)
    filters = filters or {}
    text_ph = p.add(text or "")
    tsq = f"plainto_tsquery('{cfg}'::regconfig, {text_ph})"
    wsq = f"websearch_to_tsquery('{cfg}'::regconfig, {text_ph})"
    tenant_ph = p.add(str(tenant_id))
    limit_ph = p.add(int(limit))

    where = [f"m.tenant_id = {tenant_ph}::uuid", "m.status = 'published'"]
    if filters.get("category"):
        clause = category_clause(p, str(filters["category"]), "m.id",
                                 filters.get("category_spelling"))
        if clause:
            where.append(clause)
    if filters.get("max_price") is not None:
        where.append(f"(m.avg_price_hkd IS NULL OR m.avg_price_hkd <= {p.add(float(filters['max_price']))})")
    if filters.get("min_price") is not None:
        where.append(f"(m.avg_price_hkd IS NULL OR m.avg_price_hkd >= {p.add(float(filters['min_price']))})")
    if filters.get("min_rating") is not None:
        where.append(f"m.rating_agg >= {p.add(float(filters['min_rating']))}")
    if filters.get("tags"):
        where.append(f"m.tags && {p.add([str(t) for t in filters['tags']])}::text[]")
    if filters.get("exclude"):
        where.append(f"m.id::text <> ALL({p.add([str(x) for x in filters['exclude']])}::text[])")
    if filters.get("merchant_id"):
        where.append(f"m.id = {p.add(str(filters['merchant_id']))}::uuid")
    for key, value in (filters.get("attributes") or {}).items():
        where.append(f"m.attributes @> {p.add(json.dumps({str(key): value}, ensure_ascii=False))}::jsonb")
    if filters.get("district"):
        where.append(
            f"EXISTS (SELECT 1 FROM locations ld WHERE ld.merchant_id = m.id "
            f"AND lower(coalesce(ld.district,'')) = lower({p.add(str(filters['district']))}))")
    if filters.get("open_weekday") is not None and filters.get("open_time") is not None:
        wd = p.add(int(filters["open_weekday"]))
        # D399: bind a `datetime.time`, not a string. The column is `time`, and a string
        # bound to it makes asyncpg raise on the encode
        # ("'str' object has no attribute 'hour'") before the query ever runs.
        tm = p.add(filters["open_time"])
        where.append(
            f"EXISTS (SELECT 1 FROM business_hours bh WHERE bh.merchant_id = m.id "
            f"AND bh.weekday = {wd}::smallint AND ("
            f"(bh.crosses_midnight = false AND bh.opens_at <= {tm}::time AND bh.closes_at > {tm}::time) "
            f"OR (bh.crosses_midnight = true AND (bh.opens_at <= {tm}::time "
            f"OR bh.closes_at > {tm}::time))))")
    min_closing = filters.get("min_closing_hour")
    if min_closing is not None:
        where.append(
            f"EXISTS (SELECT 1 FROM business_hours bc WHERE bc.merchant_id = m.id AND ("
            f"bc.closes_at >= ({p.add(int(min_closing))}::int * interval '1 hour')::time "
            f"OR bc.crosses_midnight = true))")
    # D463: the mirror of the filter above - the merchant has to OPEN at or before the
    # hour the user named ("before seven", "up to seven").
    max_opening = filters.get("max_opening_hour")
    if max_opening is not None:
        where.append(
            f"EXISTS (SELECT 1 FROM business_hours bo WHERE bo.merchant_id = m.id AND ("
            f"bo.opens_at <= ({p.add(int(max_opening))}::int * interval '1 hour')::time "
            f"OR bo.crosses_midnight = true))")

    # ---- geo lane: bbox prefilter then haversine on the nearest primary location
    geo_join = ""
    geo_select = "NULL::float8 AS meters, NULL::text AS district, NULL::text AS address_line1, " \
                 "NULL::text AS mtr_station, NULL::int AS mtr_walk_min"
    if geo:
        lat, lng = float(geo[0]), float(geo[1])
        lat_ph, lng_ph = p.add(lat), p.add(lng)
        lat_min, lat_max, lng_min, lng_max = bbox(lat, lng, int(radius_m or 5000))
        b1, b2, b3, b4 = p.add(lat_min), p.add(lat_max), p.add(lng_min), p.add(lng_max)
        geo_select = ("loc.meters AS meters, loc.district AS district, "
                      "loc.address_line1 AS address_line1, loc.mtr_station AS mtr_station, "
                      "loc.mtr_walk_min AS mtr_walk_min")
        geo_join = f"""LEFT JOIN LATERAL (
          SELECT l.id, l.district, l.address_line1, l.mtr_station, l.mtr_walk_min,
                 {haversine_expr(lat_ph, lng_ph, 'l.lat', 'l.lng')} AS meters
          FROM locations l
          WHERE l.merchant_id = m.id
            AND l.lat BETWEEN {b1}::float8 AND {b2}::float8
            AND l.lng BETWEEN {b3}::float8 AND {b4}::float8
          ORDER BY meters ASC NULLS LAST LIMIT 1
        ) loc ON true"""
        where.append("loc.id IS NOT NULL")
        if radius_m:
            where.append(f"loc.meters <= {p.add(float(radius_m))}")

    # D407: the CONTAINMENT lane for Chinese. `to_tsvector('simple', ...)` cannot SEGMENT
    # Chinese (a CJK run with no spaces becomes ONE token, so 咖啡 never equals one) and
    # the `%` OPERATOR cannot match it either (it needs three-character trigrams, and a
    # two-character Chinese word has none). Measured on the seeded corpus: 咖啡 is in 8
    # merchants' Chinese names and 30 of their descriptions, 拉麵 in 8 descriptions - and
    # the tsvector lane matched NONE of them, so a Chinese query ranked the pool by rating
    # and answered with whatever came first.
    #
    # The lane is CONTAINMENT, not similarity, for the reason D405 measured on the chunk
    # lane: a trigram similarity of a long text against a short query does not separate a
    # real match from noise. A merchant either mentions the word or it does not. The
    # count is a FRACTION of the query's Chinese words, so a keyword query (one word) is
    # a full-strength match and a long utterance is a weak one.
    cjk = cjk_keywords(text)
    if cjk:
        tokens_ph = p.add(cjk)
        count_ph = p.add(len(cjk))
        contains_count = (
            "(SELECT count(*)::float8 FROM unnest(" + tokens_ph + "::text[]) AS t"
            " WHERE strpos(lower(coalesce(m.display_name_zh,'') || ' ' ||"
            " coalesce(m.description,'') || ' ' || coalesce(m.tags::text,'')),"
            " lower(t)) > 0)")
        contains_frac = "(" + contains_count + " / " + count_ph + "::float8)"
    else:
        contains_count = "0::float8"
        contains_frac = "0::float8"
    kw_score = (
        f"GREATEST(COALESCE(ts_rank(m.search_tsv, {tsq}), 0),"
        f" COALESCE(ts_rank(m.search_tsv, {wsq}), 0),"
        f" COALESCE(similarity(m.display_name, {text_ph}), 0),"
        f" COALESCE(similarity(coalesce(m.display_name_zh,''), {text_ph}), 0),"
        f" COALESCE(word_similarity({text_ph}, coalesce(m.display_name,'') || ' ' ||"
        f" coalesce(m.display_name_zh,'') || ' ' || coalesce(m.description,'') || ' ' ||"
        f" array_to_string(m.tags,' ')), 0)) + " + contains_frac)
    text_matched = (f"(m.search_tsv @@ {tsq} OR m.search_tsv @@ {wsq}"
                    f" OR m.display_name % {text_ph} OR coalesce(m.display_name_zh,'') % {text_ph}"
                    f" OR " + contains_count + " > 0)")
    # A browse request (no query text) must return every row the filters allow, but it
    # must not *claim* a text match: the ranking floor reads `text_matched` to decide
    # whether a query exists at all, and an empty query's relevance is always 0.
    has_text = bool((text or "").strip())
    matched_flag = text_matched if has_text else "false"

    # ---- vector lane: pgvector cosine, max-pooled from the merchant's chunks
    vec_join = ""
    vec_select = "0::float8 AS vec_score"
    if embedding:
        vec_ph = p.add(vector_literal(embedding))
        vec_join = f"""LEFT JOIN LATERAL (
          SELECT max(1 - (c.embedding <=> {vec_ph}::vector)) AS vec_score
          FROM chunks c
          WHERE c.merchant_id = m.id AND c.embedding IS NOT NULL
          GROUP BY c.merchant_id
          HAVING max(1 - (c.embedding <=> {vec_ph}::vector)) >= {VECTOR_FLOOR}
        ) vv ON true"""
        vec_select = "COALESCE(vv.vec_score, 0)::float8 AS vec_score"

    avoid = [str(a) for a in (filters.get("avoid") or [])]
    avoid_clause = ""
    if avoid:
        # D517: the term set is the corpus's OWN vocabulary, not the caller's raw token.
        # "唔食辣" must not silently pass a spicy-tagged merchant through (§8 filters), and
        # the tag is where the corpus records that fact.
        av_ph = p.add(_avoid_terms(avoid))
        aspects = _avoid_aspects(avoid)
        aspect_leg = ("" if not aspects else
                      f"\n            OR coalesce(m.attributes->'weak_aspects','[]'::jsonb)"
                      f" ?| {p.add(aspects)}::text[]")
        avoid_clause = f"""AND NOT (
            m.tags && {av_ph}::text[]
            OR coalesce(m.category_primary,'') = ANY({av_ph}::text[]){aspect_leg}
            OR EXISTS (SELECT 1 FROM offerings ao WHERE ao.merchant_id = m.id
                       AND ((ao.name || ' ' || coalesce(ao.name_zh,'') || ' ' ||
                             coalesce(ao.description,'')) ILIKE ANY(
                             SELECT '%'||x||'%' FROM unnest({av_ph}::text[]) x)
                            OR coalesce(ao.attributes->'allergens','[]'::jsonb)
                               ?| {av_ph}::text[])))"""

    order_expr = (f"(GREATEST({kw_score}, COALESCE(vv.vec_score, 0)))" if embedding
                  else kw_score)

    sql = f"""
SELECT m.id, m.slug, m.display_name, m.display_name_zh, m.description, m.category_primary,
       m.avg_price_hkd, m.rating_agg, m.review_count, m.popularity_score, m.tags,
       m.attributes, m.data_origin, m.plan, m.images, m.ai_agent_enabled,
       'merchant'::text AS subject_type, m.id::text AS subject_id, m.id::text AS merchant_id,
       {geo_select},
       {kw_score} AS kw_score,
       {matched_flag} AS text_matched,
       {vec_select},
       COALESCE(tm.mean_rating, 3.5)::float8 AS tenant_mean_rating
FROM merchants m
{geo_join}
{vec_join}
CROSS JOIN LATERAL (
  SELECT avg(r2.rating_agg)::float8 AS mean_rating FROM merchants r2
  WHERE r2.tenant_id = {tenant_ph}::uuid AND r2.status = 'published' AND r2.rating_agg > 0
) tm
WHERE {' AND '.join(where)}
  {avoid_clause}
ORDER BY {order_expr} DESC, m.rating_agg DESC
LIMIT {limit_ph}
"""
    return CandidateQuery(sql=sql, params=p.values, ts_config=cfg)


def vector_literal(embedding: Iterable[float]) -> str:
    """pgvector text form. Bound as a parameter and cast with `::vector` in the SQL."""
    return "[" + ",".join(f"{float(v):.6f}" for v in embedding) + "]"


# --------------------------------------------------------------------- offerings
def build_offering_query(
    *,
    tenant_id: str,
    text: str | None,
    ts_config: str = "simple",
    filters: dict[str, Any] | None = None,
    geo: tuple[float, float] | None = None,
    radius_m: int | None = None,
    limit: int = 60,
) -> CandidateQuery:
    """Offerings carry no chunks of their own, so this lane is keyword+metadata+geo
    only — honestly documented rather than faking a vector score (§13 lanes)."""
    p = Params()
    cfg = _tsconfig(ts_config)
    filters = filters or {}
    text_ph = p.add(text or "")
    tsq = f"plainto_tsquery('{cfg}'::regconfig, {text_ph})"
    wsq = f"websearch_to_tsquery('{cfg}'::regconfig, {text_ph})"
    tenant_ph = p.add(str(tenant_id))
    limit_ph = p.add(int(limit))

    where = [f"o.tenant_id = {tenant_ph}::uuid", "o.status = 'active'",
             "m.status = 'published'"]
    if filters.get("kind") in ("product", "service", "experience"):
        where.append(f"o.kind = {p.add(str(filters['kind']))}")
    if filters.get("category"):
        clause = category_clause(p, str(filters["category"]), "m.id",
                                 filters.get("category_spelling"))
        if clause:
            where.append(clause)
    if filters.get("max_price") is not None:
        where.append(f"(COALESCE(o.price_amount, o.price_max) IS NULL "
                     f"OR COALESCE(o.price_amount, o.price_max) <= {p.add(float(filters['max_price']))})")
    if filters.get("min_price") is not None:
        where.append(f"(COALESCE(o.price_amount, o.price_min) IS NULL "
                     f"OR COALESCE(o.price_amount, o.price_min) >= {p.add(float(filters['min_price']))})")
    if filters.get("merchant_id"):
        where.append(f"o.merchant_id = {p.add(str(filters['merchant_id']))}::uuid")
    if filters.get("exclude"):
        where.append(f"o.id::text <> ALL({p.add([str(x) for x in filters['exclude']])}::text[])")
    if filters.get("min_rating") is not None:
        where.append(f"o.rating_agg >= {p.add(float(filters['min_rating']))}")
    for key, value in (filters.get("attributes") or {}).items():
        where.append(f"o.attributes @> {p.add(json.dumps({str(key): value}, ensure_ascii=False))}::jsonb")

    geo_join = ""
    geo_select = "NULL::float8 AS meters, NULL::text AS district"
    if geo:
        lat, lng = float(geo[0]), float(geo[1])
        lat_ph, lng_ph = p.add(lat), p.add(lng)
        lat_min, lat_max, lng_min, lng_max = bbox(lat, lng, int(radius_m or 5000))
        b1, b2, b3, b4 = p.add(lat_min), p.add(lat_max), p.add(lng_min), p.add(lng_max)
        geo_select = "loc.meters AS meters, loc.district AS district"
        geo_join = f"""JOIN LATERAL (
          SELECT l.id, l.district,
                 {haversine_expr(lat_ph, lng_ph, 'l.lat', 'l.lng')} AS meters
          FROM locations l
          WHERE l.merchant_id = m.id
            AND l.lat BETWEEN {b1}::float8 AND {b2}::float8
            AND l.lng BETWEEN {b3}::float8 AND {b4}::float8
          ORDER BY meters ASC NULLS LAST LIMIT 1
        ) loc ON true"""
        where.append("loc.id IS NOT NULL")
        if radius_m:
            where.append(f"loc.meters <= {p.add(float(radius_m))}")

    # D583: the merchant lane's D407 containment leg, aimed at the offering's OWN text.
    # The corpus was measured, not assumed: 咖啡 is in 80 published offerings, 拉麵 in 43 and
    # 甜品 in 39, and the offering lane's tsvector cannot match any of them - a Chinese run
    # becomes one token, and the two available text search configs both answer False for a
    # offering text matched against its own word. So every row the lane returned carried the
    # SAME kw_score (0.3333 for 咖啡, from word_similarity alone) and the page was ordered by
    # rating: the 24 mentioning rows of the 60 it served stood at ranks 4 through 54. The
    # merchant lane, with this leg, puts its 27 mentioning rows at 0 through 26. Two lanes of
    # one product must not answer one Chinese word with two different orders (D449).
    cjk = cjk_keywords(text)
    if cjk:
        tokens_ph = p.add(cjk)
        count_ph = p.add(len(cjk))
        contains_count = (
            "(SELECT count(*)::float8 FROM unnest(" + tokens_ph + "::text[]) AS t"
            " WHERE strpos(lower(coalesce(o.name,'') || ' ' || coalesce(o.name_zh,'') ||"
            " ' ' || coalesce(o.description,'') || ' ' || coalesce(o.description_zh,'')),"
            " lower(t)) > 0)")
        contains_frac = "(" + contains_count + " / " + count_ph + "::float8)"
    else:
        contains_count = "0::float8"
        contains_frac = "0::float8"
    kw_score = (
        f"GREATEST(COALESCE(ts_rank(o.search_tsv, {tsq}), 0),"
        f" COALESCE(ts_rank(o.search_tsv, {wsq}), 0),"
        f" COALESCE(similarity(o.name, {text_ph}), 0),"
        f" COALESCE(similarity(coalesce(o.name_zh,''), {text_ph}), 0),"
        f" COALESCE(word_similarity({text_ph}, coalesce(o.name,'') || ' ' ||"
        f" coalesce(o.name_zh,'') || ' ' || coalesce(o.description,'') || ' ' ||"
        f" coalesce(o.description_zh,'')), 0)) + " + contains_frac)
    has_text = bool((text or "").strip())
    match = (f"(o.search_tsv @@ {tsq} OR o.search_tsv @@ {wsq} OR o.name % {text_ph}"
             f" OR coalesce(o.name_zh,'') % {text_ph}"
             f" OR " + contains_count + " > 0)") if has_text else "true"
    matched_flag = match if has_text else "false"

    avoid = [str(a) for a in (filters.get("avoid") or [])]
    avoid_clause = ""
    if avoid:
        # D517: the same vocabulary expansion as the merchant lane, so the two lanes
        # exclude the same merchants for the same word.
        av_ph = p.add(_avoid_terms(avoid))
        aspects = _avoid_aspects(avoid)
        aspect_leg = ("" if not aspects else
                      f"\n            OR coalesce(m.attributes->'weak_aspects','[]'::jsonb)"
                      f" ?| {p.add(aspects)}::text[]")
        avoid_clause = f"""AND NOT (m.tags && {av_ph}::text[]
            OR coalesce(m.category_primary,'') = ANY({av_ph}::text[]){aspect_leg}
            OR (coalesce(o.name,'') || ' ' || coalesce(o.name_zh,'')
                || ' ' || coalesce(o.description,'')) ILIKE ANY(
              SELECT '%'||x||'%' FROM unnest({av_ph}::text[]) x)
            OR coalesce(o.attributes->'allergens','[]'::jsonb) ?| {av_ph}::text[])"""

    sql = f"""
SELECT o.id, o.merchant_id, o.slug, o.name, o.name_zh, o.description, o.description_zh,
       o.kind, o.price_amount, o.price_min, o.price_max, o.currency, o.price_model,
       o.price_source, o.price_updated_at, o.stock_quantity, o.stock_updated_at,
       o.bookable, o.min_party_size, o.max_party_size, o.rating_agg, o.review_count,
       o.popularity_score, o.attributes, o.images, o.constraints,
       m.slug AS merchant_slug, m.display_name AS merchant_name,
       m.display_name_zh AS merchant_name_zh, m.category_primary AS category,
       m.avg_price_hkd, m.data_origin, m.plan, m.tags,
       coalesce(m.attributes->'weak_aspects','[]'::jsonb) AS merchant_weak_aspects,
       'offering'::text AS subject_type, o.id::text AS subject_id, o.merchant_id::text AS merchant_id_key,
       {geo_select},
       {kw_score} AS kw_score,
       {matched_flag} AS text_matched,
       0::float8 AS vec_score,
       COALESCE((SELECT avg(r2.rating_agg)::float8 FROM merchants r2
                 WHERE r2.tenant_id = {tenant_ph}::uuid AND r2.status='published'
                   AND r2.rating_agg > 0), 3.5) AS tenant_mean_rating
FROM offerings o
JOIN merchants m ON m.id = o.merchant_id
{geo_join}
WHERE {' AND '.join(where)}
  {avoid_clause}
ORDER BY {kw_score} DESC, o.rating_agg DESC
LIMIT {limit_ph}
"""
    return CandidateQuery(sql=sql, params=p.values, ts_config=cfg)


# --------------------------------------------------------------------- side queries
# D506: every by-ids predicate below binds `uuid[]` against the column's own type.
# `col::text = ANY($n::text[])` is type-legal and answers correctly, but casting the
# column makes the predicate UNEINDEXABLE: the planner reads the whole table instead of
# walking its index, and cold those reads pushed `/ai/v1/compare` past this service's own
# statement_timeout so the request answered 503. The ids stay bound as strings - asyncpg
# encodes a list of str for a `uuid[]`. The plan is measured, not remembered, by
# apps/ai/tests/test_uuid_id_bindings.py.
def facts_for(subject_ids: Iterable[str], attributes: Iterable[str] | None = None
              ) -> tuple[str, list[Any]]:
    p = Params()
    ids = [str(s) for s in subject_ids if s]
    if not ids:
        return "", []
    sql = f"""
SELECT id::text AS fact_id, subject_type, subject_id::text AS subject_id,
       merchant_id::text AS merchant_id, attribute, value, unit, currency, source,
       source_uri, confidence::float8 AS confidence, observed_at, expires_at, stale
FROM facts
WHERE subject_id = ANY({p.add(ids)}::uuid[])
"""
    if attributes:
        sql += f" AND attribute = ANY({p.add(list(attributes))}::text[])"
    sql += " ORDER BY confidence DESC, observed_at DESC"
    return sql, p.values


def hours_for(merchant_ids: Iterable[str]) -> tuple[str, list[Any]]:
    p = Params()
    ids = [str(m) for m in merchant_ids if m]
    if not ids:
        return "", []
    sql = f"""
SELECT merchant_id::text AS merchant_id, weekday, opens_at, closes_at, crosses_midnight, source
FROM business_hours WHERE merchant_id = ANY({p.add(ids)}::uuid[])
ORDER BY merchant_id, weekday, opens_at
"""
    return sql, p.values


def slots_for(merchant_ids: Iterable[str], starts_at: datetime, ends_at: datetime,
              party_size: int | None = None) -> tuple[str, list[Any]]:
    p = Params()
    ids = [str(m) for m in merchant_ids if m]
    if not ids:
        return "", []
    sql = f"""
SELECT merchant_id::text AS merchant_id, id::text AS slot_id, starts_at, ends_at,
       capacity_total, capacity_left, price_amount, currency, source
FROM availability_slots
WHERE merchant_id = ANY({p.add(ids)}::uuid[])
  AND starts_at >= {p.add(starts_at)} AND starts_at <= {p.add(ends_at)}
  AND capacity_left > 0
"""
    if party_size:
        sql += f"  AND capacity_left >= {p.add(int(party_size))}\n"
    sql += " ORDER BY merchant_id, starts_at"
    return sql, p.values


def reviews_for(merchant_ids: Iterable[str], per_merchant: int = 5) -> tuple[str, list[Any]]:
    p = Params()
    ids = [str(m) for m in merchant_ids if m]
    if not ids:
        return "", []
    sql = f"""
SELECT r.id::text AS review_id, r.merchant_id::text AS merchant_id,
       r.offering_id::text AS offering_id, r.rating::float8 AS rating, r.title, r.body,
       r.language, r.created_at, r.verified_purchase, r.verified_reservation,
       r.data_origin, r.aspects, r.helpful_count
FROM reviews r
WHERE r.merchant_id = ANY({p.add(ids)}::uuid[]) AND r.status = 'published'
  AND r.id IN (SELECT id FROM reviews r2
               WHERE r2.merchant_id = ANY({p.add(ids)}::uuid[])
                 AND r2.status='published'
               ORDER BY r2.merchant_id, r2.helpful_count DESC, r2.created_at DESC)
ORDER BY r.merchant_id, r.helpful_count DESC, r.created_at DESC
"""
    return sql, p.values


def user_preferences_for(user_id: str, kinds: Iterable[str] | None = None) -> tuple[str, list[Any]]:
    """Read the user's LIVE preferences for ranking personalization.

    Returns rows with (kind, key, value, weight, source) for the given user.
    If kinds is provided, only returns preferences of those kinds.

    D585: the deadline is part of the row. `IdentityRepository.upsertPreference` computes
    `expires_at = now + ttlDays` on every insert and the shipped types name the promise
    ("Inferred memory may expire; declared memory does not", `packages/types/src/auth.ts`).
    A read that never looks at the column keeps ranking with a memory the platform has
    already let go of, and `service.py` attaches its `_preference_label` to the card as a
    reason the user was told they no longer have - D522's shape, the reader not looking at
    the column the writer writes. A NULL deadline is the declared case: never expires.
    """
    p = Params()
    uid_ph = p.add(str(user_id))
    where = [f"user_id = {uid_ph}::uuid",
             "(expires_at is null or expires_at > now())"]
    if kinds:
        kind_list = [str(k) for k in kinds]
        where.append(f"kind = ANY({p.add(kind_list)}::text[])")
    sql = f"""
SELECT kind, key, value, weight::float8 AS weight, source
FROM user_preferences
WHERE {' AND '.join(where)}
ORDER BY kind, key
"""
    return sql, p.values


def compare_geo(tenant_id: str, merchant_ids: Iterable[str], lat: float, lng: float
                ) -> tuple[str, list[Any]]:
    """Each merchant's distance from a point and its district, from its PRIMARY location (D401).

    The comparison grid needs a distance row (\u00a737: "three merchants from real rows only", and the
    e2e spec asserts the compare table shows Price, Rating and Distance). A distance
    needs a reference point, so this reads the same primary location the search's geo
    lane reads \u2014 the nearest one to the point when a merchant has several, so the two lanes
    cannot disagree about how far a merchant is.

    The DISTRICT comes from the same row: the grid already built a `district` row and
    dropped it every time, because `entities_for` selects no district column, so the
    cells were always empty. Reading the district beside the distance is what makes the
    row real.
    """
    p = Params()
    ids = [str(m) for m in merchant_ids if m]
    if not ids:
        return "", []
    tenant_ph = p.add(str(tenant_id))
    ids_ph = p.add(ids)
    lat_ph, lng_ph = p.add(float(lat)), p.add(float(lng))
    expr = haversine_expr(lat_ph, lng_ph, "l.lat", "l.lng")
    sql = f"""
SELECT m.id::text AS merchant_id,
       (SELECT {expr}
          FROM locations l
         WHERE l.merchant_id = m.id
         ORDER BY l.is_primary DESC, {expr} ASC NULLS LAST
         LIMIT 1) AS meters,
       (SELECT l.district
          FROM locations l
         WHERE l.merchant_id = m.id
         ORDER BY l.is_primary DESC, {expr} ASC NULLS LAST
         LIMIT 1) AS district
  FROM merchants m
 WHERE m.tenant_id = {tenant_ph}::uuid
   AND m.id = ANY({ids_ph}::uuid[])
   AND m.status = 'published'
"""
    return sql, p.values


def entities_for(tenant_id: str, subject_ids: Iterable[str]) -> tuple[str, list[Any]]:
    """Merchant + offering rows by explicit ids — the `/ai/v1/compare` read path.

    Values are bound, never inlined; the tenant filter is structural (§0).

    The offering branch carries `price_updated_at` and `price_source` because the grid stamps
    its price cell from the row's own clock (D590, the compare reader of D589). `merchants`
    has no such column - V1 gives it `avg_price_hkd` and `price_band` and no price clock - so
    the merchant branch selects NULLs for both and its cell keeps the unverified marker
    instead of a stamp this table cannot support.
    """
    p = Params()
    ids = [str(s) for s in subject_ids if s]
    if not ids:
        return "", []
    tenant_ph = p.add(str(tenant_id))
    ids_ph = p.add(ids)
    sql = f"""
SELECT m.id::text AS subject_id, 'merchant'::text AS subject_type, m.id::text AS merchant_id,
       m.slug, m.display_name AS name, m.display_name_zh AS name_zh, NULL::text AS kind,
       m.category_primary AS category, m.avg_price_hkd, NULL::text AS currency,
       NULL::text AS price_model,
       NULL::timestamptz AS price_updated_at, NULL::text AS price_source,
       m.rating_agg, m.review_count, m.description,
       m.data_origin, m.plan, m.attributes, m.images, m.ai_agent_enabled, m.status
FROM merchants m
WHERE m.tenant_id = {tenant_ph}::uuid AND m.id = ANY({ids_ph}::uuid[])
  AND m.status = 'published'
UNION ALL
SELECT o.id::text, 'offering', o.merchant_id::text,
       o.slug, o.name, o.name_zh, o.kind, m.category_primary,
       COALESCE(o.price_amount, o.price_min), o.currency, o.price_model,
       o.price_updated_at, o.price_source,
       o.rating_agg, o.review_count, o.description,
       m.data_origin, m.plan, o.attributes, o.images, m.ai_agent_enabled, o.status
FROM offerings o JOIN merchants m ON m.id = o.merchant_id
WHERE o.tenant_id = {tenant_ph}::uuid AND o.id = ANY({ids_ph}::uuid[])
  AND o.status = 'active' AND m.status = 'published'
"""
    return sql, p.values


def _tsconfig_to_cfg(ts_config: str) -> str:
    """Map user-friendly ts_config name to Postgres tsvector config name."""
    mapping = {
        "simple": "simple",
        "cjk_zh": "jiebacfg",  # CJK Bigram configuration for Chinese
        "english": "english",
    }
    return mapping.get(ts_config, "simple")


def build_chunk_query(*, tenant_id: str, merchant_id: str | None, text: str,
                      embedding: list[float] | None, top_k: int = 8,
                      ts_config: str = "simple") -> CandidateQuery:
    """Hybrid chunk retrieval — RAG §7: tsvector ∪ vector, tenant (+merchant) and document
    readiness filtered

    BEFORE ranking, `source_uri`/`document_id` carried so every answer can cite.

    If `ts_config` is `"simple"`, uses Postgres `to_tsvector('simple')` which cannot
    segment CJK ideographs — Chinese/Japanese/Korean words without spaces will not
    match. Use `ts_config="cjk_zh"` for CJK-aware trigram matching, or `"english"`
    for Western text.
    """
    p = Params()
    cfg = _tsconfig_to_cfg(ts_config)
    text_ph = p.add(text or "")
    tsq = f"plainto_tsquery('{cfg}'::regconfig, {text_ph})"
    kw_expr = f"COALESCE(ts_rank(c.search_tsv, {tsq}), 0)"
    # D402: the trigram lane. `to_tsvector('simple', ...)` cannot SEGMENT Chinese: a
    # CJK run with no spaces becomes ONE token, so a Chinese word never matches one
    # (79 seeded chunks contain 咖啡 and 0 of them match
    # `search_tsv @@ plainto_tsquery('simple','咖啡')`). The vector lane cannot cover
    # it either: the seeded chunks carry no embedding, so the retrieval returned
    # NOTHING for a Chinese query. `similarity()` is the trigram function that does
    # work on CJK (the `%` OPERATOR does not: it needs three-character trigrams, and
    # a two-character Chinese word has none).
    trigram_expr = f"COALESCE(similarity(c.text, {text_ph}::text), 0)"
    tenant_ph = p.add(str(tenant_id))
    limit_ph = p.add(int(max(1, min(top_k, 40))))  # §9: rerank budget is top-40
    where = [f"c.tenant_id = {tenant_ph}::uuid",
             # D586: `markForReindex` moves a rewritten document to status='pending' and, by
             # its own comment, "does not touch `chunks`" - so the superseded text stays in
             # the table for the whole rebuild window. Retrieval that never reads the column
             # cites a merchant's old menu as their current one.
             "d.status = 'indexed'",
             f"({kw_expr} > 0 OR {trigram_expr} > 0 OR c.embedding IS NOT NULL)"]
    if merchant_id:
        where.append(f"c.merchant_id = {p.add(str(merchant_id))}::uuid")
    if embedding:
        vec_ph = p.add(vector_literal(embedding))
        vec_expr = f"GREATEST(0, 1 - (c.embedding <=> {vec_ph}::vector))"
    else:
        vec_expr = "0"
    score = f"GREATEST({kw_expr}, {trigram_expr}, {vec_expr})"
    sql = f"""
SELECT c.id::text AS id, c.text, c.document_id::text AS document_id,
       c.merchant_id::text AS merchant_id, d.source_uri, c.section, c.metadata,
       {kw_expr}::float8 AS kw_score,
       {trigram_expr}::float8 AS trigram_score,
       {vec_expr}::float8 AS vec_score
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE {' AND '.join(where)}
ORDER BY {score} DESC
LIMIT {limit_ph}
"""
    return CandidateQuery(sql=sql, params=p.values, ts_config=cfg)


def open_now_predicate_expr(now: datetime) -> tuple[int, str]:
    """(weekday, 'HH:MM:SS') in Asia/Hong_Kong — bound as params by the caller."""
    from nexus_ai.nlu.timeparse import HK_TZ

    local = now.astimezone(HK_TZ) if now.tzinfo else now.replace(tzinfo=HK_TZ)
    return local.weekday(), local.strftime("%H:%M:%S")


def time_today(hh: int, mm: int = 0) -> time:
    return time(hh, mm)
