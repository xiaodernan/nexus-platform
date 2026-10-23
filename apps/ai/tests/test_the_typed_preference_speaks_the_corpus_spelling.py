"""D530 - a preference the user TYPES reads the attribute the corpus actually writes.

The ranker answers the same question twice. Once for a preference the user DECLARED,
out of `user_preferences` - a long `if kind == ... and key == ...` chain that names each
attribute explicitly. Once for a preference the user typed in THIS query, out of the
Intent - which derives the attribute name from the (kind, key) pair:

    attr_key1 = f"{pref_value}_{pref_kind}"   # occasion/date -> date_occasion
    attr_key2 = f"{pref_kind}_{pref_value}"   # occasion/date -> occasion_date

Nineteen of the twenty rows in the lexicon's `PREFERENCE_RULES` resolve to an attribute
the seed writes through one of those two spellings. One does not. `time_pref/open_late`
derives `open_late_time_pref` and `time_pref_open_late`; the seed - and the stored branch,
and the corpus - all spell it `opens_late`. So the two readers of one fact disagreed, and
the one serving the live query was the broken one. Measured on the live plane:

    the corpus splits 266 merchants that open late / 204 that do not
    the stored path scores those halves            0.9 / 0.1
    the typed path, before the fix, scored          0 merchants

A user who typed a late-night request got a personalization lane that moved nothing at
all - and nothing said so. This is the D518 shape (one fact, two readers, the copy serving
the live query is the broken one) reached a third time, and the D522 shape (a reader
looking where the fact is not written) reached from the attribute side.

The fix adds the spelling the stored branch already reads to the intent path's candidate
names, and this gate holds the two planes to each other so a new preference row cannot
land speaking a vocabulary no corpus writes. It reads the seed's `attrs` dict with `ast`,
so neither side has to be executed.

"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu.lexicon import PREFERENCE_RULES

_ROOT = Path(__file__).resolve().parents[3]
_GENERATOR = _ROOT / "data" / "seed" / "generate.py"


def _seed_merchant_attributes() -> set[str]:
    """Every key the seed writes into a merchant's `attributes` JSONB."""
    tree = ast.parse(_GENERATOR.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        keys = {k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)}
        if "data_origin" in keys and "quiet_ambience" in keys:
            found |= keys
    assert found, (
        "the seed's merchant `attrs` dict was not found - this gate must be re-read "
        "against the generator")
    return found


def _candidate_names(kind: str, key: str) -> list[str]:
    """The attribute names the intent path will look for, in the order it tries them."""
    return [f"{key}_{kind}", f"{kind}_{key}",
            *S._INTENT_ATTR_ALIASES.get((kind, key), ())]


# ------------------------------------------------------------------ the cross-plane gate
@pytest.mark.parametrize("kind,key", [(k, v) for k, v, _terms, _pol in PREFERENCE_RULES])
def test_every_preference_the_nlu_emits_names_an_attribute_the_seed_writes(kind, key):
    """One fact, one spelling. A preference the corpus cannot answer is a preference the
    user's own words cannot move - and nothing on the surface says so."""
    written = _seed_merchant_attributes()
    candidates = _candidate_names(kind, key)
    assert any(name in written for name in candidates), (
        f"the NLU emits ({kind!r}, {key!r}) and the intent path looks for {candidates}, "
        f"but the seed writes none of them - a preference the user types is inert")


def test_the_alias_table_names_attributes_the_seed_actually_writes():
    """The alias table is the one place a spelling is written down by hand, so it is the
    one place a dead spelling can hide."""
    written = _seed_merchant_attributes()
    for (kind, key), names in S._INTENT_ATTR_ALIASES.items():
        for name in names:
            assert name in written, (
                f"the alias for ({kind!r}, {key!r}) names {name!r}, which the seed does "
                f"not write - the alias is dead and the preference is inert again")


def test_every_alias_is_a_preference_the_nlu_can_emit():
    """An alias for a (kind, key) nothing emits is a row nobody reads."""
    emitted = {(k, v) for k, v, _t, _p in PREFERENCE_RULES}
    for pair in S._INTENT_ATTR_ALIASES:
        assert pair in emitted, (
            f"the alias table carries {pair}, which PREFERENCE_RULES does not emit")
