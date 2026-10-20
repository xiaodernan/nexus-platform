"""The offline demo catalogue — clearly-labelled synthetic data (spec §109/§155).

Used by the HTTP layer when no `NEXUS_DATABASE_URL` is configured, so `apps/ai` can
serve the full §7 surface on a laptop or in CI with zero infrastructure. Two honesty
rules keep it distinct from "real" answers:

* every row carries `data_origin="demo"`, which `cards.build_card` turns into
  `flags.demo=true` on the EntityCard — the UI renders a demo badge from it;
* every rendered number (price, rating, hours) ships as a `facts` row with source +
  confidence + timestamp, exactly like live data, so downstream trust code exercises
  the same path. Nothing is invented at request time beyond these fixture rows, and
  `SearchResponse.degraded`/`done.degraded` are set to True in demo mode so a reviewer
  can never mistake the fixture catalogue for live merchants.

Timestamps are generated relative to the call time (`fresh=True`) because the §5 TTL
policy would otherwise mark 2026-seeded prices stale within hours; the relative clock
keeps the demo honest about freshness semantics.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any
from uuid import UUID, uuid5

from nexus_ai.search.service import StaticBackend

NAMESPACE = UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # standard name-based ns


def _id(kind: str, name: str) -> str:
    return str(uuid5(NAMESPACE, f"{kind}:{name}"))


# ------------------------------------------------------------------ merchants
_MERCHANTS: list[dict[str, Any]] = [
    {
        "slug": "demo-silver-mine-restaurant", "display_name": "Silver Mine Restaurant",
        "display_name_zh": "銀礦餐延", "category_primary": "restaurant",
        "description": "Demo cha chaan teng in Sha Tin — baked rice and milk tea (synthetic).",
        "tags": ["demo", "cha-chaan-teng", "family"], "district": "Sha Tin",
        "avg_price_hkd": 90.0, "rating_agg": 4.4, "review_count": 182, "popularity": 0.62,
    },
    {
        "slug": "demo-lan-kwai-fong", "display_name": "Lan Kwai Fong Bistro",
        "display_name_zh": "蘭桂坊小館", "category_primary": "restaurant",
        "description": "Demo central bistro with quiet corners (synthetic).",
        "tags": ["demo", "date", "quiet"], "district": "Central",
        "avg_price_hkd": 320.0, "rating_agg": 4.6, "review_count": 240, "popularity": 0.81,
    },
    {
        "slug": "demo-spice-market", "display_name": "Spice Market Kitchen",
        "display_name_zh": "香料街廚房", "category_primary": "restaurant",
        "description": "Demo Sichuan kitchen in Mong Kok — spicy by default (synthetic).",
        "tags": ["demo", "sichuan", "spicy"], "district": "Mong Kok",
        "avg_price_hkd": 150.0, "rating_agg": 4.2, "review_count": 96, "popularity": 0.55,
    },
    {
        "slug": "demo-harbour-view-dining", "display_name": "Harbour View Dining",
        "display_name_zh": "維港灣景餐延", "category_primary": "restaurant",
        "description": "Demo waterfront dinner spot in Wan Chai (synthetic).",
        "tags": ["demo", "date", "view"], "district": "Wan Chai",
        "avg_price_hkd": 480.0, "rating_agg": 4.7, "review_count": 310, "popularity": 0.9,
    },
    {
        "slug": "demo-bamboo-tea-house", "display_name": "Bamboo Tea House",
        "display_name_zh": "竹苑茶室", "category_primary": "cafe",
        "description": "Demo quiet tea house in Kowloon City (synthetic).",
        "tags": ["demo", "quiet", "afternoon"], "district": "Kowloon City",
        "avg_price_hkd": 60.0, "rating_agg": 4.5, "review_count": 58, "popularity": 0.4,
    },
    {
        "slug": "demo-rainbow-sports-store", "display_name": "Rainbow Sports Store",
        "display_name_zh": "彩虹運動用品", "category_primary": "retail",
        "description": "Demo running-gear retailer in Sha Tin (synthetic).",
        "tags": ["demo", "retail", "sports"], "district": "Sha Tin",
        "avg_price_hkd": None, "rating_agg": 4.1, "review_count": 44, "popularity": 0.3,
    },
]

_OFFERINGS: list[dict[str, Any]] = [
    {"slug": "demo-milk-tea-set", "name": "Signature Milk Tea Set", "name_zh": "招牌凍奶茶套餐",
     "kind": "product", "price_amount": 48.0, "merchant_slug": "demo-silver-mine-restaurant",
     "description": "Demo set meal (synthetic)."},
    {"slug": "demo-running-shoes", "name": "Trail Running Shoes", "name_zh": "行山跑步鞋",
     "kind": "product", "price_amount": 699.0, "merchant_slug": "demo-rainbow-sports-store",
     "description": "Demo footwear SKU (synthetic)."},
]


def _merchant_rows() -> list[dict[str, Any]]:
    rows = []
    for m in _MERCHANTS:
        mid = _id("merchant", m["slug"])
        rows.append({
            "id": mid, "slug": m["slug"], "display_name": m["display_name"],
            "display_name_zh": m["display_name_zh"], "description": m["description"],
            "category_primary": m["category_primary"], "tags": m["tags"],
            "district": m["district"], "avg_price_hkd": m["avg_price_hkd"],
            "rating_agg": m["rating_agg"], "review_count": m["review_count"],
            "popularity_score": m["popularity"], "attributes": {},
            "data_origin": "demo", "plan": "pro", "images": None,
            "ai_agent_enabled": m["slug"] == "demo-lan-kwai-fong",
            "subject_type": "merchant", "subject_id": mid, "merchant_id": mid,
            "kw_score": 0.0, "vec_score": 0.0, "text_matched": False,
        })
    return rows


def _offering_rows() -> list[dict[str, Any]]:
    rows = []
    merchants = {m["slug"]: m for m in _MERCHANTS}
    for o in _OFFERINGS:
        oid = _id("offering", o["slug"])
        parent = merchants[o["merchant_slug"]]
        mid = _id("merchant", o["merchant_slug"])
        rows.append({
            "id": oid, "slug": o["slug"], "name": o["name"], "name_zh": o["name_zh"],
            "description": o["description"], "kind": o["kind"],
            "price_amount": o["price_amount"], "currency": "HKD", "price_model": "fixed",
            "merchant_id": mid, "merchant_slug": parent["slug"],
            "merchant_name": parent["display_name"],
            "merchant_name_zh": parent["display_name_zh"],
            "category": parent["category_primary"], "district": parent["district"],
            "avg_price_hkd": o["price_amount"], "rating_agg": 4.0, "review_count": 12,
            "popularity_score": 0.2, "attributes": {}, "data_origin": "demo",
            "plan": "pro", "images": None, "bookable": False,
            "subject_type": "offering", "subject_id": oid,
            "kw_score": 0.0, "vec_score": 0.0, "text_matched": False,
        })
    return rows


def _fact_rows(now: datetime) -> list[dict[str, Any]]:
    rows = []

    def add(subject_type: str, subject: str, attribute: str, value: Any, *,
            source: str, confidence: float, hours_old: int = 2,
            unit: str | None = None, currency: str | None = None) -> None:
        rows.append({
            "fact_id": _id("fact", f"{subject}:{attribute}"), "subject_type": subject_type,
            "subject_id": subject, "merchant_id": subject, "attribute": attribute,
            "value": value, "unit": unit, "currency": currency, "source": source,
            "source_uri": None, "confidence": confidence,
            "observed_at": now - timedelta(hours=hours_old), "expires_at": None,
            "stale": False,
        })

    for m in _MERCHANTS:
        mid = _id("merchant", m["slug"])
        add("merchant", mid, "address", {"district": m["district"]},
            source="merchant", confidence=0.95)
        if m["avg_price_hkd"] is not None:
            add("merchant", mid, "price",
                {"amount": f"{m['avg_price_hkd']:.2f}", "currency": "HKD"},
                source="merchant", confidence=0.95, currency="HKD")
        add("merchant", mid, "rating", {"value": m["rating_agg"], "count": m["review_count"]},
            source="observed", confidence=0.85)
    # offerings render a price too, so each needs its own backing fact (never fabricated)
    for o in _OFFERINGS:
        oid = _id("offering", o["slug"])
        add("offering", oid, "price",
            {"amount": f"{o['price_amount']:.2f}", "currency": "HKD"},
            source="merchant", confidence=0.9, currency="HKD")
    return rows


def _hours_rows() -> list[dict[str, Any]]:
    rows = []
    for m in _MERCHANTS[:5]:
        mid = _id("merchant", m["slug"])
        for weekday in range(7):
            closes = time(23, 0) if m["category_primary"] == "restaurant" else time(19, 0)
            rows.append({
                "merchant_id": mid, "weekday": weekday, "opens_at": time(11, 30),
                "closes_at": closes, "crosses_midnight": False, "source": "merchant",
            })
    return rows


def demo_backend(*, now: datetime | None = None) -> StaticBackend:
    """A fresh StaticBackend over the demo catalogue, timestamps relative to `now`."""
    moment = now or datetime.now(timezone.utc)
    return StaticBackend(
        merchants=_merchant_rows(),
        offerings=_offering_rows(),
        facts=_fact_rows(moment),
        hours=_hours_rows(),
        slots=[],
    )


def demo_is_active(backend: Any) -> bool:
    return getattr(backend, "name", "") == "static"
