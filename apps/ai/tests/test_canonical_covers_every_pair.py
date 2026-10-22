"""D485 - the canonical table must carry EVERY pair the product already knows.

The canonical table maps the Simplified spelling to the product's canonical one, and the
lexicon keeps its own pair list. Nine of those pairs were not in the table, so a query
written in those Simplified forms was compared against the table's canonical spelling and
never met it:

    the Simplified 粉面 (noodle soup)  -> the intent 'unknown'
    the Traditional 粉麵               -> the intent 'discover_merchant', the category
                                          'restaurant'
    the Simplified 划位 (book a table) -> the intent 'unknown'
    the Traditional 劃位               -> the intent 'reserve'

A Simplified Chinese user - the product answers zh-CN - was not understood.

This gate is the census D435's note asked for and nobody ran: **the canonical table
carries every pair the lexicon knows** ✓ - one fact, one place ✓.
"""

from __future__ import annotations

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.canonical import CANONICAL_FORMS, canonical
from nexus_ai.nlu.understand import extract_intent

#: the pairs the lexicon holds: (traditional, simplified)
PAIRS = L._TRAD_SIMP_PAIRS


@pytest.mark.parametrize("traditional,simplified", PAIRS,
                         ids=[f"U+{ord(t):04X}" for t, _s in PAIRS])
def test_the_canonical_table_carries_every_pair(traditional: str, simplified: str):
    """The census: the table is the map, and the map is complete.

    The value may be a VARIANT of the pair's own form (a character can have two
    Traditional spellings - the canonicaliser has to pick one, and the product's pick is
    the table's), so the check is that the value is a Traditional character and not the
    Simplified one.
    """
    assert simplified in CANONICAL_FORMS, (
        f"the canonical table does not carry U+{ord(simplified):04X} -> "
        f"U+{ord(traditional):04X} - a query written in that Simplified spelling is "
        f"compared against a spelling it can never have, and it never matches")
    value = CANONICAL_FORMS[simplified]
    assert value != simplified, (
        f"the canonical table maps U+{ord(simplified):04X} to itself - the Simplified "
        f"spelling is not the canonical one")
    assert value in L.TRADITIONAL_MARKERS, (
        f"the canonical table maps U+{ord(simplified):04X} to U+{ord(value):04X}, which "
        f"is not a Traditional character - the product's canonical spelling is the "
        f"Traditional one")


def test_the_two_spellings_read_the_same():
    """The end-to-end proof: the same request in the two spellings."""
    for label, simplified, traditional, expected in (
            ("noodle soup", "\u7c89\u9762", "\u7c89\u9eb5", "discover_merchant"),
            ("book a table", "\u5212\u4f4d", "\u5283\u4f4d", "reserve")):
        simple = extract_intent(simplified, {"locale": "zh-CN"})
        tradi = extract_intent(traditional, {"locale": "zh-HK"})
        assert simple.intent == tradi.intent == expected, (
            f"{label}: the Simplified spelling gave {simple.intent!r} and the Traditional "
            f"one {tradi.intent!r} - the same request must read the same")
        assert simple.category == tradi.category, (
            f"{label}: the Simplified spelling gave the category {simple.category!r} and the "
            f"Traditional one {tradi.category!r}")


def test_the_simplified_spelling_is_rewritten():
    """The map itself: the Simplified character becomes the canonical one."""
    for traditional, simplified in PAIRS:
        if simplified not in CANONICAL_FORMS:
            continue
        assert canonical(simplified) == CANONICAL_FORMS[simplified], (
            f"the canonical form of U+{ord(simplified):04X} is "
            f"U+{ord(canonical(simplified)):04X} and the table says "
            f"U+{ord(CANONICAL_FORMS[simplified]):04X}")
