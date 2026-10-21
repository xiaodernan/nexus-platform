"""D449 - a table nobody reads is a promise nobody keeps.

A census of the package's definitions (the same sweep that found D437's unused row builder)
found five module-level constants that NOTHING read - and one of them had gone out of date:
`_COMPARE_ATTRIBUTES` named an `open_hours` row (the comparison grid's row is `open_state`,
§422) and an `availability` row the grid does not have. A list nobody reads is a comment
with a name, and a comment with a name is the one that is never updated.

So this is the gate for the class: **every module-level constant in the package is read by
the package.** A constant that is written and never read is either a promise to wire
something up or a leftover - and both are the writer's business, not the next reader's.
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "nexus_ai"

#: The definitions the framework itself consumes: a route handler is called by the router,
#: a pydantic model is used by the framework, and a table's name is often its own use.
ALLOWED = frozenset({"__all__", "MODEL_CONFIG", "model_config"})


def _module_constants() -> dict[str, list[str]]:
    """Every module-level constant in the package, and where it is defined."""
    found: dict[str, list[str]] = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover - a file that does not parse is not ours
            continue
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    found.setdefault(target.id, []).append(
                        path.relative_to(PACKAGE).as_posix())
    return found


def _mentions(name: str) -> int:
    """How many times the package mentions a name (its definition counts once)."""
    total = 0
    for path in PACKAGE.rglob("*.py"):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:  # pragma: no cover
            continue
        total += text.count(name)
    return total


def test_every_module_level_constant_is_read_somewhere_in_the_package():
    dead = []
    for name, where in sorted(_module_constants().items()):
        if name in ALLOWED:
            continue
        if _mentions(name) <= len(where):
            # mentioned only in the definition(s) - nothing reads it
            dead.append(f"{name} ({', '.join(where)})")
    assert not dead, (
        "these constants are defined and read by nothing: a table nobody reads is a "
        "promise nobody keeps, and a list that has gone out of date is the one nobody "
        "updates - " + "; ".join(dead))
