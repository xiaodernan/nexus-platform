"""Hybrid retrieval + ranking (AGENT_CONTRACT §6, spec §13,§17,§67,§113).

`ranking.py` is deliberately pure Python over a `Candidate` feature vector so the
invariants are unit-testable without a database:
  * weights are data, loaded from `infra/config/ranking_weights.yaml`
  * quality is Bayesian-smoothed, so 5.0/2 reviews loses to 4.6/200
  * a relevance floor drops junk *before* scoring
  * sponsored slots are inserted *after* organic scoring, capped 1-in-top-5, and can
    never displace the organic best match (§67)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable

import yaml

WEIGHT_KEYS = ("relevance", "quality", "distance", "price_fit", "availability",
               "personalization", "popularity", "freshness")

#: §67 — organic score is never a function of plan or spend. The loader rejects a file
#: that tries to introduce one, so the invariant survives an edit to the YAML.
FORBIDDEN_ORGANIC_KEYS = ("bid", "spend", "plan", "mrr", "arr", "paid_rank", "ads")


class RankingConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class QualityConfig:
    prior_weight: float = 15.0
    min_rating_count_for_high_confidence: int = 50


@dataclass(frozen=True)
class DistanceConfig:
    decay_m: float = 2500.0
    neutral: float = 0.5
    max_radius_m: float = 15000.0


@dataclass(frozen=True)
class PriceConfig:
    tolerance: float = 0.45
    neutral_band_hkd: float = 300.0
    hard_cap_multiplier: float = 2.0


@dataclass(frozen=True)
class AvailabilityConfig:
    weight_when_realtime_true: float = 1.0
    weight_when_unknown: float = 0.35


@dataclass(frozen=True)
class PersonalizationConfig:
    min_signals: int = 3
    ema_alpha: float = 0.1
    neutral: float = 0.5


@dataclass(frozen=True)
class SponsoredConfig:
    cap_in_top: int = 5
    max_in_top: int = 1
    label: dict[str, str] = field(default_factory=lambda: {"zh-HK": "廣告"})


@dataclass(frozen=True)
class RankingWeights:
    """Parsed `ranking_weights.yaml`. `version` is stored in recommendation_sets.strategy."""

    version: str = "hybrid_v1"
    weights: dict[str, float] = field(default_factory=dict)
    relevance_floor: float = 0.05
    quality: QualityConfig = field(default_factory=QualityConfig)
    distance: DistanceConfig = field(default_factory=DistanceConfig)
    price: PriceConfig = field(default_factory=PriceConfig)
    availability: AvailabilityConfig = field(default_factory=AvailabilityConfig)
    personalization: PersonalizationConfig = field(default_factory=PersonalizationConfig)
    sponsored: SponsoredConfig = field(default_factory=SponsoredConfig)
    facets: tuple[str, ...] = ("district", "category", "price_band", "open_now")

    def normalized(self) -> dict[str, float]:
        total = sum(self.weights.values()) or 1.0
        return {k: v / total for k, v in self.weights.items()}


def load_ranking_weights(path: Path | str) -> RankingWeights:
    p = Path(path)
    if not p.exists():
        raise RankingConfigError(f"ranking weights not found at {p} (AGENT_CONTRACT §6)")
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    forbidden = [k for k in (raw.get("weights") or {})
                 if any(bad in k.lower() for bad in FORBIDDEN_ORGANIC_KEYS)]
    if forbidden:
        raise RankingConfigError(
            f"organic weights must not contain {forbidden}: paid rank may not influence "
            "organic score (§67)")
    weights = {k: float(v) for k, v in (raw.get("weights") or {}).items()}
    missing = [k for k in WEIGHT_KEYS if k not in weights]
    if missing:
        raise RankingConfigError(f"ranking_weights.yaml is missing weights: {missing}")
    total = sum(weights.values())
    if abs(total - 1.0) > 1e-6:
        raise RankingConfigError(f"organic weights must sum to 1.0, got {total:.6f}")
    return RankingWeights(
        version=str(raw.get("version") or "hybrid_v1"),
        weights=weights,
        relevance_floor=float(raw.get("relevance_floor", 0.05)),
        quality=QualityConfig(**(raw.get("quality") or {})),
        distance=DistanceConfig(**(raw.get("distance") or {})),
        price=PriceConfig(**(raw.get("price") or {})),
        availability=AvailabilityConfig(**(raw.get("availability") or {})),
        personalization=PersonalizationConfig(**(raw.get("personalization") or {})),
        sponsored=SponsoredConfig(**(raw.get("sponsored") or {})),
        facets=tuple(raw.get("facets") or RankingWeights.facets),
    )


# --------------------------------------------------------------------------- features
@dataclass
class Candidate:
    """Everything ranking needs about one hit; `raw` carries the row + facts for the card."""

    subject_type: str            # merchant | offering
    subject_id: str
    merchant_id: str
    relevance: float = 0.0       # 0..1 fused keyword/vector signal
    rating: float | None = None
    rating_count: int = 0
    tenant_mean_rating: float = 3.5
    distance_m: float | None = None
    price: float | None = None
    budget_max: float | None = None
    budget_per: str = "party"
    availability: str | None = None      # available | limited | full | None(unknown)
    popularity: float = 0.0              # already 0..1
    freshness: float | None = None       # mean remaining-TTL fraction, None = unknown
    personalization: float | None = None  # None until >= min_signals (§6)
    sponsored: bool = False
    open_now: bool | None = None
    district: str | None = None
    category: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def key(self) -> str:
        return f"{self.subject_type}:{self.subject_id}"


@dataclass
class Scored:
    candidate: Candidate
    score: float
    organic_score: float
    breakdown: dict[str, float]
    contributions: list[tuple[str, float]] = field(default_factory=list)


def bayesian_quality(rating: float | None, count: int, prior_weight: float,
                     tenant_mean: float) -> float:
    """Shrink to the tenant mean by n/(n+K) — §6. K=15 by config."""
    r = float(rating) if rating is not None else tenant_mean
    n = max(0, int(count))
    k = max(1e-9, float(prior_weight))
    return (r * n + tenant_mean * k) / (n + k)


def _norm01(value: float) -> float:
    return max(0.0, min(1.0, value))


def distance_score(distance_m: float | None, cfg: DistanceConfig) -> float:
    if distance_m is None:
        return cfg.neutral
    d = max(0.0, float(distance_m))
    if d > cfg.max_radius_m:
        return 0.02
    return _norm01(math.exp(-d / cfg.decay_m))


def price_fit(price: float | None, budget_max: float | None, cfg: PriceConfig,
              budget_per: str = "party") -> float:
    """Inside budget scores 1.0; over budget decays on log distance (§6)."""
    if price is None:
        return 0.5
    p = max(0.01, float(price))
    if budget_max is None or budget_max <= 0:
        return _norm01(math.exp(-abs(math.log(p / cfg.neutral_band_hkd)) / 2.0))
    cap = float(budget_max)
    if p <= cap:
        # 1.0 when comfortably inside; a hair under budget still scores high
        return 1.0
    overshoot = math.log(p / cap) / cfg.tolerance
    if cap and p > cap * cfg.hard_cap_multiplier:
        return 0.0
    return _norm01(math.exp(-overshoot))


def availability_score(avail: str | None, cfg: AvailabilityConfig) -> float:
    if avail is None:
        return cfg.weight_when_unknown
    return {"available": cfg.weight_when_realtime_true, "limited": 0.6,
            "full": 0.05, "unknown": cfg.weight_when_unknown}.get(avail,
                                                                 cfg.weight_when_unknown)


def quality_component(c: Candidate, w: RankingWeights) -> float:
    """Bayesian rating rescaled onto 0..1 (1..5 domain)."""
    q = bayesian_quality(c.rating, c.rating_count, w.quality.prior_weight,
                         c.tenant_mean_rating)
    return _norm01((q - 1.0) / 4.0)


def score_candidate(c: Candidate, w: RankingWeights) -> tuple[float, dict[str, float]]:
    parts = {
        "relevance": _norm01(c.relevance),
        "quality": quality_component(c, w),
        "distance": distance_score(c.distance_m, w.distance),
        "price_fit": price_fit(c.price, c.budget_max, w.price, c.budget_per),
        "availability": availability_score(c.availability, w.availability),
        "personalization": (w.personalization.neutral if c.personalization is None
                            else _norm01(c.personalization)),
        "popularity": _norm01(c.popularity),
        "freshness": (0.5 if c.freshness is None else _norm01(c.freshness)),
    }
    nw = w.normalized()
    score = sum(nw[k] * parts[k] for k in WEIGHT_KEYS)
    return round(score, 6), parts


def contributions(parts: dict[str, float], nw: dict[str, float], top: int = 4
                  ) -> list[tuple[str, float]]:
    """Top contributing *weighted* features — the raw material for §18 explanations."""
    ranked = sorted(((k, nw[k] * parts[k]) for k in WEIGHT_KEYS),
                    key=lambda x: -x[1])
    return [(k, round(v, 6)) for k, v in ranked[:top] if v > 0]


def organic_rank(candidates: Iterable[Candidate], w: RankingWeights,
                 *, apply_floor: bool = True) -> list[Scored]:
    """Relevance floor -> score -> sort. Sponsored plays no part here (§67)."""
    out: list[Scored] = []
    floor = 0.0 if not apply_floor else w.relevance_floor
    for c in candidates:
        if apply_floor and _has_query_signal(c) and c.relevance < floor:
            continue  # dropped before scoring, never ranked by popularity to hide it
        score, parts = score_candidate(c, w)
        out.append(Scored(candidate=c, score=score, organic_score=score, breakdown=parts,
                          contributions=contributions(parts, w.normalized())))
    out.sort(key=lambda s: (-s.organic_score, s.candidate.key()))
    return out


def _has_query_signal(c: Candidate) -> bool:
    return c.relevance > 0.0 or bool(c.raw.get("text_matched"))


def apply_sponsored(ranked: list[Scored], w: RankingWeights,
                    sponsored_ids: set[str] | None = None) -> list[Scored]:
    """§66-67 — after organic scoring: insert promoted cards, labelled, capped
    `max_in_top` within the first `cap_in_top` slots, never at rank 0. The organic best
    match is never displaced, and a promoted card's score stays its organic score.
    """
    def promoted(s: Scored) -> bool:
        return s.candidate.sponsored or bool(sponsored_ids and s.candidate.key() in sponsored_ids)

    organic = [s for s in ranked if not promoted(s)]
    promo = [s for s in ranked if promoted(s)]
    if not organic or not promo:
        result = list(ranked)
    else:
        result = [organic[0]]
        inserted = 0
        cursor = 0
        for s in organic[1:]:
            if cursor < len(promo) and inserted < w.sponsored.max_in_top \
                    and len(result) < w.sponsored.cap_in_top:
                result.append(promo[cursor])
                cursor += 1
                inserted += 1
            result.append(s)
        result.extend(promo[cursor:])
    # 1-based organic position, stored on the card so the UI/eval can prove that a
    # promoted slot never moved an organic result up (§67).
    organic_pos = {s.candidate.key(): i + 1 for i, s in enumerate(organic)}
    for i, s in enumerate(result):
        s.candidate.raw["organic_rank"] = organic_pos.get(s.candidate.key())
        s.candidate.raw["rank_hint"] = i
    return result


def sponsor_label(locale: str, w: RankingWeights) -> str:
    cfg = w.sponsored.label or {}
    return cfg.get(locale) or cfg.get("zh-HK") or "Sponsored"


def facet_counts(candidates: Iterable[Candidate], facets: Iterable[str]) -> dict[str, dict[str, int]]:
    """Facets over the *result set* (not the whole DB) — cheap, deterministic, honest."""
    out: dict[str, dict[str, int]] = {f: {} for f in facets}
    for c in candidates:
        if "district" in out and c.district:
            out["district"][c.district] = out["district"].get(c.district, 0) + 1
        if "category" in out and c.category:
            out["category"][c.category] = out["category"].get(c.category, 0) + 1
        if "price_band" in out and c.price is not None:
            band = price_band(c.price)
            out["price_band"][band] = out["price_band"].get(band, 0) + 1
        if "open_now" in out and c.open_now is not None:
            key = "open" if c.open_now else "closed"
            out["open_now"][key] = out["open_now"].get(key, 0) + 1
    return out


def price_band(amount: float | None) -> str:
    if amount is None:
        return "unknown"
    if amount < 100:
        return "$"
    if amount < 300:
        return "$$"
    if amount < 800:
        return "$$$"
    return "$$$$"


def personalization_signal(ratings: list[float], cfg: PersonalizationConfig) -> float | None:
    """§99-100 EMA over feedback, never ground truth alone; needs >= min_signals."""
    if len(ratings) < cfg.min_signals:
        return None
    ema = ratings[0]
    for v in ratings[1:]:
        ema = cfg.ema_alpha * v + (1 - cfg.ema_alpha) * ema
    return _norm01(ema)
