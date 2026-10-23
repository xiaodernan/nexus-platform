"""D527 - every preference the seed declares for the demo user is one the ranker reads.

The seed writes seven rows into `user_preferences` for the demo consumer, and one of them
was spelled in a (kind, key) the ranker has no branch for at all:

    ("accessibility", "step_free", {"value": True}, 0.4, "declared")

The ranker reads `access/accessible` - that is the spelling the NLU's own preference table
emits (`PREFERENCE_RULES` carries `("access", "accessible", ...)`) and the spelling the
matcher has a branch for. Measured, the declared row answered `personalization = None` for
every merchant: the user is told they have a step-free preference, the corpus carries the
fact (`accessible_access`, `wheelchair_access`), and the ranker drops the row on the floor
without a word. §33 says the user can inspect and delete their preferences; a preference
that is silently unread is one they cannot inspect the effect of.

This gate reads the seed's own `prefs` list and the ranker's own branch table - both with
`ast`, so neither has to be executed - and holds them to each other. It was **proved to
fail**: respelling the seed's row back to `accessibility/step_free` reddens the check (the
probe was put back).
"""

from __future__ import annotations

import ast

import pytest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_GENERATOR = _ROOT / "data" / "seed" / "generate.py"
_SERVICE = _ROOT / "apps" / "ai" / "nexus_ai" / "search" / "service.py"

#: Rows the seed declares that are not RANKING signals at all. `language/response_locale`
#: says which language to answer in; the ranker has nothing to say about it. Anything not
#: named here must be a (kind, key) the ranker actually reads.
NOT_A_RANKING_SIGNAL = {
    ("language", "response_locale"),
}


def _declared_preferences() -> set[tuple[str, str]]:
    """Every (kind, key) the seed writes into `user_preferences` for the demo user."""
    tree = ast.parse(_GENERATOR.read_text(encoding="utf-8"))
    holder = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "prefs" for t in node.targets):
            holder = node.value
            break
    assert isinstance(holder, ast.List), (
        "the seed's `prefs` list is no longer a plain list literal - this gate must be "
        "re-read against it")
    out: set[tuple[str, str]] = set()
    for element in holder.elts:
        assert isinstance(element, ast.Tuple) and len(element.elts) >= 2, (
            "the seed's prefs list holds something that is not a (kind, key, ...) row")
        first, second = element.elts[0], element.elts[1]
        assert isinstance(first, ast.Constant) and isinstance(second, ast.Constant), (
            "the seed's prefs list holds a row whose kind/key is not a literal")
        out.add((str(first.value), str(second.value)))
    return out


def _readable_preferences() -> set[tuple[str, str]]:
    """Every (kind, key) the ranker has a branch for, read out of its own branch table.

    The table is an `if kind == ... and key == ...` / `elif ...` chain inside
    `search()`. Reading it with `ast` rather than importing it keeps the gate honest about
    what the SOURCE says, and it picks up a new branch the moment one is written.
    """
    tree = ast.parse(_SERVICE.read_text(encoding="utf-8"))

    def constants(operand) -> set[str]:
        if isinstance(operand, ast.Constant) and isinstance(operand.value, str):
            return {operand.value}
        if isinstance(operand, (ast.Tuple, ast.List, ast.Set)):
            return {e.value for e in operand.elts
                    if isinstance(e, ast.Constant) and isinstance(e.value, str)}
        return set()

    pairs: set[tuple[str, str]] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        kinds: set[str] = set()
        keys: set[str] = set()
        for sub in ast.walk(node.test):
            if not (isinstance(sub, ast.Compare) and len(sub.ops) == 1):
                continue
            if not isinstance(sub.left, ast.Name):
                continue
            if sub.left.id == "kind":
                kinds |= constants(sub.comparators[0])
            elif sub.left.id == "key":
                keys |= constants(sub.comparators[0])
        for kind in kinds:
            for key in keys:
                pairs.add((kind, key))
    return pairs


DECLARED = _declared_preferences()
READABLE = _readable_preferences()


def test_the_gate_reads_both_planes():
    """A gate that read an empty table would pass everything."""
    assert len(READABLE) >= 12, (
        f"the ranker's branch table yielded only {sorted(READABLE)} - this gate is no "
        f"longer reading the reader it claims to read")
    assert ("access", "accessible") in READABLE, (
        "the ranker has no branch for access/accessible, which the NLU emits for a "
        "wheelchair/step-free query")


@pytest.mark.parametrize("kind,key", sorted(DECLARED - NOT_A_RANKING_SIGNAL),
                         ids=[f"{k}/{v}" for k, v in sorted(DECLARED - NOT_A_RANKING_SIGNAL)])
def test_a_declared_preference_is_one_the_ranker_reads(kind, key):
    assert (kind, key) in READABLE, (
        f"the seed declares {kind}/{key} for the demo user and the ranker has no branch "
        f"for it - the preference answers None for every merchant, so a user who is told "
        f"they have it gets nothing from it. Respell the row into the product's own "
        f"vocabulary (the one the NLU emits) or add the branch; do not leave it on the "
        f"floor")
