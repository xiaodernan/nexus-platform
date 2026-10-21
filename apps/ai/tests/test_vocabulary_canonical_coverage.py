"""D435 - the vocabulary's spellings and the locale's markers must not drift apart.

Two facts about a Chinese character are kept in this product:

  * its CANONICAL spelling - the one the vocabulary is written in and the one every
    comparison is made in, because the query is canonicalised before it is compared
    (`nlu/canonical.py`, D417);
  * whether it is the SIMPLIFIED or the TRADITIONAL one - which is what the locale
    detection votes on, on the text as the user wrote it (`nlu/lexicon.py`, D420).

Both were kept BY HAND, in two different modules, and nothing checked they agreed:

  * two vocabulary tables were left out of the import-time canonicalisation list, so a
    cue written in the Simplified spelling was compared against a spelling it could
    never have - 现在 set nothing, in either spelling;
  * the marker set did not know the 96 Simplified forms the canonical table already
    rewrites, so a Simplified user whose query used one of them was read as a Hong Kong
    user.

So this file is the census that makes both facts ONE fact:

  * every vocabulary table that holds Chinese is either canonicalised at import, or
    already holds the canonical spelling - a table that holds a character the
    canonicalisation rewrites is a table whose cues can never match;
  * every character the canonical table knows votes for the locale it belongs to.
"""

from __future__ import annotations

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.canonical import CANONICAL_FORMS, canonical

#: The tables that hold the Simplified/Traditional fact ON PURPOSE: the marker sets and
#: the pairs they are built from. They are the detection's raw material - the detection
#: reads the text as the user wrote it, so it needs the Simplified spelling itself.
BY_DESIGN = frozenset({
    "SIMPLIFIED_MARKERS", "TRADITIONAL_MARKERS", "_TRAD_SIMP_PAIRS",
})

#: The canonical table itself, imported into the lexicon's namespace: it IS the map.
THE_MAP = frozenset({"CANONICAL_FORMS"})


def _chinese(value: object) -> set[str]:
    return {ch for ch in repr(value) if "\u4e00" <= ch <= "\u9fff"}


def _vocabulary_tables() -> dict[str, object]:
    """The lexicon's tables - the ones whose spelling decides what the product matches."""
    tables: dict[str, object] = {}
    for name in dir(L):
        if name.startswith("__"):
            continue
        value = getattr(L, name)
        if not isinstance(value, (str, list, tuple, dict, set, frozenset)):
            continue
        # a vocabulary table is NAMED in capitals; the module also leaks the loop
        # variables of its own comprehensions (_row, _form, _forms), and those are not
        # tables the product matches against.
        if not name.lstrip("_").isupper():
            continue
        if not _chinese(value):
            continue
        tables[name] = value
    return tables


def test_every_vocabulary_table_is_canonicalised_or_already_canonical():
    listed = set(L._CANONICALISED_TABLES)
    offenders: dict[str, list[str]] = {}
    for name, value in _vocabulary_tables().items():
        if name in BY_DESIGN or name in THE_MAP:
            continue
        if name in listed:
            continue
        stale = sorted(ch for ch in _chinese(value) if canonical(ch) != ch)
        if stale:
            offenders[name] = [f"U+{ord(ch):04X}" for ch in stale]
    assert not offenders, (
        "these vocabulary tables hold a character the canonicalisation rewrites and are "
        "not canonicalised at import - so a cue written in that spelling is compared "
        "against a spelling it can never have, and it can never match: "
        + "; ".join(f"{name} ({', '.join(codes)})" for name, codes in offenders.items()))


def test_the_canonicalised_tables_hold_only_canonical_characters():
    for name in L._CANONICALISED_TABLES:
        value = getattr(L, name, None)
        if value is None:
            continue
        stale = sorted(ch for ch in _chinese(value) if canonical(ch) != ch)
        assert not stale, (
            f"{name} is canonicalised at import but still holds "
            + ", ".join(f"U+{ord(ch):04X}" for ch in stale))


def test_every_canonical_pair_votes_for_its_own_locale():
    # The detection reads the text as the user wrote it, and the canonical table knows
    # 229 Simplified forms - every one of them must vote Simplified, and every one of
    # their Traditional forms must vote Traditional. Before D435 the markers did not
    # know 96 of the Simplified forms, so those users were read as Hong Kong users.
    for simplified, traditional in CANONICAL_FORMS.items():
        assert L.detect_language(simplified) == "zh-CN", (
            f"U+{ord(simplified):04X} is the Simplified spelling of "
            f"U+{ord(traditional):04X} and does not vote Simplified")
        assert L.detect_language(traditional) == "zh-HK", (
            f"U+{ord(traditional):04X} is the Traditional spelling of "
            f"U+{ord(simplified):04X} and does not vote Traditional")


def _simplified(text: str) -> str:
    """The Simplified spelling of a canonical text, from the canonical table itself."""
    reverse = {value: key for key, value in CANONICAL_FORMS.items()}
    return "".join(reverse.get(ch, ch) for ch in text)


def _now_cues() -> tuple[str, str]:
    """The product's own word for "now", in the two spellings the user may type.

    The Simplified spelling is derived from the CANONICAL TABLE (whose keys are the
    Simplified forms) and the canonical one is the vocabulary's own cue - neither is
    typed here, because a hand-written CJK code point is not a reference (D409).
    """
    reverse = {value: key for key, value in CANONICAL_FORMS.items()}
    canonical_cue = next(cue for cue in L.URGENCY_NOW
                         if len(cue) == 2 and any(ch in reverse for ch in cue))
    return _simplified(canonical_cue), canonical_cue


def test_the_product_understands_its_own_now_in_both_spellings():
    # 现在 is the product's own word for "now" (URGENCY_NOW), and it was in the cue list
    # in the Simplified spelling only - while the query is canonicalised before the
    # comparison. So neither 现在 nor 現在 set the urgency.
    from nexus_ai.nlu.understand import extract_intent_dict

    simplified, traditional = _now_cues()
    assert extract_intent_dict(simplified)["urgency"] == "now", (
        f"the Simplified spelling of the product's own now cue sets nothing: "
        f"{simplified.encode('unicode_escape').decode()}")
    assert extract_intent_dict(traditional)["urgency"] == "now", (
        f"the Traditional spelling of the product's own now cue sets nothing: "
        f"{traditional.encode('unicode_escape').decode()}")


def test_the_simplified_user_is_answered_in_the_simplified_locale():
    from nexus_ai.nlu.understand import extract_intent_dict

    simplified, traditional = _now_cues()
    assert extract_intent_dict(simplified)["language"] == "zh-CN", (
        "a Simplified user is read as a Hong Kong user")
    assert extract_intent_dict(traditional)["language"] == "zh-HK", (
        "a Traditional user is read as a Simplified user")
