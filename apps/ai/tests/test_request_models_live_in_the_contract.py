"""D470 - a public surface's request model lives in the contract module.

The comparison's request, the stream's request and the import door's request were declared
in their ROUTES, while API_CONTRACT §7 names every one of those requests - so the shape of a
public request was in two places (the contract's row and the route's class) and only one of
them was checked.

This gate asks the package where every `*Request` class is declared, and requires it to be
the contract module - except the two that are not HTTP bodies (the router's own request and
the platform door's), which are declared here with their reason.
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "nexus_ai"
CONTRACT = PACKAGE / "contract.py"

#: The `*Request` classes that are not the body of an HTTP surface, and why.
DECLARED_INTERNAL = {
    "LLMRequest": "the model router's own request (models/base.py) - not an HTTP surface",
    "PlatformRejectedRequest": (
        "the platform door's rejection body (adapters/platform.py) - not a public surface"),
}


def _declared_classes() -> dict[str, list[str]]:
    """Every class the package declares, and the modules that declare it."""
    found: dict[str, list[str]] = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        except (SyntaxError, OSError):  # pragma: no cover
            continue
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                found.setdefault(node.name, []).append(
                    path.relative_to(PACKAGE).as_posix())
    return found


def test_the_contract_module_declares_the_request_models():
    declared = _declared_classes()
    contract_models = {name for name, where in declared.items()
                       if "contract.py" in where}
    for expected in ("SearchRequest", "UnderstandRequest", "RecommendRequest",
                     "RagRetrieveRequest", "FeedbackRequest", "MerchantAgentRequest",
                     "CompareRequest", "StreamSearchRequest", "ImportExtractRequest"):
        assert expected in contract_models, (
            f"the contract module does not declare {expected} - the public request shapes "
            f"belong to one place, and the contract's rows name them: "
            f"{sorted(contract_models)}")


def test_every_request_model_is_declared_in_the_contract_module():
    declared = _declared_classes()
    outside = []
    for name, where in sorted(declared.items()):
        if not name.endswith("Request"):
            continue
        if name in DECLARED_INTERNAL:
            continue
        if "contract.py" not in where:
            outside.append(f"{name} ({', '.join(where)})")
    assert not outside, (
        "these request models are declared outside the contract module: "
        + "; ".join(outside) + " - a public request's shape is in two places (the contract's "
        "row and the route's class) and only one of them is checked")


def test_the_declared_internal_requests_still_exist():
    declared = _declared_classes()
    for name in DECLARED_INTERNAL:
        assert name in declared, (
            f"{name} is declared as an internal request but does not exist any more - the "
            f"declaration must be removed when the class is")
