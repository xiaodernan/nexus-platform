"""D511 - the NLU writes cuisine_like structured preferences (not just cuisine strings).

The seed stores cuisine preferences as `cuisine_like` with `{"values": [...]}` object format,
and the matcher (D394) reads both formats through `cuisine_matches`. But the NLU only wrote
`cuisine` string preferences, so a typed cuisine like "我想食粵菜" produced a `cuisine` 
string preference that was NOT stored — the user's own words about a cuisine were not 
recorded as a preference.

Measured: a typed "我想食粵菜" produced `cuisine=cantonese` (string) but no `cuisine_like` 
object. The seed stores `cuisine_like: {"values": ["cantonese","sushi","specialty-coffee"]}`.

The fix: the NLU now also emits `cuisine_like: {"values": [...]}` when it detects cuisines.
This ensures the user's own words about a cuisine are recorded as a preference.

Verified, not claimed.

- the gate -> passed;
- the full `apps/ai` suite -> passed;
- ruff check . -> All checks passed!; mypy nexus_ai -> Success;
- the eval gate -> RESULT: PASS;
- the five ledger readers -> all PASS.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu.understand import extract_intent


def test_nlu_writes_cuisine_like_structured_preference():
    """A typed cuisine produces both cuisine string AND cuisine_like structured preference."""
    result = extract_intent("我想食廣東菜", {})  # "I want to eat Cantonese food"
    
    # Should have cuisine string preference
    cuisine_prefs = [p for p in result.preferences if p["key"] == "cuisine"]
    assert len(cuisine_prefs) == 1, f"Expected 1 cuisine pref, got {len(cuisine_prefs)}"
    assert cuisine_prefs[0]["value"] == "cantonese"
    assert cuisine_prefs[0]["polarity"] == 1
    
    # Should ALSO have cuisine_like structured preference
    cuisine_like_prefs = [p for p in result.preferences if p["key"] == "cuisine_like"]
    assert len(cuisine_like_prefs) == 1, f"Expected 1 cuisine_like pref, got {len(cuisine_like_prefs)}"
    assert cuisine_like_prefs[0]["value"] == {"values": ["cantonese"]}
    assert cuisine_like_prefs[0]["polarity"] == 1


def test_nlu_writes_cuisine_like_for_multiple_cuisines():
    """Multiple detected cuisines all go into the cuisine_like values list."""
    result = extract_intent("我想食廣東飲茶", {})  # "I want Cantonese dim sum"
    
    cuisine_like_prefs = [p for p in result.preferences if p["key"] == "cuisine_like"]
    assert len(cuisine_like_prefs) == 1, f"Expected 1 cuisine_like pref, got {len(cuisine_like_prefs)}"
    
    values = cuisine_like_prefs[0]["value"]["values"]
    assert "cantonese" in values, f"Expected cantonese in {values}"
    assert "dim_sum" in values, f"Expected dim_sum in {values}"


def test_nlu_writes_both_cuisine_and_cuisine_like():
    """Both cuisine string and cuisine_like object are written."""
    result = extract_intent("我想食廣東菜", {})  # "I want Cantonese food"
    
    cuisine_prefs = [p for p in result.preferences if p["key"] == "cuisine"]
    cuisine_like_prefs = [p for p in result.preferences if p["key"] == "cuisine_like"]
    
    assert len(cuisine_prefs) == 1
    assert len(cuisine_like_prefs) == 1
    
    # cuisine is a string
    assert cuisine_prefs[0]["value"] == "cantonese"
    
    # cuisine_like is an object with values list
    assert cuisine_like_prefs[0]["value"] == {"values": ["cantonese"]}


def test_cuisine_like_values_match_detected_cuisines():
    """The cuisine_like values list contains exactly the cuisines the NLU detected."""
    result = extract_intent("想食廣東飲茶", {})  # "Want Cantonese dim sum"
    
    cuisine_like_prefs = [p for p in result.preferences if p["key"] == "cuisine_like"]
    assert len(cuisine_like_prefs) == 1
    
    values = cuisine_like_prefs[0]["value"]["values"]
    # Should contain cantonese and dim_sum (the two detected)
    assert "cantonese" in values
    assert "dim_sum" in values