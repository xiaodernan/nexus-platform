#!/usr/bin/env python3
# SYNTHETIC DEMO DATA - NOT REAL BUSINESSES
#
# NEXUS (Hong Kong) seed-data generator — pure Python 3.11 stdlib, no third-party deps, no network.
#
#   python data/seed/generate.py                    # full set: 520 merchants / ~5.7k offerings / 11k reviews
#   python data/seed/generate.py --counts ci        # small deterministic set for CI
#   python data/seed/generate.py --merchants 80 --reviews 900 --days 3
#
# Emits, for every table in FK-safe load order:
#   out/NN_<table>.csv   portable dump  (line 1 = disclaimer, line 2 = column header, then rows)
#   out/NN_<table>.sql   psql `COPY … FROM STDIN` script (disclaimer as a SQL comment, then rows)
# load.sh pipes the .sql files into the container; the .csv files are the standalone artefact.
#
# Honesty (§109, §155, DECISIONS.md D6): every brand, address, phone, domain, dish, review and
# availability slot below is invented and marked `demo`.  Nothing here is, or may be presented as,
# real Hong Kong business data.
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from seed_pools import (  # noqa: E402
    ADJACENT, ALLERGEN_NOTES, ASPECTS, BLDG_EN, BLDG_ZH, CAT_TREE, DEMO_STATEMENT_DOC,
    DISH_POOL, DEMO_URI, DISCLAIMER, DISCLAIMER_UNI, DISTRICTS, DIST_BY_SLUG, DOW_EN,
    DOW_ZH, HOURS_PROFILES, LEAF_CUISINE_EN, LEAF_CUISINE_ZH, LEAF_SPEC, MIX_CONNECTORS,
    NAME_EN_1, NAME_EN_2, NAME_SUFFIX_ZH, NAME_ZH_1, NAME_ZH_2, OCCASION, PASSWORD_HASH_PLACEHOLDER,
    PARTY, POLICY_LINES, REAL_HK_BLOCKLIST, REVIEW_CLOSER, REVIEW_OPENER, REVIEW_TEXT,
    SHA_TIN_CENTROID, STREET_EN_HEAD, STREET_EN_SUF, STREET_ZH_HEAD, STREET_ZH_SUF,
    TOP_NAMES, VERDICT, WHO,
)

NULL = "\\N"
HK = timezone(timedelta(hours=8))
NS = uuid.UUID("00000000-0000-0000-0000-00000000dee0")
TENANT_ID = "00000000-0000-0000-0000-000000000001"   # stable hong-kong uuid owned by the infra stream
U_CONSUMER = "00000000-0000-0000-0000-00000000d001"
U_OWNERS = ["00000000-0000-0000-0000-00000000d002",
            "00000000-0000-0000-0000-00000000d003",
            "00000000-0000-0000-0000-00000000d004"]
U_ADMIN = "00000000-0000-0000-0000-00000000d005"
DEMO_PASSWORD = "nexus-demo-2026"          # documented demo login; never stored as a hash here

# The `owner` preset from com.nexus.merchant.MerchantPermissions.OWNER, copied because this generator and
# that class cannot share a build. The copy is checked rather than trusted: quality.sql fails the fresh-data
# gate if an owner membership lacks `admin_members`, and scripts/verify_workspace_flow.py signs in as a
# seeded owner and calls the routes it gates — so a preset the dataset does not carry surfaces as a red
# check in the harness instead of as a 403 in someone's demo.
OWNER_PERMISSIONS = [
    "write_profile", "publish_listing", "read_products", "write_products", "read_orders",
    "read_analytics", "configure_ai", "send_message", "create_draft_campaign", "publish_campaign",
    "admin_members", "create_reservation",
]

# TTLs per AGENT_CONTRACT.md §5
TTL_HOURS = {"price": 6, "inventory": 0.25, "opening_hours": 24, "description": 24 * 7,
             "review_summary": 24, "popularity": 1, "address": 24 * 30, "cuisine": 24 * 30,
             "rating": 24, "availability": 0}

# `facts.source` is the provenance vocabulary of API_CONTRACT §2 / AGENT_CONTRACT §4, and it is a free
# `text` column with no CHECK — the enum lives in `packages/types` (`FactSource`) and in the docs, so the
# seeder is the only place that can actually keep it honest.
FACT_SOURCES = ("merchant", "imported", "observed", "third_party", "inferred", "demo")
# An *estimated* price is how the number was obtained, not who vouched for it: `offerings.price_source`
# keeps that word (the profile's `flags.estimated_price` reads it), while the fact that carries the same
# number says `inferred`, which is the documented provenance for "the platform worked this out".
PRICE_SOURCE_TO_FACT = {"estimated": "inferred"}


# --------------------------------------------------------------------------- primitive helpers
def uid(kind: str, key: str) -> str:
    """Deterministic uuid5 so reruns and CI scaling produce stable ids."""
    return str(uuid.uuid5(NS, f"{kind}:{key}"))


def sha256_of(*parts: str) -> str:
    import hashlib
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()


def _moderation_status(review_id: str, seed: int) -> str:
    """Publish most reviews, hold a few for moderation — keyed off the review id so the mix is
    stable when unrelated generator phases move around in the RNG stream (95/4/1)."""
    h = int(sha256_of("moderation", str(seed), review_id)[:8], 16) / 0xFFFFFFFF
    return "flagged" if h < 0.01 else ("pending" if h < 0.05 else "published")


class Arr(list):
    """Marker: emit as a Postgres text[] literal."""


def round2(x) -> float:
    """Two-dp rounding that agrees with Postgres ``round(numeric, 2)``.

    Python's built-in ``round`` is half-to-even, so twelve reviews averaging 2.825 store as 2.82 while
    any SQL recompute over the same rows returns 2.83. That is not a cosmetic difference here: the
    rating and price facts below are re-derived from the rows they summarise, so a seeder that rounds
    one way and a database that rounds the other produce two true answers for one rendered number
    (§19, and the reason ``quality.sql`` compares a stored aggregate against a recomputed one).
    ``numeric`` rounds half away from zero, so the seeder does too.
    """
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def m2(x) -> str:
    return f"{round2(x):.2f}"


def mean2(vals) -> float:
    """The mean of 1-dp star ratings, rounded the way ``round(numeric, 2)`` in SQL rounds.

    Decimal rather than float: twelve 1-dp stars sum to exactly 33.9, while float addition can hand
    back 33.899999999999995, and a quotient sitting on a half-cent boundary then rounds the wrong way
    again — the same one-cent disagreement with SQL that {@link round2} exists to remove. Ratings come
    from ``round(..., 1)``, so ``str(v)`` is always a short exact decimal.
    """
    if not vals:
        return 0.0
    total = sum((Decimal(str(v)) for v in vals), Decimal(0))
    return float((total / Decimal(len(vals))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def rating_confidence(n: int) -> float:
    """How much a mean over ``n`` reviews is worth (spec §19, AGENT_CONTRACT §4).

    The value itself is exact either way — this is the statement of how generalisable it is. Four
    opinions of one shop are a weaker claim than four hundred, and the confidence band is what the AI
    layer reads before it decides to hedge (``CONFIDENCE_FLOOR_PHRASE``) or to omit the claim, so a
    flat 0.9 for every merchant would let a single five-star review be quoted as a rating without
    qualification. The bands stay at or above that hedge floor, because a review mean really is the
    platform's own arithmetic over real rows — it is the *sample* that is thin, not the method.
    """
    if n < 5:
        return 0.7
    if n < 50:
        return 0.8
    return 0.9


def ts(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=HK)
    return dt.strftime("%Y-%m-%d %H:%M:%S+08")


def add_min(h: int, m: int, delta: int):
    total = h * 60 + m + delta
    return (total // 60) % (24 * 60), total % 60


def _conv(v):
    if v is None:
        return NULL
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, Arr):
        if not v:
            return "{}"
        return "{" + ",".join('"' + str(x).replace('"', '\\"') + '"' for x in v) + "}"
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    if isinstance(v, datetime):
        return ts(v)
    if isinstance(v, float):
        return m2(v)
    return str(v)


def row(vals) -> list[str]:
    return [_conv(v) for v in vals]


def slugify(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s or "x"


def check_blocklist(text: str):
    for bad in REAL_HK_BLOCKLIST:
        if bad and bad in text:
            return bad
    return None


def clean_body(s: str) -> str:
    s = s.replace("\u3000", " ")
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = re.sub(r"\{[a-z_]+\}", "", s)          # defensive: never ship an unfilled token
    s = re.sub(r"\s+([,。；，])", r"\1", s)
    s = re.sub(r",{2,}", ",", s)
    s = re.sub(r"。{2,}", "。", s)
    if not s.endswith(("。", ".", "！", "!", "？", "?")):
        s += "。" if any("\u4e00" <= c <= "\u9fff" for c in s) else "."
    return s


def approx_tokens(text: str) -> int:
    """Rough token count for chunk sizing only (the AI service does the real tokenisation).
    Chinese costs ~1 token per character on cl100k-class tokenisers, Latin ~4 chars per token;
    the previous cjk/1.4 estimator under-shot CJK-heavy menus by ~40% and produced chunks that
    broke the §7 240-400 window, so it is deliberately conservative here."""
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - cjk
    return max(1, int(cjk + other / 4.0))


CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def is_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text))


def script_matched(pool: list[str], want_zh: bool) -> list[str]:
    """Keep review sentences in the review's own script (10% code-switched reviews are handled
    separately) — otherwise a 'zh-HK' review ends up with whole English sentences in it."""
    matched = [t for t in pool if is_cjk(t) == want_zh]
    return matched or pool


# --------------------------------------------------------------------------- table contract (FK-safe order)
TABLES: list[tuple[str, list[str]]] = [
    ("tenants", ["id", "slug", "name", "country_code", "region_code", "timezone", "currency",
                 "locales", "status", "config", "created_at", "updated_at"]),
    ("users", ["id", "tenant_id", "email", "phone", "password_hash", "display_name", "avatar_url",
               "locale", "role", "status", "marketing_opt_in", "last_login_at", "created_at", "updated_at"]),
    ("user_identities", ["id", "user_id", "tenant_id", "provider", "provider_id", "secret_ref", "verified_at",
                         "created_at"]),
    ("user_preferences", ["id", "user_id", "kind", "key", "value", "weight", "source", "scope",
                          "conversation_id", "expires_at", "created_at", "updated_at"]),
    ("categories", ["id", "tenant_id", "slug", "name", "name_zh", "parent_id", "kind", "sort_order"]),
    ("merchants", ["id", "tenant_id", "slug", "legal_name", "display_name", "display_name_zh",
                   "description", "category_primary", "status", "ownership_verified", "data_origin",
                   "contact", "socials", "avg_price_hkd", "price_band", "rating_agg", "review_count",
                   "popularity_score", "tags", "attributes", "images", "seo", "ai_agent_enabled",
                   "plan", "created_at", "updated_at"]),
    ("merchant_users", ["id", "merchant_id", "user_id", "role", "status", "created_at"]),
    ("permission_grants", ["id", "subject_type", "subject_id", "merchant_id", "permission",
                           "granted_by", "expires_at", "created_at"]),
    ("locations", ["id", "merchant_id", "tenant_id", "label", "address_line1", "address_line2",
                   "district", "area", "city", "postcode", "lat", "lng", "mtr_station",
                   "mtr_walk_min", "is_primary", "geo_properties", "created_at", "updated_at"]),
    ("business_hours", ["id", "merchant_id", "location_id", "weekday", "opens_at", "closes_at",
                        "crosses_midnight", "source", "updated_at"]),
    ("merchant_categories", ["merchant_id", "category_id"]),
    ("offerings", ["id", "merchant_id", "tenant_id", "kind", "category_id", "slug", "name", "name_zh",
                   "description", "description_zh", "price_amount", "currency", "price_model",
                   "price_min", "price_max", "price_source", "price_updated_at", "stock_quantity",
                   "stock_updated_at", "bookable", "min_party_size", "max_party_size",
                   "duration_minutes", "images", "attributes", "constraints", "options", "status",
                   "popularity_score", "rating_agg", "review_count", "created_at", "updated_at"]),
    ("offering_relations", ["from_offering", "to_offering", "relation", "weight"]),
    ("resource_pools", ["id", "merchant_id", "offering_id", "kind", "name", "capacity", "attributes",
                        "status", "created_at"]),
    ("availability_slots", ["id", "merchant_id", "pool_id", "starts_at", "ends_at", "capacity_total",
                            "capacity_left", "price_amount", "currency", "source", "updated_at"]),
    ("reviews", ["id", "tenant_id", "merchant_id", "offering_id", "user_id", "author_label", "rating",
                 "title", "body", "language", "photos", "verified_purchase", "verified_reservation",
                 "data_origin", "status", "moderation", "helpful_count", "aspects", "created_at",
                 "updated_at"]),
    # A review that is not readable yet and not decided yet is waiting on a named human, so the queue
    # has to contain it. ModerationController opens one case per submission; a dataset that claims to
    # have a queue has to show one (D39).
    ("moderation_cases", ["id", "tenant_id", "subject_type", "subject_id", "reason", "policy",
                          "auto_action", "status", "resolution", "created_at"]),
    ("documents", ["id", "tenant_id", "merchant_id", "offering_id", "kind", "source_uri", "title",
                   "mime_type", "raw_text", "content_hash", "lang", "status", "error", "metadata",
                   "created_at", "updated_at"]),
    ("chunks", ["id", "document_id", "merchant_id", "tenant_id", "ordinal", "text", "token_count",
                "section", "embed_model", "metadata", "created_at"]),
    ("facts", ["id", "subject_type", "subject_id", "merchant_id", "attribute", "value", "unit",
               "currency", "source", "source_uri", "confidence", "observed_at", "expires_at",
               "stale", "created_at"]),
    ("favorites", ["id", "user_id", "subject_type", "subject_id", "note", "created_at"]),
    ("collections", ["id", "tenant_id", "author_id", "kind", "slug", "title", "title_zh",
                     "description", "cover_url", "items", "visibility", "data_origin", "seo",
                     "published_at", "created_at", "updated_at"]),
]
TABLE_ORDER = [t for t, _ in TABLES]
DEMO_TABLES = TABLE_ORDER + ["review_summaries"]   # review_summaries is truncated but never seeded

# V1 tables that point INTO DEMO_TABLES (transitively) but are not seeded here — there is deliberately
# no fake order/event/traffic data (§109/§110). They are why a plain TRUNCATE of merchants/users/
# offerings needs RESEED_DEPENDENTS=1. Every one of them is now counted by quality.sql itself: its
# "no traffic outside the seeded tables" check sweeps the whole foreign-key closure, so a row
# surviving a reset in any of these names the table and its count (D63, D64).
DEPENDENT_TABLES = [
    "reservations", "orders", "order_items", "payments", "refunds", "carts", "cart_items", "coupons",
    "campaigns", "referrals", "subscriptions", "conversations", "messages", "handoffs", "notifications",
    "recommendation_sets", "feedback_events", "trust_signals", "seo_pages",
    "agent_profiles", "api_keys", "external_principals", "deletion_requests",
    "saved_searches",
    # the request-time observability ledger. Left behind, a previous verification run's
    # events/agent_runs survive the reset and quality.sql reads them as fabricated traffic
    # (its traffic sweep counts `events`, and reaches these three only through `tenants`).
    "events", "agent_runs", "llm_calls",
]


# --------------------------------------------------------------------------- truncate emission
def emit_truncate(f, tables: "list[str]", header: "str", hint: "str") -> None:
    """Write one idempotency guard: the tables the generator owns, plus whatever the schema says
    now hangs off them by a foreign key.

    A hand list cannot know about a table a later migration adds. `share_links` (V7) references
    `users`, and Postgres refuses to truncate a parent even when the child is empty, so every
    fresh-database gate died on the line `Table "share_links" references "users"` — a table this
    file had never heard of, holding no rows, blocking a reset that would have destroyed nothing.

    So the list below stays the generator's own claim about what it owns, and the closure around it
    is read from `pg_constraint` at load time. A closure member outside the list is cleared only
    while it is empty — an empty child holds nobody's data — and a non-empty one stops the load by
    name with its row count, because deciding what happens to somebody else's rows is not this
    loader's call to make quietly.
    """
    f.write(header)
    f.write("DO $$\n")
    f.write("declare\n")
    f.write("  listed   text[] := array[" + ", ".join(f"'public.{t}'" for t in tables) + "];\n")
    f.write("  hint     text   := " + "'" + hint.replace("'", "''") + "';\n")
    f.write("  closure  text[];\n")
    f.write("  tbl      text;\n")
    f.write("  rows_now bigint;\n")
    f.write("  blockers text   := '';\n")
    f.write("  targets  text;\n")
    f.write("  claimed  int    := 0;\n")
    f.write("begin\n")
    f.write("  -- Everything the seed owns, plus every table that refers to it, at any depth, read from\n")
    f.write("  -- the catalog rather than from a list that cannot know what the next migration adds.\n")
    f.write("  -- UNION (not UNION ALL) terminates on an FK cycle instead of walking it forever.\n")
    f.write("  WITH RECURSIVE closed(oid) AS (\n")
    f.write("          SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace\n")
    f.write("           WHERE n.nspname || '.' || c.relname = ANY (listed)\n")
    f.write("        UNION\n")
    f.write("          SELECT fk.conrelid FROM pg_constraint fk JOIN closed p ON fk.confrelid = p.oid\n")
    f.write("           WHERE fk.contype = 'f'\n")
    f.write("      )\n")
    f.write("      SELECT array_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname)\n")
    f.write("        INTO closure\n")
    f.write("      FROM closed JOIN pg_class c ON c.oid = closed.oid\n")
    f.write("           JOIN pg_namespace n ON n.oid = c.relnamespace;\n")
    f.write("  IF closure IS NULL THEN\n")
    f.write("    RAISE EXCEPTION 'seed truncate: none of the tables generate.py names exist in schema "
          "public yet'\n")
    f.write("      USING HINT = 'apply infra/db/migrations/V*.sql before loading the seed';\n")
    f.write("  END IF;\n")
    f.write("  FOREACH tbl IN ARRAY closure LOOP\n")
    f.write("    IF tbl = ANY (listed) THEN\n")
    f.write("      claimed := claimed + 1;\n")
    f.write("      CONTINUE;                        -- the generator owns this reset\n")
    f.write("    END IF;\n")
    f.write("    EXECUTE format('SELECT count(*) FROM %s', tbl::regclass) INTO rows_now;\n")
    f.write("    IF rows_now > 0 THEN\n")
    f.write("      blockers := blockers || tbl || ' (' || rows_now || ' row(s) written elsewhere), ';\n")
    f.write("    END IF;\n")
    f.write("  END LOOP;\n")
    f.write("  IF blockers <> '' THEN\n")
    f.write("    RAISE EXCEPTION 'seed truncate refused: a table outside generate.py''s list refers to the "
          "demo data and is not empty: %', rtrim(blockers, ', ')\n")
    f.write("      USING HINT = hint;\n")
    f.write("  END IF;\n")
    f.write("  SELECT string_agg(quote_ident(split_part(t, '.', 1)) || '.' ||\n")
    f.write("                 quote_ident(split_part(t, '.', 2)), ', ' ORDER BY t)\n")
    f.write("    INTO targets FROM unnest(closure) AS u(t);\n")
    f.write("  EXECUTE 'TRUNCATE TABLE ' || targets || ' RESTART IDENTITY';\n")
    f.write("  RAISE NOTICE 'seed truncate: % table(s) cleared -- % named by generate.py, % found by the "
          "schema''s own foreign keys',\n")
    f.write("    array_length(closure, 1), claimed, array_length(closure, 1) - claimed;\n")
    f.write("end\n")
    f.write("$$;\n")


# --------------------------------------------------------------------------- generator
class Gen:
    def __init__(self, args):
        self.a = args
        self.rng = random.Random(args.seed)
        self.now = args.now_dt
        self.merchants: list[dict] = []
        self.offerings: list[dict] = []
        self.reviews: list[dict] = []
        self.facts: list[dict] = []
        self.slots: list[dict] = []
        self.rows: dict[str, list[list[str]]] = {}

    # ---- randomness helpers
    def pick(self, seq):
        return self.rng.choice(seq)

    def weighted_district(self):
        total = sum(d[9] for d in DISTRICTS)
        r = self.rng.random() * total
        for d in DISTRICTS:
            r -= d[9]
            if r <= 0:
                return d
        return DISTRICTS[0]

    def weighted_leaf(self):
        top_weights = [("restaurant", 45), ("cafe", 15), ("bar", 8), ("fitness", 6), ("beauty", 7),
                       ("activity", 5), ("hotel", 4), ("experience", 5), ("shopping", 5), ("service", 6)]
        total = sum(w for _, w in top_weights)
        r = self.rng.random() * total
        top = "restaurant"
        for t, w in top_weights:
            r -= w
            if r <= 0:
                top = t
                break
        leaves = [leaf[0] for node in CAT_TREE if node[0] == top for leaf in node[3]]
        return self.pick(leaves)

    def point_near(self, lat, lng, radius_m):
        r = radius_m * math.sqrt(self.rng.random())
        th = self.rng.random() * 2 * math.pi
        dlat = (r * math.cos(th)) / 111320.0
        dlng = (r * math.sin(th)) / (111320.0 * math.cos(math.radians(lat)))
        return round(lat + dlat, 6), round(lng + dlng, 6)

    def street_address(self, d):
        num = self.rng.randint(1, 188)
        unit = self.rng.randint(1, 32)
        fl = self.pick(["G/F", "1/F", "2/F", "UG/F", "3/F"])
        en_street = f"{self.pick(STREET_EN_HEAD)} {self.pick(STREET_EN_SUF)}"
        zh_street = f"{self.pick(STREET_ZH_HEAD)}{self.pick(STREET_ZH_SUF)}"
        bldg_en, bldg_zh = self.pick(BLDG_EN), self.pick(BLDG_ZH)
        line1 = f"{fl}, Unit {unit}, {num} {en_street} {bldg_en}, {d[1]}"
        line2 = f"{d[2]}{zh_street}{num}號 {bldg_zh}{unit}室"
        return line1, line2

    def bilingual_name(self, idx):
        """Invented zh + en name pair.  Aborts if it collides with a real HK chain (§109)."""
        for _ in range(200):
            zh = self.pick(NAME_ZH_1) + self.pick(NAME_ZH_2)
            en = f"{self.pick(NAME_EN_1)} {self.pick(NAME_EN_2)}"
            hit = check_blocklist(f"{zh} {en}")
            if not hit:
                return zh, en
        raise SystemExit(f"generator: name pools collide with a real HK brand ({hit}) — fix seed_pools.py")

    # ---- phase 1: merchant shells -----------------------------------------
    def plan_merchants(self):
        for i in range(self.a.merchants):
            leaf = self.weighted_leaf()
            top = LEAF_SPEC[leaf]["top"]
            spec = LEAF_SPEC[leaf]
            d = self.weighted_district()
            lang = "zh-HK" if self.rng.random() < 0.6 else ("en" if self.rng.random() < 0.75 else "mixed")
            zh_name, en_name = self.bilingual_name(i)
            if self.rng.random() < 0.4:
                zh_name = zh_name + self.pick(NAME_SUFFIX_ZH[top])
            slug = f"{slugify(en_name)}-{i + 1:04d}"
            lat, lng = self.point_near(d[4], d[5], d[8])
            weak = self.rng.sample(ASPECTS, k=self.rng.randint(1, 2)) if self.rng.random() < 0.28 else []
            aspect_mean = {}
            for a in ASPECTS:
                v = self.rng.gauss(4.15, 0.42)
                if a in weak:
                    v -= self.rng.uniform(1.15, 1.9)
                aspect_mean[a] = max(1.3, min(4.95, v))
            q = self.rng.random()
            base = 2.9 + 2.0 * (q ** 0.75)
            if weak:
                base -= 0.35
            base = max(2.1, min(4.9, base + self.rng.gauss(0, 0.08)))
            m = dict(
                idx=i, leaf=leaf, top=top, spec=spec, district=d, lat=lat, lng=lng, lang=lang,
                zh_name=zh_name, en_name=en_name, slug=slug, weak=weak, aspect_mean=aspect_mean,
                base_rating=base, id=uid("merchant", slug),
                reviews_want=int(self.rng.paretovariate(1.15) * 13) + 3,
                second_loc=self.rng.random() < 0.30,
                verified=self.rng.random() < 0.35,
                agent_enabled=self.rng.random() < 0.42,
                plan=self.rng.choices(["free", "pro", "enterprise"], weights=[70, 28, 2])[0],
                status=self.rng.choices(["published", "pending_review", "draft", "suspended"],
                                        weights=[92, 4, 3, 1])[0],
                mtr_min=self.rng.randint(2, 16) if d[0] != "stanley" else self.rng.randint(12, 25),
                created=self.now - timedelta(days=self.rng.randint(30, 700)),
            )
            # Demo-range landlines (2xxx-0000) and example.hk domains are reserved for synthetic
            # data so a seeded phone/address/e-mail can never resolve to a real business (§109, D6).
            m["phone"] = f"2{m['idx'] % 1000:03d}-0000"
            m["email"] = f"enquiries@{slug}.example.hk"
            m["site"] = f"https://{slug}.example.hk"
            self.merchants.append(m)

    # ---- phase 2: offerings ------------------------------------------------
    def plan_offerings(self):
        est = sum((LEAF_SPEC[m["leaf"]]["items"][0] + LEAF_SPEC[m["leaf"]]["items"][1]) / 2
                  for m in self.merchants)
        factor = max(0.35, min(3.0, self.a.offerings / max(1.0, est)))
        self.offering_factor = factor
        for m in self.merchants:
            spec = m["spec"]
            pool = DISH_POOL.get(m["leaf"], [])
            lo, hi = spec["items"]
            want = max(3, int(round(self.rng.randint(lo, hi) * factor)))
            picks: list[tuple] = []
            if pool:
                picks = list(self.rng.sample(pool, k=min(want, len(pool))))
                # extra lines become size/session variants instead of duplicate rows
                var_zh = ["加大份", "小份", "下午茶版", "二人份", "週末限定", "加強版本"]
                var_en = ["Large", "Small", "Afternoon", "for 2", "Weekend", "Plus"]
                for n in range(max(0, want - len(pool))):
                    zh, en, price, alg, tag = self.rng.choice(pool)
                    i = n % len(var_en)
                    picks.append((f"{zh}（{var_zh[i]}）", f"{en}, {var_en[i]}",
                                  price * (1.35 if i == 0 else 0.75 if i == 1 else 1.1), alg, tag))
            tlo, thi = spec["ticket"]
            band_mult = {1: 0.72, 2: 0.92, 3: 1.15, 4: 1.6}[spec["band"]]
            seen: set[str] = set()
            items = []
            for j, (zh, en, price, alg, tag) in enumerate(picks):
                amt = price * band_mult * self.rng.uniform(0.88, 1.18)
                if tag in ("signature", "premium"):
                    amt *= self.rng.uniform(1.0, 1.12)
                amt = max(tlo * 0.35, min(thi * 3.2, amt))
                amt = float(round(amt / 2) * 2) if amt < 300 else float(round(amt / 10) * 10)
                pm = spec["price_model"]
                if tag == "per_person":
                    pm = "per_person"
                elif tag == "hourly":
                    pm = "hourly"
                elif tag in ("addon", "retail", "snack"):
                    pm = "fixed"
                elif pm == "fixed" and self.rng.random() < 0.10:
                    pm = "from_price"
                base = slugify(en) or f"item-{j + 1}"
                oslug, k = base, 2
                while oslug in seen:
                    oslug = f"{base}-{k}"
                    k += 1
                    if k > 30:
                        oslug = f"{base}-{self.rng.randint(1000, 9999)}"
                        break
                seen.add(oslug)
                allergens = [] if alg == "-" else [a.strip() for a in alg.split(",")]
                o = dict(
                    merchant=m, id=uid("offering", f"{m['slug']}:{oslug}"), slug=oslug, zh=zh, en=en,
                    price=amt, price_model=pm, tag=tag, allergens=allergens,
                    kind={"fitness": "service", "beauty": "service", "service": "service",
                          "activity": "experience", "experience": "experience", "hotel": "service",
                          "shopping": "product"}.get(m["top"], "product"),
                    review_count=0, rating=0.0,
                )
                o["pmin"], o["pmax"] = (amt, round(amt * self.rng.uniform(1.12, 1.45), 2)) if pm == "from_price" else (None, None)
                o["bookable"] = bool(spec["book"]) and o["kind"] in ("service", "experience") and self.rng.random() < 0.6
                o["duration"] = self.rng.choice([30, 45, 60, 60, 90, 120, 180]) if o["bookable"] else None
                o["min_party"] = 1 if o["bookable"] else None
                o["max_party"] = (self.rng.choice([2, 2, 4, 6, 8, 10]) if o["bookable"] else None)
                o["latent_rating"] = max(1.0, min(5.0, self.rng.gauss(m["base_rating"] + 0.1, 0.4)))
                age_h = self.rng.choice([0.4, 1.2, 2.5, 4.0, 7.5, 20.0, 46.0]) if self.rng.random() < 0.35 else self.rng.uniform(0.05, 5.5)
                o["price_updated_at"] = self.now - timedelta(hours=age_h)
                o["price_source"] = self.rng.choices(["merchant", "estimated", "observed"], weights=[85, 10, 5])[0]
                o["status"] = self.rng.choices(["active", "out_of_stock", "draft"], weights=[94, 4, 2])[0]
                o["pop"] = round(min(0.9999, max(0.0001, o["latent_rating"] / 5.0 * self.rng.uniform(0.05, 0.95))), 4)
                items.append(o)
            m["offerings"] = items
            self.offerings.extend(items)
        for m in self.merchants:
            prices = [o["price"] for o in m["offerings"]]
            m["avg_price"] = round(sum(prices) / len(prices), 2) if prices else 0.0
            m["price_band"] = ("$" if m["avg_price"] < 60 else "$$" if m["avg_price"] < 150
                               else "$$$" if m["avg_price"] < 400 else "$$$$")

    # ---- phase 3: reviews --------------------------------------------------
    def review_counts(self):
        demand = [max(2, m["reviews_want"]) for m in self.merchants]
        scale = self.a.reviews / max(1, sum(demand))
        counts = [max(2, int(round(d * scale))) for d in demand]
        diff = self.a.reviews - sum(counts)
        order = sorted(range(len(counts)), key=lambda i: -counts[i])
        guard = 0
        while diff != 0 and guard < 500000:
            i = order[guard % len(order)]
            if diff > 0:
                counts[i] += 1
                diff -= 1
            elif counts[i] > 2:
                counts[i] -= 1
                diff += 1
            guard += 1
        return counts

    def plan_reviews(self):
        for m, c in zip(self.merchants, self.review_counts()):
            m["review_n"] = c
            for ri in range(c):
                lang = self.rng.choices(["zh-HK", "en", "mixed"], weights=[60, 30, 10])[0]
                lb = "zh-HK" if lang in ("zh-HK", "mixed") else "en"
                rating = max(1.0, min(5.0, round(m["base_rating"] + self.rng.gauss(0, 1.15), 1)))
                scored = [(a, max(1.0, min(5.0, round(self.rng.gauss(m["aspect_mean"][a], 0.6), 1))))
                          for a in ASPECTS]
                top_pos = max(scored, key=lambda t: t[1])
                top_neg = min(scored, key=lambda t: t[1])
                picks = [top_pos]
                if rating < 4.4 or m["weak"]:
                    picks.append(top_neg)
                if self.rng.random() < 0.55:
                    rest = [s for s in scored if s[0] not in {p[0] for p in picks}]
                    picks.append(self.rng.choice(rest))
                if self.rng.random() < 0.18:
                    rest = [s for s in scored if s[0] not in {p[0] for p in picks}]
                    picks.append(self.rng.choice(rest))
                ctx = self.review_ctx(m)
                want_zh = lb == "zh-HK"
                parts, aspects_json = [], {}
                for idx, (a, v) in enumerate(picks):
                    # blend the aspect score toward the star rating so a 2.0 review cannot claim
                    # "taste 5.0" while the body complains about everything else
                    v = round(max(1.0, min(5.0, 0.6 * v + 0.4 * rating)), 1)
                    bucket = "pos" if v >= 4.0 else ("neg" if v <= 2.9 else "mid")
                    pool = script_matched(REVIEW_TEXT[a][bucket], want_zh)
                    s_txt = self.pick(pool).format(**ctx)
                    if lang == "mixed" and idx == len(picks) - 1 and self.rng.random() < 0.7:
                        s_txt = self.pick(script_matched(REVIEW_TEXT[a][bucket], not want_zh)).format(**ctx)
                    parts.append(s_txt)
                    aspects_json[a] = v
                opener = self.pick(REVIEW_OPENER[lb]).format(**ctx)
                verdict_pool = VERDICT[("pos_" if rating >= 3.8 else "neg_" if rating < 3.0 else "mid_")
                                       + ("zh" if lb == "zh-HK" else "en")]
                closer = self.pick(REVIEW_CLOSER[lb]).format(
                    **{"return": self.pick(verdict_pool), "who": self.pick(WHO[lb])})
                body = opener + " ".join(parts) + " " + closer
                if lang == "mixed":
                    body = f"{self.pick(MIX_CONNECTORS)}，" + body
                body = clean_body(body)
                if len(body) < 24:
                    body = clean_body(body + (" 整體一般，最緊要係乾淨企理。" if lb == "zh-HK"
                                              else " Overall it was average but clean."))
                off = self.pick(m["offerings"]) if m["offerings"] and self.rng.random() < 0.18 else None
                age_d = min(540.0, abs(self.rng.paretovariate(1.35)) * 55)
                created = self.now - timedelta(days=age_d, hours=self.rng.randint(0, 23))
                rid = uid("review", f"{m['slug']}:{ri}")
                self.reviews.append(dict(
                    id=rid, merchant=m, offering=off, rating=rating,
                    body=body, lang=("zh-HK" if lang == "mixed" else lang), mixed=(lang == "mixed"),
                    aspects=aspects_json, title=self.review_title(m, rating, lb, ctx) if self.rng.random() < 0.45 else None,
                    helpful=max(0, int(self.rng.gauss(3.5, 5.5))),
                    created=created, vp=self.rng.random() < 0.22, vr=self.rng.random() < 0.12,
                    # Moderation is decided per review id, not from the shared RNG stream and not at
                    # emission time: the merchant/offering aggregates below are computed from the
                    # published subset only, so a rating_agg that quietly counted flagged reviews
                    # could not be reproduced from what a consumer sees (§19).
                    status=_moderation_status(rid, self.a.seed),
                ))
        # One pass over the reviews, then a lookup per subject: the aggregates below are the same
        # numbers `quality.sql` recomputes in SQL, so they must be derived from exactly the published
        # rows and nothing else (§19).
        pub_m = {}
        pub_o = {}
        for r in self.reviews:
            if r["status"] != "published":
                continue
            pub_m.setdefault(r["merchant"]["id"], []).append(r)
            if r["offering"] is not None:
                pub_o.setdefault(r["offering"]["id"], []).append(r)
        for m in self.merchants:
            rs = pub_m.get(m["id"], [])
            m["rating_agg"] = mean2([r["rating"] for r in rs])
            m["review_count"] = len(rs)
            # The evidence window, not the recompute instant: an aggregate says what it averaged over.
            m["reviewed_through"] = max((r["created"] for r in rs), default=None)
        for o in self.offerings:
            rs = pub_o.get(o["id"], [])
            o["review_count"] = len(rs)
            o["rating"] = mean2([r["rating"] for r in rs])
            o["reviewed_through"] = max((r["created"] for r in rs), default=None)

    def review_ctx(self, m):
        d = m["district"]
        offs = m["offerings"] or [dict(zh="招牌菜", en="signature dish", price=m["avg_price"] or 88)]
        a = self.pick(offs)
        b = self.pick(offs)
        return dict(dish=a["zh"], dish2=b["zh"], dish_en=a["en"], district_zh=d[2], mtr=d[6],
                    mtr_zh=d[7], exit=self.pick(["A", "B", "C", "D"]), mtr_min=m["mtr_min"],
                    wait=(self.rng.randint(35, 75) if m["aspect_mean"]["waiting_time"] < 3
                          else self.rng.randint(5, 25)),
                    ticket=max(20, int(round(m["avg_price"]))), price=max(20, int(round(a["price"]))),
                    dow=self.pick(DOW_ZH), dow_en=self.pick(DOW_EN), n=self.rng.randint(2, 9),
                    party=self.pick(PARTY["zh-HK"]), party_en=self.pick(PARTY["en"]),
                    occasion=self.pick(OCCASION["zh-HK"]), occasion_en=self.pick(OCCASION["en"]),
                    hh=self.pick(["7", "8", "12", "6"]))

    def review_title(self, m, rating, lb, ctx):
        if lb == "zh-HK":
            good = [f"{ctx['district_zh']}性價比之選", "會再嚟", "老實好食", "安静聚會位", "等位要計時間",
                    "街坊小館", "近港鐵方便"]
            bad = ["未符期望", "等太耐", "太吵", "份量偏細", "價錢貴咗"]
            return self.pick(good if rating >= 3.8 else (bad if rating < 3.0 else ["普通一餐", "見仁見智"]))
        good = ["Solid neighbourhood pick", "Worth the walk", "Quiet and well run", "Great value"]
        bad = ["Overrated", "Long wait", "Too loud to eat", "Small portions"]
        return self.pick(good if rating >= 3.8 else (bad if rating < 3.0 else ["Just okay"]))

    # ---- phase 4: locations / hours / pools / slots ------------------------
    def plan_places(self):
        for m in self.merchants:
            d = m["district"]
            l1, l2 = self.street_address(d)
            m["locs"] = [dict(id=uid("location", f"{m['slug']}:1"), label=None, line1=l1, line2=l2,
                              district=d[1], district_zh=d[2], area=d[3], lat=m["lat"], lng=m["lng"],
                              mtr=d[6], mtr_min=m["mtr_min"], primary=True)]
            if m["second_loc"]:
                nd = DIST_BY_SLUG[self.pick(ADJACENT[d[0]])]
                la, ln = self.point_near(nd[4], nd[5], nd[8])
                a1, a2 = self.street_address(nd)
                m["locs"].append(dict(id=uid("location", f"{m['slug']}:2"),
                                      label=self.pick(["分店", "Branch", "二期", "新店面"]),
                                      line1=a1, line2=a2, district=nd[1], district_zh=nd[2],
                                      area=nd[3], lat=la, lng=ln, mtr=nd[6],
                                      mtr_min=self.rng.randint(3, 18), primary=False))
            m["closed_day"] = self.rng.choice([0, 1, 2, 6]) if self.rng.random() < 0.22 else None
            m["hours"] = []
            for wd in range(7):
                if wd == m["closed_day"]:
                    continue
                for (oh, om, ch, cm) in HOURS_PROFILES[m["spec"]["hours"]]:
                    oh2, om2 = add_min(oh, om, self.rng.choice([0, 0, 0, 30]))
                    ch2, cm2 = add_min(ch, cm, self.rng.choice([0, 0, -30, 30]))
                    m["hours"].append(dict(loc=m["locs"][0], weekday=wd,
                                           opens=f"{oh2 % 24:02d}:{om2:02d}",
                                           closes=f"{ch2 % 24:02d}:{cm2:02d}",
                                           crosses=ch2 >= 24))
            # a second location keeps reduced hours so per-location hours are exercised
            for loc in m["locs"][1:]:
                for h in [x for x in m["hours"] if x["weekday"] in (1, 3, 5)]:
                    m["hours"].append(dict(loc=loc, weekday=h["weekday"], opens=h["opens"],
                                           closes=h["closes"], crosses=h["crosses"]))
            self.plan_pools(m)

    def plan_pools(self, m):
        spec = m["spec"]
        m["pools"], m["slots"] = [], []
        if not spec["book"] or not spec["pool"]:
            return
        kind, clo, chi = spec["pool"]
        # A pool is merchant-level unless exactly one bookable offering can claim it: binding it to
        # the single service makes per-offering capacity meaningful without inventing a many-to-one
        # mapping the schema cannot express.
        bookable = [o for o in m["offerings"] if o["bookable"] and o["status"] == "active"]
        only = bookable[0]["id"] if len(bookable) == 1 else None
        n_pools = 1 if kind in ("table", "seat", "lane") else self.rng.randint(1, 2)
        for pi in range(n_pools):
            cap = self.rng.randint(clo, chi)
            pool = dict(id=uid("pool", f"{m['slug']}:{pi}"), kind=kind, cap=cap, offering_id=only,
                        name=(f"{kind.replace('_', ' ').title()} {'A' if pi == 0 else 'B'}"
                              f" — demo pool"))
            m["pools"].append(pool)
        sessions = spec["slots"]
        for day in range(self.a.days):
            dt = (self.now + timedelta(days=day)).date()
            wd = dt.weekday()
            if wd == m["closed_day"]:
                continue
            weekend = wd >= 4
            for label, times in sessions:
                chosen = [t for t in times if self.rng.random() < (0.85 if weekend else 0.7)]
                chosen = chosen[: self.a.max_slots]
                for t in chosen:
                    pool = self.pick(m["pools"])
                    oh, om = (int(x) for x in t.split(":"))
                    dur = {"table": 90, "seat": 60, "chair": 60, "treatment_room": 60,
                           "class_slot": 60, "lane": 90, "room": 1200, "station": 60}[pool["kind"]]
                    start = datetime(dt.year, dt.month, dt.day, oh % 24, om, tzinfo=HK)
                    end = start + timedelta(minutes=dur)
                    total = max(1, pool["cap"] - self.rng.randint(0, 2))
                    used_ratio = 1.0 - (0.55 + 0.45 * self.rng.random()) if weekend else (0.15 + 0.6 * self.rng.random())
                    left = max(0, int(round(total * (1 - used_ratio))))
                    price = None
                    if pool["kind"] in ("room", "class_slot", "lane", "treatment_room", "chair", "station"):
                        price = m["avg_price"] or None
                    m["slots"].append(dict(
                        id=uid("slot", f"{m['slug']}:{day}:{label}:{t}"), pool=pool, starts=start,
                        ends=end, total=total, left=left, price=price, session=label))

    # ---- phase 5: documents + chunks --------------------------------------
    def plan_documents(self):
        for m in self.merchants:
            m["docs"] = []
            for doc in (self.menu_doc(m), self.policy_doc(m)):
                doc["chunks"] = chunk_sections(doc["text"])
                for i, ch in enumerate(doc["chunks"]):
                    ch["id"] = uid("chunk", f"{doc['id']}:{i}")
                m["docs"].append(doc)

    def menu_doc(self, m):
        d = m["district"]
        lines = [f"== 資料聲明 / Data statement ==",
                 DISCLAIMER_UNI + " — " + "".join(DEMO_STATEMENT_DOC)]
        lines += ["", f"== 關於 / About {m['en_name']} {m['zh_name']} =="]
        lines.append(self.description(m))
        lines += ["", "== 場次與營業時間 / Sessions =="]
        lines.append("（以下時間為示範資料）" + self.hours_summary(m))
        sigs = [o for o in m["offerings"] if o["tag"] in ("signature", "premium")] or m["offerings"][:3]
        lines += ["", "== 招牌推薦 / Signatures =="]
        for o in sigs[:4]:
            lines.append(f"· {o['zh']} / {o['en']} — HK${m2(o['price'])}"
                         + (f"（致敏: {o['allergens'][0]}…）" if o["allergens"] else ""))
        lines += ["", f"== 全日菜單 / Full menu ({len(m['offerings'])} 項，港幣) =="]
        for o in m["offerings"]:
            al = ", ".join(o["allergens"]) if o["allergens"] else "無列明致敏物"
            pm = {"fixed": "", "from_price": " 起", "per_person": " 每位", "hourly": " 每小時",
                  "range": ""}[o["price_model"]]
            lines.append(f"{o['zh']} | {o['en']} | HK${m2(o['price'])}{pm} | 致敏 Allergens: {al}")
        veg = [o for o in m["offerings"] if "veg" == o["tag"] or "soy" in o["allergens"]]
        lines += ["", "== 素食與致敏 / Vegetarian & allergens =="]
        lines.append(f"素食/vegan 選項 {len(veg)} 項；" + self.pick(ALLERGEN_NOTES))
        lines.append("廚房於繁忙時段共用炸油，敏感人士請自行評估。" if m["top"] == "restaurant"
                     else "服務過程會使用含香精產品，過敏體質請事先告知。")
        lines += ["", "== 交通 / Getting here =="]
        lines.append(f"港鐵{d[7]}站步行約 {m['mtr_min']} 分鐘（{d[1]} MTR, ~{m['mtr_min']} min walk）。"
                     f"地址為合成示範地址：{m['locs'][0]['line2'] if m.get('locs') else ''}")
        m["menu_text"] = "\n".join(lines)
        return dict(id=uid("document", f"{m['slug']}:menu"), kind="menu",
                    title=f"{m['en_name']} {m['zh_name']} — DEMO 菜單",
                    uri=f"{DEMO_URI}/menu/{m['slug']}.txt", lang="zh-HK", text=m["menu_text"])

    def policy_doc(self, m):
        d = m["district"]
        lines = ["== 資料聲明 / Data statement ==",
                 DISCLAIMER_UNI + " — 商戶、地址、電話、價格、政策與供求均為虛構。",
                 "", "== 用餐政策 / Policies =="]
        for key, label, zh, en, (lo, hi) in self.rng.sample(POLICY_LINES, k=self.rng.randint(4, 6)):
            n = self.rng.randint(lo, hi) if hi else 0
            lines.append(f"· {label}: {zh.replace('{n}', str(n))} / {en.replace('{n}', str(n))}")
        lines += ["", "== 常見問題 / FAQ =="]
        lines.append("Q: 可以帶外賣食物嗎？ A: 不設外帶食物，敬請見諒。")
        lines.append("Q: 有没有小朋友椅子？ A: 有BB椅，需於預約時說明。")
        lines.append("Q: Can the AI assistant book for me? A: It can submit the request; a staff member confirms.")
        lines.append("Q: 價格會變嗎？ A: 節日套餐可能臨時調整，結帳前以實時報價為準。")
        lines += ["", f"== 聯絡 / Contact =="]
        lines.append(f"電話(示範) {m['phone']} · 電郵 {m['email']} · 網站 {m['site']}")
        lines.append(f"服務範圍以{d[1]}（{d[2]}）為主，分店見地圖標記（合成資料）。")
        return dict(id=uid("document", f"{m['slug']}:policy"), kind="policy",
                    title=f"{m['en_name']} — DEMO 政策/Policy",
                    uri=f"{DEMO_URI}/policy/{m['slug']}.txt", lang="zh-HK", text="\n".join(lines))

    def hours_summary(self, m):
        by_day: dict[int, list[str]] = {}
        for h in m["hours"]:
            by_day.setdefault(h["weekday"], []).append(f"{h['opens']}-{h['closes']}")
        out = []
        for wd in range(7):
            if wd in by_day:
                out.append(f"{'一二三四五六日'[wd]}: {' / '.join(sorted(by_day[wd]))}")
            else:
                out.append(f"{'一二三四五六日'[wd]}: 休息 closed")
        return "；".join(out)

    def description(self, m):
        d = m["district"]
        top_zh = TOP_NAMES[m["top"]][1]
        leaf_zh, leaf_en = LEAF_CUISINE_ZH[m["leaf"]], LEAF_CUISINE_EN[m["leaf"]]
        n = len(m["offerings"])
        tmpl = [
            f"喺{d[2]}開咗多年嘅{leaf_zh}小店，主打自家製餸式，午市套餐人均 HK${int(m['avg_price'])}，"
            f"適合{self.pick(['情侶約會', '家庭聚餐', '同事收工', '一個人食飯'])}。",
            f"A neighbourhood {leaf_en.lower()} spot in {d[1]} doing {n} things properly — "
            f"average spend about HK${int(m['avg_price'])}, busiest on weekend evenings.",
            f"{m['zh_name']}係{d[2]}區內{top_zh}類目嘅{leaf_zh}專門店，提供{m['price_band']}價位，"
            f"由{d[7]}站步行約{m['mtr_min']}分鐘。",
            f"Small {leaf_en} room in {d[1]}, {m['price_band']} band, ~{m['mtr_min']} min from {d[6]} station; "
            f"weekday afternoons are the quietest time to come.",
        ]
        return self.pick(tmpl) + "（示範資料，並非真實商戶。）"

    # ---- phase 6: facts ----------------------------------------------------
    def plan_facts(self):
        for m in self.merchants:
            self.facts.append(self.fact("merchant", m["id"], m, "opening_hours",
                                        {"zones": [{"weekday": h["weekday"], "opens": h["opens"],
                                                   "closes": h["closes"]} for h in m["hours"]],
                                         "closed_weekday": m["closed_day"], "data_origin": "demo"},
                                        "minutes", None, "demo", ttl_h=24,
                                        uri=f"{DEMO_URI}/hours/{m['slug']}"))
            self.facts.append(self.fact("merchant", m["id"], m, "price",
                                        {"amount": m2(m["avg_price"]), "currency": "HKD",
                                         "model": "per_person", "band": m["price_band"],
                                         "data_origin": "demo"},
                                        None, "HKD", "merchant", ttl_h=6,
                                        uri=f"{DEMO_URI}/avg-price/{m['slug']}"))
            self.facts.append(self.fact("merchant", m["id"], m, "cuisine",
                                        {"primary": m["leaf"], "zh": LEAF_CUISINE_ZH[m["leaf"]],
                                         "data_origin": "demo"}, None, None, "merchant", ttl_h=24 * 30,
                                        uri=f"{DEMO_URI}/cuisine/{m['slug']}"))
            # §19: the card renders 「4.3 · 128 則評價」, so the number needs its own fact row. The
            # value repeats what the aggregate column holds — same arithmetic, same rounding — and
            # adds the two things the column cannot say: how many reviews it rests on, and how far
            # back the evidence runs.
            if m["review_count"]:
                self.facts.append(self.fact("merchant", m["id"], m, "rating",
                                            {"value": m["rating_agg"], "count": m["review_count"],
                                             "max_score": 5, "method": "mean_of_published_reviews",
                                             "reviewed_through": ts(m["reviewed_through"]),
                                             "data_origin": "demo"},
                                            None, None, "observed", ttl_h=TTL_HOURS["rating"],
                                            uri=f"{DEMO_URI}/rating/{m['slug']}",
                                            confidence=rating_confidence(m["review_count"])))
            for loc in m["locs"]:
                self.facts.append(self.fact("location", loc["id"], m, "address",
                                            {"line1": loc["line1"], "line2": loc["line2"],
                                             "district": loc["district"], "lat": loc["lat"],
                                             "lng": loc["lng"], "synthetic": True},
                                            None, None, "merchant", ttl_h=24 * 30,
                                            uri=f"{DEMO_URI}/address/{loc['id']}"))
            top_offs = sorted(m["offerings"], key=lambda o: -o["pop"])[:3]
            for o in top_offs:
                obs = o["price_updated_at"]
                exp = obs + timedelta(hours=TTL_HOURS["price"])
                self.facts.append(self.fact("offering", o["id"], m, "price",
                                            {"amount": m2(o["price"]), "currency": "HKD",
                                             "model": o["price_model"],
                                             "min": (m2(o["pmin"]) if o["pmin"] else None),
                                             "max": (m2(o["pmax"]) if o["pmax"] else None),
                                             "estimated": o["price_source"] == "estimated",
                                             "data_origin": "demo"},
                                            None, "HKD",
                                            PRICE_SOURCE_TO_FACT.get(o["price_source"], o["price_source"]),
                                            ttl_h=6,
                                            uri=f"{DEMO_URI}/price/{o['slug']}", observed=obs,
                                            expires=exp))
            # The offering profile renders a rating too, and reads it off the same rule the merchant
            # card does — so every reviewed offering carries one, not just the three the profile shows
            # prices for.
            for o in m["offerings"]:
                if o["review_count"]:
                    self.facts.append(self.fact("offering", o["id"], m, "rating",
                                                {"value": o["rating"], "count": o["review_count"],
                                                 "max_score": 5,
                                                 "method": "mean_of_published_reviews",
                                                 "reviewed_through": ts(o["reviewed_through"]),
                                                 "data_origin": "demo"},
                                                None, None, "observed", ttl_h=TTL_HOURS["rating"],
                                                uri=f"{DEMO_URI}/rating/{o['slug']}",
                                                confidence=rating_confidence(o["review_count"])))
            if m["top"] in ("fitness", "beauty", "experience", "activity", "hotel"):
                for o in m["offerings"][:2]:
                    if o["duration"]:
                        self.facts.append(self.fact("offering", o["id"], m, "capacity",
                                                    {"duration_minutes": o["duration"],
                                                     "max_party_size": o["max_party"],
                                                     "data_origin": "demo"}, "minutes", None,
                                                    "merchant", ttl_h=24,
                                                    uri=f"{DEMO_URI}/capacity/{o['slug']}"))

    def fact(self, subject_type, subject_id, m, attribute, value, unit, currency, source, ttl_h,
             uri, observed=None, expires=None, confidence=None):
        obs = observed or self.now
        exp = expires or (obs + timedelta(hours=ttl_h) if ttl_h else None)
        stale = bool(exp and exp < self.now and self.rng.random() < 0.35)
        rolled = self.rng.choice([1.0, 0.98, 0.95, 0.9, 0.8])
        return dict(subject_type=subject_type, subject_id=subject_id, merchant=m, attribute=attribute,
                    value=value, unit=unit, currency=currency, source=source, uri=uri,
                    confidence=rolled if confidence is None else confidence, observed=obs,
                    expires=exp, stale=stale,
                    id=uid("fact", f"{subject_type}:{subject_id}:{attribute}"))

    # ---- phase 7: emission -------------------------------------------------
    def emit(self):
        self.rows["tenants"] = [row([
            TENANT_ID, "hong-kong", "Hong Kong", "HK", None, "Asia/Hong_Kong", "HKD",
            Arr(["en", "zh-HK", "zh-CN"]), "active",
            {"demo": True, "data_origin": "demo", "currency_default": "HKD",
             "locales": ["en", "zh-HK", "zh-CN"], "seed_build": DISCLAIMER},
            self.now - timedelta(days=800), self.now])]

        users = [
            (U_CONSUMER, "demo.consumer@example.hk", "2000-0000", "陳小姐 (Demo)", "zh-HK", "consumer",
             "消費者"),
            (U_OWNERS[0], "demo.owner1@example.hk", "2001-0000", "Lee Man Ho (Demo Merchant)", "zh-HK",
             "consumer", "東主"),
            (U_OWNERS[1], "demo.owner2@example.hk", "2002-0000", "Ho Ka Yan (Demo Merchant)", "zh-HK",
             "consumer", "東主"),
            (U_OWNERS[2], "demo.owner3@example.hk", "2003-0000", "Chan Wai Ling (Demo Merchant)", "zh-HK",
             "consumer", "東主"),
            (U_ADMIN, "demo.admin@example.hk", "2009-0000", "NEXUS Demo Admin", "en", "platform_admin",
             "平台管理員"),
        ]
        self.rows["users"] = []
        for i, (uid_, email, phone, name, locale, role, _t) in enumerate(users):
            self.rows["users"].append(row([
                uid_, TENANT_ID, email, phone, PASSWORD_HASH_PLACEHOLDER, name,
                f"/demo/img/avatar-{i + 1}.svg", locale, role, "active", i == 0,
                self.now - timedelta(hours=i + 1), self.now - timedelta(days=200 - i), self.now]))
        # tenant_id is not optional since V4: the COPY failed on a NOT NULL the first fresh seed after it.
        self.rows["user_identities"] = [row([
            uid("identity", u), u, TENANT_ID, "password", f"demo:{slug}", f"demo-secret-store/{slug}",
            self.now - timedelta(days=100), self.now - timedelta(days=100)])
            for u, slug in [(U_CONSUMER, "consumer"), (U_OWNERS[0], "merchant1"),
                            (U_OWNERS[1], "merchant2"), (U_OWNERS[2], "merchant3"),
                            (U_ADMIN, "admin")]]

        prefs = [
            ("food", "cuisine_like", {"values": ["cantonese", "sushi", "specialty-coffee"]}, 0.9, "declared"),
            ("food", "cuisine_dislike", {"values": ["spicy"]}, 0.8, "declared"),
            ("budget", "per_person_max_hkd", {"value": 300, "currency": "HKD"}, 0.95, "declared"),
            ("location", "home_district", {"value": "Sha Tin", "lat": 22.3831, "lng": 114.1876}, 1.0, "declared"),
            ("style", "ambience", {"value": "quiet"}, 0.6, "inferred"),
            ("language", "response_locale", {"value": "zh-HK"}, 1.0, "declared"),
            ("accessibility", "step_free", {"value": True}, 0.4, "declared"),
        ]
        self.rows["user_preferences"] = [row([
            uid("pref", k), U_CONSUMER, kind, k, val, w, src, "long_term", None,
            self.now + timedelta(days=90), self.now - timedelta(days=20), self.now - timedelta(days=3)])
            for kind, k, val, w, src in prefs]

        self.rows["categories"] = []
        self.category_ids: dict[str, str] = {}
        order = 0
        for top_slug, top_en, top_zh, leaves in CAT_TREE:
            pid = uid("category", top_slug)
            self.category_ids[top_slug] = pid
            order += 1
            self.rows["categories"].append(row([
                pid, None, top_slug, top_en, top_zh, None, "merchant", order * 10]))
            for j, (ls, len_, lzh) in enumerate(leaves):
                cid = uid("category", ls)
                self.category_ids[ls] = cid
                self.rows["categories"].append(row([
                    cid, None, ls, len_, lzh, pid, "merchant", (order * 100) + j]))

        self.rows["merchants"] = []
        owners = self.pick_owner_merchants()
        owner_ids = {m["id"]: u for u, m in owners}
        for m in self.merchants:
            d = m["district"]
            phone, email, site = m["phone"], m["email"], m["site"]
            tags = [m["leaf"], m["top"], f"{d[0]}", "demo"]
            if m["mtr_min"] <= 5:
                tags.append("mtr-5min")
            if self.rng.random() < 0.4:
                tags.append(self.pick(["family-run", "late-night", "quiet-hours", "weekend-brunch",
                                       "set-lunch", "e-wallet", "card-no"]))
            attrs = {
                "data_origin": "demo",
                "quiet_ambience": m["aspect_mean"]["noise"] >= 4.2,
                "kid_friendly": self.rng.random() < 0.45,
                "mtr_within_5min": m["mtr_min"] <= 5,
                "outdoor_seating": self.rng.random() < 0.2,
                "has_private_room": self.rng.random() < 0.3,
                "wheelchair_access": self.rng.random() < 0.55,
                "opens_late": any(h["crosses"] or int(h["closes"][:2]) >= 22 for h in m["hours"]),
                "closed_weekday": m["closed_day"],
                "demo_login_role": ("merchant" if m["id"] in owner_ids else None),
                "weak_aspects": m["weak"],
            }
            # category label only: `MerchantCards.subtitleOf` appends the district itself, and the
            # web console prints this column raw, so a "Ramen · Sha Tin" value rendered twice.
            primary = LEAF_CUISINE_EN[m["leaf"]]
            display = m["zh_name"] if m["lang"] != "en" else m["en_name"]
            if m["lang"] == "mixed":
                display = f"{m['en_name']} {m['zh_name']}"
            self.rows["merchants"].append(row([
                m["id"], TENANT_ID, m["slug"], f"{m['en_name']} Demo Co., Limited",
                display, m["zh_name"], self.description(m), primary, m["status"], m["verified"], "demo",
                {"phone": phone, "email": email, "whatsapp": phone, "site": site, "data_origin": "demo"},
                {"instagram": None, "facebook": f"https://facebook.example.hk/{m['slug']}",
                 "openrice": None},
                m["avg_price"], m["price_band"], m["rating_agg"], m["review_count"],
                round(min(0.9999, m["base_rating"] / 5.0 * (0.4 + 0.6 * m["review_count"] / 120)), 4),
                Arr(tags), attrs,
                [{"url": f"/demo/img/{m['top']}.svg", "alt": DISCLAIMER,
                  "credit": "synthetic placeholder"}],
                {"title": f"{display} | {primary} | NEXUS demo",
                 "description": f"SYNTHETIC demo listing — {self.description(m)}",
                 "lang": "zh-HK", "canonical": f"/hong-kong/{m['slug']}", "noindex": True,
                 "data_origin": "demo"},
                m["agent_enabled"], m["plan"], m["created"], self.now]))

        owners = self.pick_owner_merchants()
        self.rows["merchant_users"] = []
        self.rows["permission_grants"] = []
        for user_id, m in owners:
            mu = uid("merchant_user", f"{m['slug']}:{user_id}")
            m["owner_user"], m["owner_mu"] = user_id, mu
            self.rows["merchant_users"].append(row([
                mu, m["id"], user_id, "owner", "active", m["created"]]))
            # `subject_id` is the *user*, not the membership row. PermissionService joins
            # `users u on u.id = g.subject_id`, so a merchant_users id here loads fine (the column has
            # no FK) and then silently 403s every workspace route — which is exactly what the seeded
            # demo console did: three owners, fifteen grants, zero reachable permissions.
            #
            # The set itself is the role's preset, not a hand-picked subset (D5, D40). This used to
            # write five permissions — one grant plus four that lapsed after 90 days — and omitted
            # seven of the preset's twelve, among them `admin_members`, `configure_ai` and
            # `publish_listing`. So the demo's only merchant humans could read a dashboard and could
            # not open any of §5's nine workspace routes, publish a listing of their own, or answer the
            # "who is in this business" screen the console renders for an owner. A role label the data
            # does not carry is the same fiction as a review count no row backs. Human grants carry no
            # `expires_at`: a role assignment is not a TTL.
            for perm in OWNER_PERMISSIONS:
                self.rows["permission_grants"].append(row([
                    uid("grant", f"owner:{mu}:{perm}"), "merchant_user", user_id, m["id"], perm,
                    user_id, None, m["created"]]))

        self.rows["locations"] = []
        self.rows["business_hours"] = []
        for m in self.merchants:
            d = m["district"]
            for loc in m["locs"]:
                self.rows["locations"].append(row([
                    loc["id"], m["id"], TENANT_ID, loc["label"], loc["line1"], loc["line2"],
                    loc["district"], loc["area"], "Hong Kong", "999999", loc["lat"], loc["lng"],
                    loc["mtr"], loc["mtr_min"], loc["primary"],
                    {"synthetic": True, "data_origin": "demo", "rng_seed": self.a.seed,
                     "district_zh": loc["district_zh"], "mtr_walk_minutes": loc["mtr_min"]},
                    m["created"], self.now]))
            for h in m["hours"]:
                self.rows["business_hours"].append(row([
                    uid("hours", f"{h['loc']['id']}:{h['weekday']}:{h['opens']}"), m["id"],
                    h["loc"]["id"], h["weekday"], h["opens"], h["closes"], h["crosses"], "demo",
                    self.now]))

        self.rows["merchant_categories"] = []
        for m in self.merchants:
            ids = [self.category_ids[m["leaf"]], self.category_ids[m["top"]]]
            extra = self.rng.choice([l[0] for node in CAT_TREE if node[0] == m["top"] for l in node[3]])
            ids.append(self.category_ids[extra])
            for cid in dict.fromkeys(ids):
                self.rows["merchant_categories"].append(row([m["id"], cid]))

        self.rows["offerings"] = []
        for o in self.offerings:
            m = o["merchant"]
            zh_desc, en_desc = self.offering_desc(o)
            allergens = o["allergens"]
            attrs = {"cuisine": m["leaf"], "district": m["district"][1], "data_origin": "demo",
                     "demo": True, "tag": o["tag"]}
            if allergens:
                attrs["allergens"] = allergens
            if "veg" == o["tag"]:
                attrs["vegetarian"] = True
            if self.rng.random() < 0.25:
                attrs["spicy_level"] = self.rng.randint(0, 3)
            if o["kind"] == "service":
                attrs["unit"] = m["spec"]["unit"] or "session"
            options = []
            if o["tag"] in ("classic", "signature") and m["top"] in ("restaurant", "cafe"):
                options = [{"name": "size", "values": [{"label": "細", "delta": -20},
                                                       {"label": "大", "delta": 30}]},
                           {"name": "add_on", "values": [{"label": "加飯", "delta": 10},
                                                         {"label": "凍檸茶", "delta": 18}]}]
            elif m["top"] in ("beauty", "fitness", "experience"):
                options = [{"name": "time", "values": [{"label": "60分鐘", "delta": 0},
                                                       {"label": "90分鐘", "delta": 180}]}]
            constraints = {}
            if self.rng.random() < 0.12:
                constraints["no_pork"] = True
            if self.rng.random() < 0.10:
                constraints["min_party_size"] = 2
            if o["tag"] == "premium":
                constraints["advance_days"] = self.rng.randint(1, 7)
            self.rows["offerings"].append(row([
                o["id"], m["id"], TENANT_ID, o["kind"], self.category_ids[m["leaf"]], o["slug"],
                o["en"], o["zh"], en_desc, zh_desc, o["price"], "HKD", o["price_model"],
                o["pmin"], o["pmax"], o["price_source"], o["price_updated_at"],
                (self.rng.randint(0, 40) if m["top"] == "shopping" or o["tag"] == "retail" else None),
                (self.now if m["top"] == "shopping" else None),
                o["bookable"], o["min_party"], o["max_party"], o["duration"],
                [{"url": f"/demo/img/{m['top']}.svg", "alt": DISCLAIMER, "credit": "synthetic"}],
                attrs, constraints, options, o["status"], o["pop"], o["rating"], o["review_count"],
                m["created"], self.now]))

        self.rows["offering_relations"] = []
        for m in self.merchants:
            offs = m["offerings"]
            if len(offs) < 4:
                continue
            sigs = [o for o in offs if o["tag"] in ("signature", "premium")] or offs[:1]
            drinks = [o for o in offs if o["tag"] in ("drink", "dessert", "addon", "snack")]
            for s in sigs[:2]:
                for dd in self.rng.sample(drinks, k=min(2, len(drinks))) if drinks else []:
                    self.rows["offering_relations"].append(row([
                        s["id"], dd["id"], self.rng.choices(["related_to", "upsell", "bundle"],
                                                            weights=[6, 3, 1])[0],
                        round(self.rng.uniform(0.4, 0.95), 3)]))

        self.rows["resource_pools"] = []
        self.rows["availability_slots"] = []
        for m in self.merchants:
            for p in m["pools"]:
                self.rows["resource_pools"].append(row([
                    p["id"], m["id"], p["offering_id"], p["kind"], p["name"], p["cap"],
                    {"data_origin": "demo", "demo": True, "sessions_per_day": len(m["slots"])},
                    "active", m["created"]]))
                for s in m["slots"]:
                    if s["pool"] is not p:
                        continue
                    self.rows["availability_slots"].append(row([
                        s["id"], m["id"], p["id"], s["starts"], s["ends"], s["total"], s["left"],
                        s["price"], "HKD", "demo", self.now]))

        self.rows["reviews"] = []
        for r in self.reviews:
            m = r["merchant"]
            self.rows["reviews"].append(row([
                r["id"], TENANT_ID, m["id"], (r["offering"]["id"] if r["offering"] else None),
                (U_CONSUMER if self.rng.random() < 0.02 else None),
                self.author_label(m, r), r["rating"], r["title"], r["body"], r["lang"],
                [], r["vp"], r["vr"], "demo", r["status"],
                {"data_origin": "demo", "script_mix": (r["mixed"] and "zh-en") or None,
                 "synthetic": True},
                r["helpful"], r["aspects"], r["created"], r["created"]]))

        self.rows["documents"] = []
        self.rows["chunks"] = []
        for m in self.merchants:
            for doc in m["docs"]:
                self.rows["documents"].append(row([
                    doc["id"], TENANT_ID, m["id"], None, doc["kind"], doc["uri"], doc["title"],
                    "text/plain; charset=utf-8", doc["text"], sha256_of(doc["text"]), doc["lang"],
                    "indexed", None,
                    {"data_origin": "demo", "synthetic": True, "merchant_slug": m["slug"],
                     "chunk_count": len(doc["chunks"]),
                     "sections": [c["section"] for c in doc["chunks"]], "disclaimer": DISCLAIMER},
                    m["created"], self.now]))
                for i, ch in enumerate(doc["chunks"]):
                    self.rows["chunks"].append(row([
                        ch["id"], doc["id"], m["id"], TENANT_ID, i, ch["text"],
                        approx_tokens(ch["text"]), ch["section"], "pending",
                        {"data_origin": "demo", "embedding": None,
                         "sections": ch.get("sections") or [ch["section"]],
                         "overlap_ratio": 0.12,
                         "note": "embedding left NULL; the AI service fills vector(1024)"},
                        self.now]))

        # Every non-terminal seeded review is somebody's pending decision, and the queue is where that
        # is recorded: `pending` awaits a first publication, `flagged` was auto-caught and awaits a look.
        # A case for a review consumers can already read would be the lie in the other direction, so
        # these two statuses are the only ones that get one.
        self.rows["moderation_cases"] = []
        for r in self.reviews:
            if r["status"] not in ("pending", "flagged"):
                continue
            flagged = r["status"] == "flagged"
            self.rows["moderation_cases"].append(row([
                uid("moderation_case", r["id"]), TENANT_ID, "review", r["id"],
                ("review flagged for a human look" if flagged
                 else "user_submitted review awaiting first publication"),
                ("\u00a755: content that reads as hostile or off-topic is not shown until a person "
                 "agrees" if flagged
                 else "\u00a755/\u00a7127: user-generated content is shown only after a human decision"),
                "flag" if flagged else "none", "open",
                {"decision": "", "note": "seeded queue entry; no decision recorded yet"},
                r["created"]]))

        self.rows["facts"] = []
        for f in self.facts:
            self.rows["facts"].append(row([
                f["id"], f["subject_type"], f["subject_id"], f["merchant"]["id"], f["attribute"],
                f["value"], f["unit"], f["currency"], f["source"], f["uri"], f["confidence"],
                f["observed"], f["expires"], f["stale"], f["observed"]]))

        guides = self.build_collections()
        self.rows["favorites"] = []
        fav_merchants = self.rng.sample([m for m in self.merchants if m["status"] == "published"], k=12)
        for i, m in enumerate(fav_merchants):
            self.rows["favorites"].append(row([
                uid("favorite", f"consumer:{m['id']}"), U_CONSUMER, "merchant", m["id"],
                self.pick([None, "上次話想再嚟", "date night candidate", "約人呢度"]),
                self.now - timedelta(days=self.rng.randint(1, 90))]))
        for o in self.rng.sample(self.offerings, k=4):
            self.rows["favorites"].append(row([
                uid("favorite", f"consumer:{o['id']}"), U_CONSUMER, "offering", o["id"],
                "想試", self.now - timedelta(days=self.rng.randint(1, 40))]))
        for g in guides[:2]:
            # the subject_type is the row's own kind, not a constant: a favourite saved as `collection`
            # against a guide row is one the door refuses to re-create (assertSubjectInTenant pins the
            # kind), so the seed has to say what it actually points at.
            self.rows["favorites"].append(row([
                uid("favorite", f"consumer:{g['id']}"), U_CONSUMER, g["kind"], g["id"], None,
                self.now - timedelta(days=5)]))
        return self.rows

    def offering_desc(self, o):
        m = o["merchant"]
        zh = self.pick([
            f"{o['zh']}，{m['zh_name']}每日少量供應，以{self.pick(['即叫即做', '人手擺賣', '當日鮮製'])}為原則。",
            f"店內人氣{self.pick(['小食', '主菜', '套餐', '課程'])}之一，適合{self.pick(['二人分享', '一人食', '四人以上'])}。",
            f"以{self.pick(['傳統方法', '低鹽版本', '區內食材'])}處理；如需要走辛可於落單時註明。",
        ]) + "（示範資料）"
        en = self.pick([
            f"{o['en']} — made to order; allow 15-20 minutes at peak.",
            f"One of the room's regulars; pairs well with something lighter.",
            f"Priced per {m['spec']['unit'] or 'person'}; changes are reflected within the day.",
        ]) + " (synthetic demo data)"
        return zh, en

    def author_label(self, m, r):
        if r["lang"] == "en":
            return self.pick(["Alex T.", "Demo User", "M. Wong", "Sam K.", "A traveller",
                              "Verified demo account"])
        return self.pick(["陳先生", "小李", "沙田居民", "匿名用户", "阿May", "親子客", "收工一族",
                          "屯門街坊", "由 demo 帳號"])

    def pick_owner_merchants(self):
        pool = [m for m in self.merchants if m["status"] == "published" and m["district"][0] == "sha-tin"]
        if len(pool) < 3:
            pool = [m for m in self.merchants if m["status"] == "published"]
        pool = sorted(pool, key=lambda m: -m["review_count"])[:40]
        chosen = [pool[0], pool[min(7, len(pool) - 1)], pool[min(19, len(pool) - 1)]]
        return list(zip(U_OWNERS, chosen))

    def build_collections(self):
        st = [m for m in self.merchants if m["status"] == "published" and m["district"][0] == "sha-tin"]
        tw = [m for m in self.merchants if m["status"] == "published" and m["district"][0] == "tai-wai"]
        quiet = [m for m in self.merchants if m["aspect_mean"]["noise"] >= 4.3 and m["status"] == "published"]
        cheap = [m for m in self.merchants if 0 < m["avg_price"] < 70 and m["status"] == "published"]
        datey = [m for m in quiet if m["top"] in ("restaurant", "bar", "cafe")]
        defs = [
            ("sha-tin-date-night", "guide", "沙田情侶約會路線", "A Sha Tin Date Night",
             "由{d2}分鐘步程內嘅安靜餐廳、甜品同酒吧組合而成的示範路線。全部商戶均為虛構。",
             st[:8] + quiet[:2]),
            ("quiet-meals-near-me", "collection", "安靜嘅用餐位", "Quiet Tables Near Me",
             "低噪音評分優先嘅示範清單，適合要傾嘢嘅場合；數據為合成資料。",
             (quiet or st)[:10]),
            ("tai-wai-under-100", "collection", "大圍百蚊以下", "Tai Wai Under HK$100",
             "大圍區人均低價位示範之選（合成商戶，並非真實店舖）。", (cheap or tw)[:9]),
            ("weekend-family-sha-tin", "itinerary", "沙田親子週末路線", "A Family Weekend in Sha Tin",
             "早午餐—活動—下午茶—晚飯嘅示範一日行程，含供求時段示範。", (st[:5] + tw[:4])),
        ]
        guides = []
        self.rows["collections"] = []
        for slug, kind, title_zh, title, desc, members in defs:
            cid = uid("collection", slug)
            items = [{"subject_type": "merchant", "subject_id": m["id"],
                      "note": f"{m['district'][1]} · {m['price_band']}"} for m in members]
            guides.append(dict(id=cid, slug=slug, kind=kind))
            self.rows["collections"].append(row([
                cid, TENANT_ID, U_CONSUMER, kind, slug, title, title_zh,
                desc + " " + DISCLAIMER, f"/demo/img/{('restaurant' if kind != 'itinerary' else 'experience')}.svg",
                items, "public", "demo",
                {"title": f"{title_zh} — NEXUS demo guide", "noindex": True, "data_origin": "demo"},
                self.now - timedelta(days=self.rng.randint(3, 60)),
                self.now - timedelta(days=30), self.now]))
        return guides

    # ---- main driver
    def run(self):
        self.plan_merchants()
        self.plan_offerings()
        self.plan_reviews()
        self.plan_places()
        self.plan_documents()
        self.plan_facts()
        self.emit()
        return self.rows


LINE_SPLITTERS = " 、,，。;；:：|/（）()"


def _wrap_line(ln: str, limit: int) -> list[str]:
    """Hard-wrap one line so no line costs more than `limit` tokens. Menu/policy text is line-based,
    so an unwrappable long paragraph would otherwise be un-cuttable by the line-boundary splitter and
    would force a short chunk mid-document."""
    if approx_tokens(ln) <= limit:
        return [ln]
    out, rest = [], ln
    while rest:
        lo, hi = 0, len(rest)
        while lo < hi:                              # largest prefix that still fits
            mid = (lo + hi + 1) // 2
            if approx_tokens(rest[:mid]) <= limit:
                lo = mid
            else:
                hi = mid - 1
        cut = lo or 1
        for sep in LINE_SPLITTERS:                  # prefer breaking on a separator
            j = rest.rfind(sep, 0, cut)
            if j > cut * 0.5:
                cut = j + 1
                break
        out.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    return [o for o in out if o]


def _split_lines_at(text: str, tokens: int):
    """Cut a block of lines into (head, tail) where head costs <= tokens. Returns ("", text) only if
    a single line cannot fit — the caller avoids that by wrapping lines first (see _wrap_line).
    The cost is measured on the joined string, not as a sum of per-line costs: joining re-inserts
    separators, so summing under-counts and the chunk would overshoot max_tokens."""
    lines = text.split("\n")
    keep = []
    for ln in lines:
        if keep and approx_tokens("\n".join(keep + [ln])) > tokens:
            return "\n".join(keep), "\n".join(lines[len(keep):])
        if not keep and approx_tokens(ln) > tokens:
            return ln[:max(1, len(ln) // 2)], ln[max(1, len(ln) // 2):]
        keep.append(ln)
    return text, ""


def _tail_lines(text: str, tokens: int) -> str:
    """Last ~tokens worth of lines — the 12% overlap window §7 asks a chunker to repeat."""
    lines = text.split("\n")
    keep, acc = [], 0
    for ln in reversed(lines):
        t = approx_tokens(ln)
        if keep and acc + t > tokens:
            break
        keep.insert(0, ln)
        acc += t
    return "\n".join(keep)


def heads_in(text: str, src: dict) -> list[str]:
    """The section heads actually present in `text`. After a re-split the packed `sections` list no
    longer matches the body, and the AI service filters citations on this metadata (§19)."""
    found = [h.strip() for h in re.findall(r"^\[(.+?)\]$", text, flags=re.M) if h.strip()]
    return found or list(src.get("sections") or [src["section"]])


def chunk_sections(text: str, min_tokens=240, max_tokens=400, overlap=0.12, hard_floor=200):
    """Section-aware chunker per AGENT_CONTRACT §7: 240-400 tokens, ~12% overlap.

    `text` uses `== Section / 標題 ==` markers (see menu_doc/policy_doc). Packing works on a queue
    of (head, body) items so that a chunk never exceeds max_tokens: an item that does not fit the
    open chunk is split on a line boundary, the remainder is requeued with the previous tail
    repeated as overlap. Small sections are therefore packed together (one chunk can carry two
    heads; `sections` in the row metadata records them all).

    Packing aims at min_tokens; the balance pass below accepts anything at or above `hard_floor`,
    which is the smallest split two neighbouring chunks can both reach when their combined text just
    exceeds one window. self_check() asserts `hard_floor` for every interior chunk of a split
    document, so a fragment that retrieval could never rank fails the gate.
    """
    parts = re.split(r"^== (.+?) ==$", text, flags=re.M)
    raw: list[list[str]] = []
    line_limit = max(20, int(max_tokens * 0.4))     # a line must always fit the smallest fill window
    def norm(body: str) -> str:
        return "\n".join(w for ln in body.split("\n") for w in _wrap_line(ln, line_limit))
    if parts[0].strip():
        raw.append(["preamble", norm(parts[0].strip())])
    for i in range(1, len(parts), 2):
        head = parts[i].strip()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        if body:
            raw.append([head, norm(body)])

    # pre-split: no queue item may be wider than a chunk, or packing cannot honour the 240-400 window
    queue: list[list[str]] = []
    for head, body in raw:
        head_txt = f"[{head}]"
        if approx_tokens(f"{head_txt}\n{body}") <= max_tokens:
            queue.append([head, body])
            continue
        cur: list[str] = []
        for ln in body.split("\n"):
            if cur and approx_tokens("\n".join([head_txt] + cur + [ln])) > max_tokens:
                queue.append([head, "\n".join(cur)])
                keep = _tail_lines("\n".join(cur), int(max_tokens * overlap))
                cur = (keep.split("\n") if keep else []) + [ln]
            else:
                cur.append(ln)
        if cur:
            queue.append([head, "\n".join(cur)])

    out: list[dict] = []
    cur_head, cur_sections, cur_lines, cur_tokens = None, [], [], 0

    def flush():
        nonlocal cur_head, cur_sections, cur_lines, cur_tokens
        if cur_lines:
            out.append(dict(section=cur_head, sections=list(cur_sections),
                            text="\n".join(cur_lines)))
        cur_head, cur_sections, cur_lines, cur_tokens = None, [], [], 0

    while queue:
        head, body = queue.pop(0)
        block = f"[{head}]\n{body}"
        if cur_lines and approx_tokens("\n".join(cur_lines + [block])) > max_tokens:
            room = max_tokens - cur_tokens - 2                 # -2 for the separator the join adds
            if cur_tokens < min_tokens and room > int(max_tokens * (overlap + 0.05)):
                # short open chunk: cut this block on a line boundary and requeue the remainder with
                # the §7 overlap tail repeated at its head (tail budget reserved so it still fits)
                fill, rest = _split_lines_at(block, room - int(max_tokens * overlap))
                if fill and rest:
                    cur_lines.append(fill)
                    cur_tokens = approx_tokens("\n".join(cur_lines))
                    tail = _tail_lines(fill, int(max_tokens * overlap))
                    queue.insert(0, [head, f"{tail}\n{rest}" if tail else rest])
                    # Keep the chunk open: a line-boundary cut undershoots its budget, so closing
                    # here is what produced a pile of 200-239 token chunks just under the §7 floor.
                    # The requeued remainder carries the overlap tail and fits the reserved room.
                    continue
                if not rest:
                    cur_lines, cur_tokens = [block], approx_tokens(block)   # rounding: it fits whole
                    cur_head, cur_sections = head, [head]
                    continue
            flush()                                             # chunk is full enough (>= min_tokens)
        if cur_head is None:
            cur_head = head
        if head not in cur_sections:
            cur_sections.append(head)
        cur_lines.append(block)
        cur_tokens = approx_tokens("\n".join(cur_lines))
    flush()

    # Balance: an *interior* chunk under hard_floor is a chunker artefact — retrieval has to rank it
    # against chunks that carry whole sections — so it is re-joined with its neighbour and cut again.
    # Cut budgets are searched upward because a single CJK line can be 100+ tokens: the first budget
    # that leaves both halves inside [hard_floor, max_tokens] wins, and a pair with no such cut is
    # skipped rather than abandoning the rest of the document. A document's own tail is not rebalanced
    # here; it is as short as the shortest authored section, and the tail pass below handles it.
    skip: set[int] = set()
    for _ in range(2 * len(out) + 8):
        short = next((i for i, ch in enumerate(out[:-1])
                      if i not in skip and approx_tokens(ch["text"]) < hard_floor), None)
        if short is None or len(out) < 2:
            break
        j = short + 1 if short + 1 < len(out) else short - 1
        a, b = (short, j) if short < j else (j, short)
        prev, nxt = out[a], out[b]
        combined = prev["text"] + "\n" + nxt["text"]
        total = approx_tokens(combined)
        if total <= max_tokens:
            out[a] = dict(section=prev["section"], sections=prev["sections"] + nxt["sections"],
                          text=combined)
            out.pop(b)
            skip.clear()
            continue
        overlap_n = int(max_tokens * overlap)
        best = None
        # budgets run up to the largest legal head, not to `total - hard_floor`: one CJK line can
        # overshoot a tight budget, and the legality check below rejects what does not work.
        hi = min(max_tokens - overlap_n - 2, total - 2)
        for budget in range(hard_floor, hi + 1, 20):
            head_txt, tail_txt = _split_lines_at(combined, budget)
            if not head_txt or not tail_txt:
                continue
            overlap_txt = _tail_lines(head_txt, overlap_n)
            head_n = approx_tokens(head_txt)
            tail_n = approx_tokens(tail_txt) + approx_tokens(overlap_txt) + 1
            if not (hard_floor <= head_n <= max_tokens and hard_floor <= tail_n <= max_tokens):
                continue
            if best is None or abs(head_n - tail_n) < best[0]:
                best = (abs(head_n - tail_n), head_txt, tail_txt, overlap_txt)
        if best is None:
            skip.add(short)
            continue
        _, head_txt, tail_txt, overlap_txt = best
        b_text = (overlap_txt + "\n" if overlap_txt else "") + tail_txt
        head_secs, tail_secs = heads_in(head_txt, prev), heads_in(b_text, nxt)
        out[a] = dict(section=head_secs[0], sections=head_secs, text=head_txt)
        out[b] = dict(section=tail_secs[0], sections=tail_secs, text=b_text)

    # A tail below the window still belongs to its document: fold it into the previous chunk when the
    # pair fits one window, otherwise leave the shortest authored section on its own — self_check()
    # draws that line at 40 tokens, the size of the smallest contact block in the seed scripts.
    while len(out) > 1 and approx_tokens(out[-1]["text"]) < hard_floor:
        prev, last = out[-2], out[-1]
        combined = prev["text"] + "\n" + last["text"]
        if approx_tokens(combined) > max_tokens:
            break
        out[-2] = dict(section=prev["section"], sections=prev["sections"] + last["sections"],
                       text=combined)
        out.pop()
    for ch in out:
        if "sections" not in ch:
            ch["sections"] = [ch["section"]]
    return out


# --------------------------------------------------------------------------- writers
def write_outputs(gen: Gen, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    # `out/` is derived state (gitignored), so clear the previous run's scripts before writing. Without
    # this, a filename change leaves both spellings on disk and load.sh's `out/[0-9][0-9]_*.sql` glob
    # COPYs the same table twice — which is a duplicate-key failure that names a random table, not the
    # stale file. (The `.sql` suffix below is exactly such a change: see D33.)
    for stale in list(out_dir.glob("*.sql")) + list(out_dir.glob("*.csv")):
        stale.unlink()
    written = []
    for i, (table, cols) in enumerate(TABLES, start=1):
        rows = gen.rows.get(table, [])
        prefix = f"{i:02d}_{table}"
        csv_path = out_dir / f"{prefix}.csv"
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            f.write(f"# {DISCLAIMER} — synthetic NEXUS demo rows for public.{table}; "
                    f"NULL is written as \\N\n")
            w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
            w.writerow(cols)
            for r in rows:
                w.writerow(r)
        sql_path = out_dir / f"{prefix}.sql"
        with sql_path.open("w", encoding="utf-8", newline="") as f:
            f.write(f"-- {DISCLAIMER}\n")
            if table == "tenants":
                # The tenant row is shared with infra/db/seed/00_tenant.sql (same stable UUID) and is
                # referenced by ~24 tables, so we must NOT truncate/re-copy it: raw COPY would fail with
                # a duplicate-key error on any DB where 00_tenant.sql already ran. Stage + upsert instead.
                f.write(f"-- upserts public.{table} ({len(rows)} row(s)) — idempotent, first writer wins\n")
                cols_sql = ", ".join(cols)
                f.write("CREATE TEMP TABLE _seed_tenants (LIKE public.tenants INCLUDING DEFAULTS) "
                        "ON COMMIT DROP;\n")
                f.write(f"COPY _seed_tenants ({cols_sql}) FROM STDIN "
                        f"WITH (FORMAT csv, HEADER false, NULL '\\N', ENCODING 'UTF8');\n")
                w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
                for r in rows:
                    w.writerow(r)
                f.write("\\.\n")
                f.write(f"INSERT INTO public.tenants ({cols_sql}) SELECT {cols_sql} FROM _seed_tenants "
                        "ON CONFLICT (id) DO NOTHING;\n")
            else:
                f.write(f"-- loads public.{table} ({len(rows)} rows) — synthetic, never real HK business data\n")
                f.write(f"COPY public.{table} ({', '.join(cols)}) FROM STDIN "
                        f"WITH (FORMAT csv, HEADER false, NULL '\\N', ENCODING 'UTF8');\n")
                w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
                for r in rows:
                    w.writerow(r)
                f.write("\\.\n")
        written.append((prefix, table, len(rows)))

    # 00_truncate.sql: reset only the tables this generator owns, in FK-safe order, identity included.
    # `tenants` is deliberately absent (shared row, see above). review_summaries is truncated but never
    # seeded: summaries are AI-generated later, so a stale summary must not survive a reseed.
    with (out_dir / "00_truncate.sql").open("w", encoding="utf-8", newline="") as f:
        emit_truncate(
            f,
            [t for t in DEMO_TABLES if t != "tenants"],
            header=(f"-- {DISCLAIMER}\n"
                    "-- Idempotency guard for load.sh: empties the demo tables listed in generate.py\n"
                    "-- (DEMO_TABLES minus the shared tenants row) so a reseed never duplicates rows,\n"
                    "-- plus any table the live schema hangs off them by a foreign key *while it holds\n"
                    "-- no rows* — see emit_truncate(). A non-empty one stops the load with its name and\n"
                    "-- its count rather than being emptied behind somebody's back; that is the case this\n"
                    f"-- file has always refused, and {len(DEPENDENT_TABLES)} of the tables it refuses are\n"
                    "-- spelled out in out/optional/00_truncate_dependents.sql.\n"),
            hint=("Re-run data/seed/load.sh with RESEED_DEPENDENTS=1 to reset the tables that hold "
                  "demo-tenant rows, or empty the named table yourself first."),
        )

    # Companion reset for a DB that already holds rows referencing the demo rows. Explicit list, and
    # still never CASCADE: an operator reading this file sees exactly which transactional tables the
    # seed claims. The closure adds only empty strangers — a new migration's table with rows in it is
    # refused by name, because this list is already the widest one load.sh offers.
    # Lives in out/optional/ so `out/*.sql` (the default load set) never picks it up by accident.
    opt_dir = out_dir / "optional"
    opt_dir.mkdir(exist_ok=True)
    with (opt_dir / "00_truncate_dependents.sql").open("w", encoding="utf-8", newline="") as f:
        emit_truncate(
            f,
            [t for t in [x for x in DEMO_TABLES if x != "tenants"] + DEPENDENT_TABLES],
            header=(f"-- {DISCLAIMER}\n"
                    "-- Optional wider reset (load.sh RESEED_DEPENDENTS=1). Demo tables above + the V1\n"
                    "-- tables that reference them. Explicit instead of TRUNCATE ... CASCADE so the blast\n"
                    "-- radius is reviewable; these rows are all demo-tenant rows, but they are NOT seeded\n"
                    "-- by this generator, so anything the platform wrote here is lost. That is why it is\n"
                    "-- opt-in. A table a later migration adds is cleared only while it is empty; with rows\n"
                    "-- in it this script refuses and names it, and the fix is DEPENDENT_TABLES in\n"
                    "-- generate.py if the seed owns its reset, not a wider cascade.\n"),
            hint=("This is the widest list load.sh offers: add the named table to DEPENDENT_TABLES in "
                  "data/seed/generate.py if the seed owns its reset, or empty it by hand."),
        )
    written.insert(0, ("00_truncate", "(truncate)", 0))
    return written


# --------------------------------------------------------------------------- self-check (no DB needed)
def self_check(gen: Gen, out_dir: Path, args) -> int:
    """Parse the emitted CSVs back and assert FK integrity + product rules. Returns exit code."""
    tables: dict[str, tuple[list[str], list[dict[str, str]]]] = {}
    for path in sorted(out_dir.glob("*.csv")):
        table = path.name.split("_", 1)[1][:-4]
        with path.open(encoding="utf-8", newline="") as f:
            first = f.readline()
            assert DISCLAIMER in first, f"{path.name}: missing disclaimer header line"
            rdr = csv.reader(f)
            cols = next(rdr)
            rows = [dict(zip(cols, r)) for r in rdr]
        tables[table] = (cols, rows)

    errs: list[str] = []
    fk = {"users.tenant_id": "tenants.id", "merchants.tenant_id": "tenants.id",
          "merchant_users.merchant_id": "merchants.id", "merchant_users.user_id": "users.id",
          "locations.merchant_id": "merchants.id", "locations.tenant_id": "tenants.id",
          "business_hours.merchant_id": "merchants.id", "business_hours.location_id": "locations.id",
          "merchant_categories.merchant_id": "merchants.id",
          "merchant_categories.category_id": "categories.id",
          "offerings.merchant_id": "merchants.id", "offerings.category_id": "categories.id",
          "offerings.tenant_id": "tenants.id",
          "offering_relations.from_offering": "offerings.id",
          "offering_relations.to_offering": "offerings.id",
          "resource_pools.merchant_id": "merchants.id",
          "availability_slots.merchant_id": "merchants.id",
          "availability_slots.pool_id": "resource_pools.id",
          "reviews.merchant_id": "merchants.id", "reviews.offering_id": "offerings.id",
          "reviews.user_id": "users.id", "reviews.tenant_id": "tenants.id",
          "documents.merchant_id": "merchants.id", "documents.tenant_id": "tenants.id",
          "chunks.document_id": "documents.id", "chunks.merchant_id": "merchants.id",
          "facts.merchant_id": "merchants.id", "moderation_cases.tenant_id": "tenants.id", "user_preferences.user_id": "users.id",
          "user_identities.user_id": "users.id", "user_identities.tenant_id": "tenants.id", "favorites.user_id": "users.id",
          "collections.tenant_id": "tenants.id", "collections.author_id": "users.id",
          "categories.parent_id": "categories.id",
          "permission_grants.merchant_id": "merchants.id"}

    def keyset(ref: str):
        t, col = ref.split(".")
        if t not in tables:
            return None
        return {r[col] for r in tables[t][1]}

    for ref, target in fk.items():
        t, col = ref.split(".")
        if t not in tables:
            continue
        ks = keyset(target)
        if ks is None:
            errs.append(f"{ref}: referenced table {target} missing")
            continue
        bad = [r for r in tables[t][1] if r[col] not in ("", NULL) and r[col] not in ks]
        if bad:
            errs.append(f"{ref}: {len(bad)} orphan FK values, e.g. {bad[0][col]}")

    if len({r["id"] for r in tables["merchants"][1]}) != len(tables["merchants"][1]):
        errs.append("merchants: duplicate ids")
    if len({(r["tenant_id"], r["slug"]) for r in tables["merchants"][1]}) != len(tables["merchants"][1]):
        errs.append("merchants: duplicate (tenant_id, slug)")
    if len({(r["merchant_id"], r["slug"]) for r in tables["offerings"][1]}) != len(tables["offerings"][1]):
        errs.append("offerings: duplicate (merchant_id, slug)")

    loc_by_merchant = {}
    for r in tables["locations"][1]:
        loc_by_merchant.setdefault(r["merchant_id"], []).append(r)
    for m in tables["merchants"][1]:
        if not loc_by_merchant.get(m["id"]):
            errs.append(f"merchant {m['slug']} has no location")
    for r in tables["business_hours"][1]:
        if r["weekday"] not in [str(i) for i in range(7)]:
            errs.append(f"business_hours: bad weekday {r['weekday']}")
    for r in tables["reviews"][1]:
        rt = float(r["rating"])
        if not (1 <= rt <= 5):
            errs.append(f"review {r['id']}: rating {rt} out of 1..5")
        if len(r["body"]) <= 20:
            errs.append(f"review {r['id']}: body length {len(r['body'])} <= 20")
        if r["data_origin"] != "demo":
            errs.append(f"review {r['id']}: data_origin not demo")
    for r in tables["offerings"][1]:
        if r["price_amount"] not in (NULL, ""):
            pv = float(r["price_amount"])
            if not (0 < pv < 20000):
                errs.append(f"offering {r['slug']}: price {pv} out of 0..20000")
    for r in tables["merchants"][1]:
        for bad in REAL_HK_BLOCKLIST:
            if bad and (bad in r["display_name"] or bad in (r["display_name_zh"] or "")
                        or bad in r["slug"]):
                errs.append(f"merchant name collides with real HK chain: {r['slug']} ~ {bad}")
        if r["data_origin"] != "demo":
            errs.append(f"merchant {r['slug']}: data_origin not demo")
    # Stored aggregates must agree with the *published* reviews they summarise (§19): the merchant
    # and offering rows are what search and cards render, and an average that quietly counts pending
    # or flagged reviews cannot be reproduced from the data a consumer sees. Compared as the emitted
    # two-decimal strings, because that is the exact form the database stores and the card prints —
    # a tolerance here once hid seventeen ratings that SQL would have recomputed a cent higher.
    pub_by_merchant: dict[str, list[float]] = {}
    pub_by_offering: dict[str, list[float]] = {}
    for r in tables["reviews"][1]:
        if r["status"] != "published":
            continue
        pub_by_merchant.setdefault(r["merchant_id"], []).append(float(r["rating"]))
        if r["offering_id"] not in ("", NULL):
            pub_by_offering.setdefault(r["offering_id"], []).append(float(r["rating"]))
    rating_facts: dict[tuple[str, str], list[dict]] = {}
    for r in tables["facts"][1]:
        if r["attribute"] == "rating":
            rating_facts.setdefault((r["subject_type"], r["subject_id"]), []).append(r)
    # Fact-table invariants the schema cannot express: `facts` is free text/jsonb with no CHECKs, so
    # these have to be asserted somewhere or they drift silently. A source outside §2's vocabulary is
    # the dangerous one — `FactSource` lives in packages/types and AGENT_CONTRACT §4 ranks those exact
    # strings, so an undeclared value resolves below every real claim yet outranks them alphabetically.
    seen_triples: set[tuple[str, str, str]] = set()
    for r in tables["facts"][1]:
        triple = (r["subject_type"], r["subject_id"], r["attribute"])
        if triple in seen_triples:
            errs.append(f"facts: a second row for {triple} — the reader would have to guess which is true")
        seen_triples.add(triple)
        if r["source"] not in FACT_SOURCES:
            errs.append(f"facts {triple}: source {r['source']!r} is not a documented provenance")
        conf = float(r["confidence"])
        if not (0.0 <= conf <= 1.0):
            errs.append(f"facts {triple}: confidence {conf} outside 0..1 (numeric(4,3) allows it)")
        if r["expires_at"] != NULL and r["expires_at"] <= r["observed_at"]:
            errs.append(f"facts {triple}: expires_at {r['expires_at']} is not after observed_at")
        if r["stale"] == "true" and r["expires_at"] != NULL and r["expires_at"] > ts(gen.now):
            errs.append(f"facts {triple}: marked stale while still inside its TTL")
    for kind, table, rows in (("merchant", "merchants", tables["merchants"][1]),
                              ("offering", "offerings", tables["offerings"][1])):
        for r in rows:
            vals = (pub_by_merchant if kind == "merchant" else pub_by_offering).get(r["id"], [])
            want = mean2(vals)
            stored = r["rating_agg"] if r["rating_agg"] not in (NULL, "") else m2(0.0)
            if stored != m2(want) or int(r["review_count"]) != len(vals):
                errs.append(f"{kind} {r['slug']}: rating_agg/review_count {r['rating_agg']}/"
                            f"{r['review_count']} != published {m2(want)}/{len(vals)}")
            # ...and the fact behind the number agrees with both of them: same value, same count, one
            # row per reviewed subject, and a subject that points back at this exact row.
            found = rating_facts.get((kind, r["id"]), [])
            if len(vals) == 0:
                if found:
                    errs.append(f"{kind} {r['slug']}: rating fact with no published review behind it")
                continue
            if len(found) != 1:
                errs.append(f"{kind} {r['slug']}: {len(found)} rating fact(s) for {len(vals)} reviews")
                continue
            f = found[0]
            fv = json.loads(f["value"])
            if m2(fv["value"]) != stored or int(fv["count"]) != len(vals):
                errs.append(f"{kind} {r['slug']}: rating fact {fv['value']}/{fv['count']} != column "
                            f"{stored}/{len(vals)}")
            if kind == "merchant" and f["merchant_id"] != r["id"]:
                errs.append(f"merchant {r['slug']}: rating fact anchored on {f['merchant_id']}")
            if f["source"] != "observed" or not f["source_uri"].startswith("demo://"):
                errs.append(f"{kind} {r['slug']}: rating fact source {f['source']}/{f['source_uri']}")
            if float(f["confidence"]) != rating_confidence(len(vals)):
                errs.append(f"{kind} {r['slug']}: rating fact confidence {f['confidence']} for n="
                            f"{len(vals)}, expected {rating_confidence(len(vals))}")
    for r in tables["documents"][1]:
        if DISCLAIMER_UNI not in r["raw_text"]:
            errs.append(f"document {r['title']}: missing disclaimer inside text")
    doc_chunks = {}
    for r in tables["chunks"][1]:
        doc_chunks.setdefault(r["document_id"], []).append(r)
        if r["embed_model"] != "pending":
            errs.append(f"chunk {r['id']}: embed_model should be pending")
        if not r["text"].strip():
            errs.append(f"chunk {r['id']}: empty text")
    # AGENT_CONTRACT §7 asks for 240-400 token semantic chunks. Three claims, checked separately:
    #   * ceiling 400 — always, an embedding input cannot be allowed to overflow;
    #   * floor 200 for every *interior* chunk of a split document — those are the chunker's own
    #     closing decisions, so a short one is a chunker artefact (the balance pass removes them);
    #   * floor 40 for a document's last chunk: that is the shortest authored section in the corpus
    #     (a five-line policy contact block), and a real ingest pipeline gets arbitrary documents.
    # The 240-400 share is reported for the interior chunks, where it is a real shape target.
    total_chunks = single_chunk_docs = 0
    interior = interior_window = 0
    for doc_id, chs in sorted(doc_chunks.items()):
        chs.sort(key=lambda c: int(c["ordinal"]))
        single_chunk_docs += 1 if len(chs) == 1 else 0
        for pos, ch in enumerate(chs):
            n = int(ch["token_count"])
            total_chunks += 1
            is_last = pos == len(chs) - 1
            floor = (20 if len(chs) == 1 else (40 if is_last else 200))
            if not is_last and len(chs) > 1:
                interior += 1
                interior_window += 1 if 240 <= n <= 400 else 0
            if n > 400:
                errs.append(f"chunk {ch['id']}: {n} tokens > 400 (§7 ceiling)")
            elif n < floor:
                errs.append(f"chunk {ch['id']}: {n} tokens < {floor} "
                            f"({pos + 1}/{len(chs)} of its document)")
    if interior and interior_window / interior < 0.85:
        errs.append(f"only {interior_window}/{interior} interior chunks sit in the §7 240-400 "
                    f"window (want >= 85%)")
    mean_chunks = sum(len(v) for v in doc_chunks.values()) / max(1, len(doc_chunks))
    if mean_chunks < 1.5:
        errs.append(f"documents too thin for RAG: {mean_chunks:.2f} chunks/document (want >= 1.5)")

    # cold-start density (spec §94): >=300 merchants within 3 km of the Sha Tin centroid
    def haversine(a, b, c, d):
        r = 6371000.0
        p1, p2 = math.radians(a), math.radians(c)
        dp = math.radians(c - a)
        dl = math.radians(d - b)
        h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * r * math.asin(math.sqrt(h))

    near = 0
    for r in tables["locations"][1]:
        if r["is_primary"] != "true":
            continue
        d = haversine(SHA_TIN_CENTROID[0], SHA_TIN_CENTROID[1], float(r["lat"]), float(r["lng"]))
        if d <= 3000:
            near += 1
    density_min = max(1, int(round(args.merchants * 300 / 520)))
    if near < density_min:
        errs.append(f"cold-start density: only {near} merchants within 3km of Sha Tin (need >= {density_min})")

    langs: dict[str, int] = {}
    for r in tables["reviews"][1]:
        langs[r["language"]] = langs.get(r["language"], 0) + 1
    total = sum(langs.values()) or 1
    zh_share = langs.get("zh-HK", 0) / total
    if not (0.5 <= zh_share <= 0.85):
        errs.append(f"language mix off: zh-HK share {zh_share:.2f}")

    dist_count: dict[str, int] = {}
    for r in tables["locations"][1]:
        if r["is_primary"] == "true":
            dist_count[r["district"]] = dist_count.get(r["district"], 0) + 1

    slots = tables["availability_slots"][1]
    days_used = {r["starts_at"][:10] for r in slots}
    print("\nself-check (no DB required)")
    print(f"  parsed tables         : {len(tables)}")
    print(f"  merchants within 3km  : {near} of Sha Tin centroid (target >= {density_min})")
    print(f"  review language mix   : " + ", ".join(f"{k}={v / total:.0%}" for k, v in sorted(langs.items())))
    print(f"  availability day span : {len(days_used)} days")
    print(f"  chunk shapes          : {total_chunks} chunks / {len(doc_chunks)} docs, "
          f"{single_chunk_docs} single-chunk docs, {interior_window}/{interior} interior chunks "
          f"in the §7 240-400 window")
    print(f"  district spread       : " + ", ".join(f"{k}:{v}" for k, v in sorted(
        dist_count.items(), key=lambda kv: -kv[1])))
    if errs:
        print("  FAILED:")
        for e in errs[:40]:
            print(f"    - {e}")
        return 1
    print("  RESULT                : PASS (FK integrity, bounds, naming, density, language mix)")
    return 0


# --------------------------------------------------------------------------- placeholder images (local, no network)
def write_images(out_dir: Path):
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    palette = {"restaurant": "#B4530F", "cafe": "#6D4C2F", "bar": "#4C1D53", "fitness": "#0F5132",
               "beauty": "#8A2B52", "activity": "#1D4E89", "hotel": "#283747",
               "experience": "#7A5C00", "shopping": "#5B2C2C", "service": "#37474F"}
    for top, colour in palette.items():
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<rect width="640" height="400" fill="{colour}"/>
<text x="32" y="60" fill="#fff" font-family="sans-serif" font-size="26">{DISCLAIMER}</text>
<text x="32" y="215" fill="#fff" font-family="sans-serif" font-size="64" opacity="0.85">{top}</text>
<text x="32" y="260" fill="#fff" font-family="sans-serif" font-size="20" opacity="0.8">NEXUS synthetic demo placeholder - not a real photo</text>
</svg>
'''
        (img_dir / f"{top}.svg").write_text(svg, encoding="utf-8", newline="\n")
    for i, role in enumerate(["consumer", "merchant", "merchant", "merchant", "admin"], start=1):
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<rect width="96" height="96" fill="#7a8a99"/><text x="48" y="60" text-anchor="middle" fill="#fff"
font-family="sans-serif" font-size="34">D{i}</text></svg>
'''
        (img_dir / f"avatar-{i}.svg").write_text(svg, encoding="utf-8", newline="\n")
    (img_dir / "README.md").write_text(
        f"# {DISCLAIMER}\n\nLocal placeholder art referenced by seeded rows as `/demo/img/<name>.svg`.\n"
        "Copy this directory into `apps/web/public/demo/img/`. No real photography is hotlinked.\n",
        encoding="utf-8", newline="\n")


# --------------------------------------------------------------------------- main
def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Generate NEXUS synthetic demo seed data (stdlib only)")
    ap.add_argument("--counts", choices=["full", "ci", "smoke"], default=None,
                    help="preset scale (full is the default; ci/smoke are small deterministic sets)")
    ap.add_argument("--merchants", type=int, default=520)
    ap.add_argument("--offerings", type=int, default=5600, help="target offering rows")
    ap.add_argument("--reviews", type=int, default=11000, help="target review rows")
    ap.add_argument("--days", type=int, default=21, help="availability horizon in days")
    ap.add_argument("--max-slots", type=int, default=6, help="max slot times per session per day")
    ap.add_argument("--seed", type=int, default=20260921)
    ap.add_argument("--base-date", default=None,
                    help="ISO date used as 'now' (default: pinned BASE_NOW for reproducibility)")
    ap.add_argument("--now", action="store_true", help="use the real current time as 'now'")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--no-images", action="store_true")
    ap.add_argument("--skip-selfcheck", action="store_true")
    args = ap.parse_args(argv)
    if args.counts == "ci":
        args.merchants, args.offerings, args.reviews, args.days = 120, 900, 1500, 3
    elif args.counts == "smoke":
        args.merchants, args.offerings, args.reviews, args.days = 30, 200, 300, 2
    base = "2026-09-22T11:00:00+08:00"
    if args.now:
        now = datetime.now(HK)
    elif args.base_date:
        now = datetime.fromisoformat(args.base_date)
    else:
        now = datetime.fromisoformat(base)
    args.now_dt = now
    return ap, args


def main(argv=None) -> int:
    ap, args = parse_args(argv)
    if args.merchants < 20:
        print("error: --merchants must be >= 20 to keep district/category coverage", file=sys.stderr)
        return 2
    if args.merchants > 900:
        print("error: --merchants > 900 would reuse demo phone numbers (the 2xxx-0000 range only "
              "holds 900 unique values); widen it in generate.py first", file=sys.stderr)
        return 2
    out_dir = Path(args.out).resolve()
    print(f"{DISCLAIMER}")
    print(f"seed={args.seed}  now={ts(args.now_dt)}  scale: merchants={args.merchants} "
          f"offerings~{args.offerings} reviews={args.reviews} days={args.days}")
    gen = Gen(args)
    gen.run()
    written = write_outputs(gen, out_dir)
    if not args.no_images:
        write_images(out_dir)
    total_slots = len(gen.rows["availability_slots"])
    print(f"\nwrote {len(written)} table files into {out_dir}  (offering scale factor "
          f"{getattr(gen, 'offering_factor', 1):.2f}×)")
    for prefix, table, n in written:
        print(f"  {prefix:<28} {n:>7,} rows")
    print(f"  {'availability horizon':<28} {total_slots:>7,} rows / {args.days} days")
    rc = 0
    if not args.skip_selfcheck:
        rc = self_check(gen, out_dir, args)
    if rc == 0:
        print("\nnext: data/seed/load.sh   then: psql -f data/seed/quality.sql")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
