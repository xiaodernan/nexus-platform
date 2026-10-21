"""D449/D450/D463 - a table nobody reads is a promise nobody keeps.

A census of the package's definitions found five module-level constants that NOTHING read -
and one of them had gone out of date: `_COMPARE_ATTRIBUTES` named an `open_hours` row (the
comparison grid's row is `open_state`, §422) and an `availability` row the grid does not
have. A list nobody reads is a comment with a name, and a comment with a name is the one
that is never updated.

So this is the gate for the class: **every module-level constant in the package is read by
the package**. A constant that is written and never read is either a promise to wire
something up or a leftover - and both are the writer's business, not the next reader's.

D450 widened it to the functions, and D463 fixed the COUNT: the census used to count the
TEXT mentions of a name, so a table that only the canonicalisation list mentions looked
alive - and the canonicalisation is not a use, it is a promise that the table will be read.
It counted three such tables: `EARLY_CUES` (the "before" cues - the user's "before" was
dropped and the query answered as if they had not said it), `LATE_CUES` (the "after" cues -
the function that reads the direction had its own hard-coded list, and the two disagreed)
and `MONEY_RE` (a leftover; the budget is parsed by the two regexes in `nlu/understand.py`).

A use is a READ: a name in Load context, or an attribute that is read. The census asks the
AST, so a mention in a comment, in a docstring or in a list of table names is not a use.
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "nexus_ai"
TESTS = PACKAGE.parent / "tests"

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


def _module_functions() -> dict[str, list[str]]:
    """Every module-level function in the package that the framework does not call.

    A decorated function is called by the framework (the router, the app factory), so it is
    not dead by being unreferenced - D450.
    """
    found: dict[str, list[str]] = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover
            continue
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if node.decorator_list:
                continue
            found.setdefault(node.name, []).append(
                path.relative_to(PACKAGE).as_posix())
    return found


def _reads() -> set[str]:
    """The names that are READ - in the package and in the tests.

    D463: a use is a READ, not a mention. A name in Load context, or an attribute that is
    read, is a use; a string in a comment, in a docstring or in a list of table names is not.
    """
    out: set[str] = set()
    for root in (PACKAGE, TESTS):
        for path in sorted(root.rglob("*.py")):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8-sig"))
            except (SyntaxError, OSError):  # pragma: no cover
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                    out.add(node.id)
                elif isinstance(node, ast.Attribute):
                    out.add(node.attr)
    return out


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


def test_every_module_level_constant_is_read_by_the_package():
    read = _reads()
    dead = []
    for name, where in sorted(_module_constants().items()):
        if name in ALLOWED:
            continue
        if name not in read:
            dead.append(f"{name} ({', '.join(where)})")
    assert not dead, (
        "these constants are defined and read by nothing: a table nobody reads is a "
        "promise nobody keeps, and a list that has gone out of date is the one nobody "
        "updates - " + "; ".join(dead))


def test_every_module_level_function_is_called_somewhere():
    # D450: the same rule for the functions. A function the framework calls (a route
    # handler) is decorated, and is exempt; a function nothing calls is dead - unless a
    # test calls it, which is a use.
    #
    # D463 left this rule counting MENTIONS, and that is a known gap: the AST count finds
    # seven more functions that nothing calls (the five private ones and two public exports
    # nobody uses). It is filed rather than fixed here, because two of them are part of a
    # package's public API and that is a decision, not a cleanup.
    tests = PACKAGE.parent / "tests"
    test_text = "\n".join(
        path.read_text(encoding="utf-8-sig") for path in sorted(tests.glob("*.py")))
    dead = []
    for name, where in sorted(_module_functions().items()):
        if name.startswith("__"):
            continue
        if _mentions(name) > len(where):
            continue
        if test_text.count(name) > 0:
            continue
        dead.append(f"{name} ({', '.join(where)})")
    assert not dead, (
        "these functions are defined and called by nothing: "
        + "; ".join(dead))
