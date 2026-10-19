"""Deterministic hybrid search (§13, §17, §67): SQL lanes, ranking policy, EntityCards."""

from nexus_ai.search.ranking import (
    Candidate,
    RankingConfigError,
    RankingWeights,
    Scored,
    apply_sponsored,
    bayesian_quality,
    contributions,
    distance_score,
    facet_counts,
    load_ranking_weights,
    organic_rank,
    personalization_signal,
    price_fit,
    score_candidate,
    sponsor_label,
)
from nexus_ai.search.service import (
    DEFAULT_TENANT_ID,
    PostgresBackend,
    SearchBackend,
    SearchPlan,
    StaticBackend,
    candidates_from_rows,
    plan_from_intent,
    search,
)
from nexus_ai.search import sql as SQL

__all__ = [
    "Candidate", "Scored", "RankingWeights", "RankingConfigError", "load_ranking_weights",
    "organic_rank", "apply_sponsored", "score_candidate", "contributions", "bayesian_quality",
    "distance_score", "price_fit", "facet_counts", "personalization_signal", "sponsor_label",
    "SearchBackend", "PostgresBackend", "StaticBackend", "SearchPlan", "plan_from_intent",
    "search", "candidates_from_rows", "DEFAULT_TENANT_ID",
    "SQL",
]
