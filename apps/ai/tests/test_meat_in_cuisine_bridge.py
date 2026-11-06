"""D698 - "meat" (肉) is now in the cuisine bridge tables.

"no meat" previously wrote no constraint and no preference because "meat" had no entry
in CUISINE_TERMS. The corpus carries vegetarian merchants (`cuisine_vegetarian` attribute)
that the refusal should point at. "肉" is now in CUISINE_TERMS["vegetarian"], so the word
can be matched and mapped to the vegetarian cuisine leaf.

Pure and DB-free.
"""

from __future__ import annotations

from nexus_ai.nlu.lexicon import CUISINE_TERMS, cuisine_leaves, match_cuisine_terms
from nexus_ai.nlu.understand import extract_intent


class TestMeatInCuisineTerms:
    """「肉」/ "meat" now has an entry in the cuisine bridge."""

    def test_meat_is_in_vegetarian_cuisine_terms(self):
        assert "肉" in CUISINE_TERMS["vegetarian"], (
            "肉 should name the vegetarian cuisine")
        assert "meat" in CUISINE_TERMS["vegetarian"], (
            "meat should name the vegetarian cuisine")

    def test_meat_cuisine_leaves_return_itself(self):
        # Unknown cuisines are matched by their own name; "meat" maps to itself
        leaves = cuisine_leaves("meat")
        assert "meat" in leaves

    def test_match_cuisine_terms_finds_meat(self):
        matches = match_cuisine_terms("我想食肉")
        assert ("vegetarian", "肉") in matches or ("vegetarian", "素食") in matches, (
            f"「肉」 should match vegetarian cuisine, got {matches}")


class TestMeatPreferenceExtraction:
    """A sentence naming meat produces a cuisine preference."""

    def test_positive_meat_preference(self):
        ex = extract_intent("我想食肉")
        prefs = {(p["key"], p["value"]): p for p in ex.preferences}
        # "肉" matches vegetarian cuisine, so a positive meat preference is
        # recorded as cuisine/vegetarian (the bridge's mapping)
        assert ("cuisine", "vegetarian") in prefs, (
            f"expected cuisine/vegetarian preference, got {list(prefs.keys())}")
        assert prefs[("cuisine", "vegetarian")]["polarity"] == 1

    def test_negated_meat_preference(self):
        ex = extract_intent("唔食肉")
        prefs = {(p["key"], p["value"]): p for p in ex.preferences}
        # "唔食肉" negates the meat/vegetarian match → polarity -1
        assert ("cuisine", "vegetarian") in prefs, (
            f"expected cuisine/vegetarian preference, got {list(prefs.keys())}")
        assert prefs[("cuisine", "vegetarian")]["polarity"] == -1
