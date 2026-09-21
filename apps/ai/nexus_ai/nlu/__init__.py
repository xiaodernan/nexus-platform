"""Query understanding: lexicon + deterministic extraction + turn merging (§7, §7.1, §8)."""

from __future__ import annotations

from nexus_ai.nlu.lexicon import (
    DISTRICTS,
    CATEGORY_SYNONYMS,
    CUISINE_TERMS,
    PREFERENCE_RULES,
    CONSTRAINT_RULES,
    detect_language,
    match_category,
    match_district,
    match_cuisines,
)
from nexus_ai.nlu.timeparse import ParsedTime, parse_time, resolve_weekday
from nexus_ai.nlu.understand import IntentExtraction, extract_intent, extract_intent_dict
from nexus_ai.nlu.state_merger import MergeResult, merge_followup, merge_turn

__all__ = [
    "DISTRICTS", "CATEGORY_SYNONYMS", "CUISINE_TERMS", "PREFERENCE_RULES",
    "CONSTRAINT_RULES", "detect_language", "match_category", "match_district",
    "match_cuisines", "ParsedTime", "parse_time", "resolve_weekday",
    "IntentExtraction", "extract_intent", "extract_intent_dict",
    "MergeResult", "merge_followup", "merge_turn",
]
