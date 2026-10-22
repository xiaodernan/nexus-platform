"""Trust layer: freshness policy (§5), the `facts` primitives (§4), claim verification
(§4 last bullet + §72) and prompt-injection containment (§8)."""

from __future__ import annotations

from nexus_ai.trust.freshness import (
    FRESHNESS_TTL,
    TTL_BY_ATTRIBUTE,
    Freshness,
    hours_ttl,
    remaining_fraction,
    stale_copy,
    ttl_for_attribute,
)
from nexus_ai.trust.facts import (
    SOURCE_RANK,
    FactBundle,
    better_source,
    facts_from_rows,
    resolve_conflicts,
)
from nexus_ai.trust.verification import (
    Claim,
    GroundSet,
    VerificationReport,
    build_ground_set,
    extract_claims,
    verify_claims,
    verify_generated_text,
    verify_text,
)
from nexus_ai.trust.injection import (
    INSTRUCTION_DELIMITER,
    INJECTION_PATTERNS,
    InjectionHit,
    InjectionReport,
    contains_injection_signals,
    injection_signals,
    merge_reports,
    sanitize_untrusted,
    scan_untrusted,
    wrap_untrusted,
)

__all__ = [
    "FRESHNESS_TTL", "TTL_BY_ATTRIBUTE", "Freshness", "ttl_for_attribute", "hours_ttl",
    "remaining_fraction", "stale_copy",
    "SOURCE_RANK", "FactBundle", "facts_from_rows", "better_source",
    "resolve_conflicts",
    "Claim", "GroundSet", "VerificationReport", "extract_claims", "verify_claims",
    "verify_text", "verify_generated_text", "build_ground_set",
    "INSTRUCTION_DELIMITER", "INJECTION_PATTERNS", "InjectionHit", "InjectionReport",
    "contains_injection_signals", "injection_signals", "wrap_untrusted",
    "sanitize_untrusted", "scan_untrusted", "merge_reports",
]
