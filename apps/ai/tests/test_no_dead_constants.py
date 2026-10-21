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


def test_every_module_level_function_is_called_somewhere():
    # D450: the same rule for the functions. A function the framework calls (a route
    # handler) is decorated, and is exempt; a function nothing calls is dead - unless a
    # test calls it, which is a use.
    tests = PACKAGE.parent / "tests"
    test_text = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(tests.glob("*.py")))
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


def _defined_and_loaded(tree: ast.AST) -> tuple[list[str], set[str]]:
    """The module-level constants a file defines, and the names it reads."""
    defined: list[str] = []
    for node in getattr(tree, "body", []):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id.isupper():
                defined.append(target.id)
    loaded = {node.id for node in ast.walk(tree)
              if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
    return defined, loaded


def test_every_test_file_constant_is_read_by_its_own_file():
    # D454: the census over the TEST files. The count is per file, because a count over
    # the whole directory hides a dead table behind another file's table of the same name -
    # which is exactly how the dead PAIRS table of test_merge_cue_spellings.py survived
    # (another test file has a live PAIRS), and that dead table carried a wrong code point
    # (D453). A dead table hides the rot from the test that covers the file.
    tests = PACKAGE.parent / "tests"
    dead = []
    for path in sorted(tests.glob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        except SyntaxError:  # pragma: no cover - a file that does not parse is not ours
            continue
        defined, loaded = _defined_and_loaded(tree)
        for name in defined:
            if name not in loaded:
                dead.append(f"{name} ({path.name})")
    assert not dead, (
        "these constants are defined by a test file and read by nothing: a table nobody "
        "reads is a promise nobody keeps, and a dead one hides the wrong code point from "
        "the test that covers the file (D453) - " + "; ".join(dead))
