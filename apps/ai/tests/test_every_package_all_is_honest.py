"""D500 - a package's `__all__` must name only what the package HAS.

`from nexus_ai.trust import *` raised `AttributeError: module 'nexus_ai.trust' has no
attribute 'copy_confidence_hint'`. The package's `__all__` named two attributes that had
been removed from its imports - `copy_confidence_hint` (D499 moved the rule into the
`Fact.confidence_hint` property) and `select_display_facts` (never imported at all) - so
the star import the `__all__` exists to enable was broken since the package landed.

A name in `__all__` is a promise: "`from this package import *` gives you this". A
promise that raises is worse than no promise, because the caller finds out at the import
line, in someone else's module, with no name of the culprit in the message.

This gate holds every package in the AI service to it:
  * every name in `__all__` is an attribute the module HAS, or a submodule of it ✓;
  * and the star import actually works ✓ - the promise, exercised ✓.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

import nexus_ai

#: every module of the AI service, walked from the package root
MODULES: list[str] = ["nexus_ai"]
for _info in pkgutil.walk_packages(nexus_ai.__path__, prefix="nexus_ai."):
    MODULES.append(_info.name)


def _declared(module) -> list[str] | None:
    return list(getattr(module, "__all__", []) or [])


@pytest.mark.parametrize("name", MODULES)
def test_the_star_import_works(name: str):
    """The promise the `__all__` exists to make, exercised."""
    namespace: dict[str, object] = {}
    try:
        exec(f"from {name} import *", namespace)  # noqa: S102 - the promise, exercised
    except AttributeError as exc:
        pytest.fail(f"`from {name} import *` raised {exc} - the package's `__all__` names "
                    f"something it does not have")


@pytest.mark.parametrize("name", MODULES)
def test_every_declared_name_exists(name: str):
    """A name in `__all__` is an attribute the module has, or a submodule of it."""
    module = importlib.import_module(name)
    declared = _declared(module)
    if not declared:
        pytest.skip(f"{name} declares no __all__")
    missing = []
    for symbol in declared:
        if hasattr(module, symbol):
            continue
        # a submodule is importable by name even before it is imported
        try:
            importlib.import_module(f"{name}.{symbol}")
        except ImportError:
            missing.append(symbol)
    assert not missing, (
        f"{name}'s __all__ names {missing} and the module does not have them - a name in "
        f"__all__ is a promise that `from {name} import *` gives you that, and a promise "
        f"that raises is worse than no promise")
