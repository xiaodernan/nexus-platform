"""Freshness policy — AGENT_CONTRACT §5 (spec §20).

The TTL table is data, not comments: `ttl_for_attribute` is what the search service and
`/carts/price-check` consult, and `stale=true` must surface as "价格可能已更新" (§5).
Availability is deliberately 0 — it is never cached (§20).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

#: AGENT_CONTRACT §5 "TTL on read", in seconds.
FRESHNESS_TTL: dict[str, float] = {
    "opening_hours": 24 * 3600,
    "description": 7 * 24 * 3600,
    "kb_document": 7 * 24 * 3600,
    "price": 6 * 3600,
    "inventory": 15 * 60,
    "availability": 0.0,            # real-time, every request
    "review_summary": 24 * 3600,
    "popularity": 3600,
    "trending": 3600,
    "address": 30 * 24 * 3600,      # effectively static, but still provenanced
    "capacity": 24 * 3600,
    "cuisine": 7 * 24 * 3600,
}

#: attribute aliases used by `facts.attribute` / offering columns
TTL_BY_ATTRIBUTE: dict[str, str] = {
    "price": "price", "price_amount": "price", "avg_price_hkd": "price",
    "opening_hours": "opening_hours", "hours": "opening_hours", "business_hours": "opening_hours",
    "availability": "availability", "next_slot": "availability",
    "inventory": "inventory", "stock": "inventory", "stock_quantity": "inventory",
    "description": "description", "review_summary": "review_summary",
    "popularity": "popularity", "trending": "trending",
    "address": "address", "capacity": "capacity", "cuisine": "cuisine",
}

#: "价格可能已更新" — the copy the cart must show for a stale price (§5, §103).
STALE_COPY: dict[str, str] = {
    "zh-HK": "價格可能已更新",
    "zh-CN": "价格可能已更新",
    "en": "price may have changed",
}

#: a review summary is also invalidated by >=5 new reviews, not just the clock (§5)
REVIEW_SUMMARY_NEW_COUNT = 5


@dataclass(frozen=True)
class Freshness:
    attribute: str
    ttl_seconds: float
    observed_at: datetime
    expires_at: datetime | None
    stale: bool
    remaining_fraction: float

    @property
    def real_time(self) -> bool:
        return self.ttl_seconds <= 0


def ttl_for_attribute(attribute: str) -> float:
    cls = TTL_BY_ATTRIBUTE.get(attribute, attribute)
    return FRESHNESS_TTL.get(cls, 24 * 3600)


def hours_ttl(hours: float) -> float:
    """For tests/callers that speak in hours."""
    return hours * 3600.0


def evaluate(observed_at: datetime | None, attribute: str, *, now: datetime | None = None,
             expires_at: datetime | None = None, forced_stale: bool = False) -> Freshness:
    ttl = ttl_for_attribute(attribute)
    now = now or datetime.now(timezone.utc)
    if observed_at is None and expires_at is None:
        return Freshness(attribute, ttl, now, None, True, 0.0)
    exp = expires_at
    if exp is None and observed_at is not None and ttl > 0:
        exp = observed_at + timedelta(seconds=ttl)
    if ttl <= 0:
        # availability: always treated as needing a live read, never cacheable
        return Freshness(attribute, ttl, observed_at or now, None, forced_stale, 0.0)
    if exp is None:
        return Freshness(attribute, ttl, observed_at or now, None, True, 0.0)
    if exp <= now or forced_stale:
        return Freshness(attribute, ttl, observed_at or now, exp, True, 0.0)
    window = (exp - (observed_at or now)).total_seconds() or ttl
    remain = max(0.0, min(1.0, (exp - now).total_seconds() / window))
    return Freshness(attribute, ttl, observed_at or now, exp, False, remain)


def is_stale(observed_at: datetime | None, attribute: str, *, now: datetime | None = None,
             expires_at: datetime | None = None) -> bool:
    return evaluate(observed_at, attribute, now=now, expires_at=expires_at).stale


def remaining_fraction(observed_at: datetime | None, attribute: str,
                       *, now: datetime | None = None,
                       expires_at: datetime | None = None) -> float:
    return evaluate(observed_at, attribute, now=now, expires_at=expires_at).remaining_fraction


def stale_copy(locale: str = "zh-HK") -> str:
    return STALE_COPY.get(locale) or STALE_COPY["zh-HK"]


def mean_remaining_fraction(rows: list[dict[str, Any]], *, now: datetime | None = None) -> float | None:
    """The `freshness` ranking feature: mean remaining-TTL fraction over a card's facts."""
    if not rows:
        return None
    vals = [remaining_fraction(r.get("observed_at"), r.get("attribute") or "description",
                               now=now, expires_at=r.get("expires_at"))
            for r in rows]
    return sum(vals) / len(vals) if vals else None


def needs_reindex(new_review_count: int, last_generated_at: datetime | None,
                  *, now: datetime | None = None) -> bool:
    """§5 recompute triggers for review summaries: 24h *or* >=5 new reviews."""
    now = now or datetime.now(timezone.utc)
    if last_generated_at is None:
        return True
    if new_review_count >= REVIEW_SUMMARY_NEW_COUNT:
        return True
    return (now - last_generated_at).total_seconds() >= FRESHNESS_TTL["review_summary"]
