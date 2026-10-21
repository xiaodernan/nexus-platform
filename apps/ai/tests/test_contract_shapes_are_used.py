"""D438 - the contract module's shapes are the API's promise, so every one of them is used.

`nexus_ai/contract.py` is the AI service's own shape vocabulary. A shape that no route
accepts and no response returns is a promise the service does not keep - and the two that
were there said so quietly:

* `ErrorEnvelope` modelled the §1 error body, and SEVEN places across five route modules
  hand-built the same dict instead. A shape written once and copied seven times is a
  shape that drifts, and a drift there is invisible: the copy still looks like an
  envelope;
* `AiSearchRequest` (query, conversation_id, context, limit) has been dead since the
  first commit - the search's own shape is `SearchRequest`, and the platform never sent
  this one.

So this file is the census: every shape the contract module declares is used by the
package, and every error the service answers with validates against the contract's own
envelope.
"""

from __future__ import annotations

import ast
from pathlib import Path

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import ErrorEnvelope

PACKAGE = Path(__file__).resolve().parents[1] / "nexus_ai"


def _contract_shapes() -> list[str]:
    tree = ast.parse((PACKAGE / "contract.py").read_text(encoding="utf-8"))
    return [node.name for node in tree.body if isinstance(node, ast.ClassDef)]


def _package_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8")
                     for path in sorted(PACKAGE.rglob("*.py")))


def test_every_contract_shape_is_used_by_the_package():
    text = _package_text()
    unused = [name for name in _contract_shapes()
              if text.count(name) <= 1]  # the definition itself, and nothing else
    assert not unused, (
        "these shapes are declared by the contract module and used by nothing: a shape "
        "nobody accepts and nobody returns is a promise the service does not keep - "
        + ", ".join(unused))


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def test_the_error_bodies_the_service_answers_with_match_the_contract():
    with _client() as c:
        cases = [
            ("POST", "/ai/v1/query/understand", {"query": ""}),
            ("POST", "/ai/v1/recommend", {"intent": None, "query": ""}),
            ("POST", "/ai/v1/imports/extract", {"source_type": "text", "source_ref": "x",
                                                "raw_text": "y"}),
            ("GET", "/ai/v1/conversations/not-a-uuid", None),
        ]
        for method, path, body in cases:
            if method == "GET":
                r = c.get(path)
            else:
                r = c.post(path, json=body)
            assert r.status_code >= 400, f"{path} answered {r.status_code}"
            payload = r.json()
            # the contract's own model accepts it - that is the point of the model
            ErrorEnvelope.model_validate(payload)
            assert payload["error"]["code"], f"{path} answered an error with no code"
            assert payload["error"]["message"], f"{path} answered an error with no message"
            assert "details" in payload["error"], f"{path} answered an error with no details"


def test_the_envelope_is_built_from_the_contract_model():
    from nexus_ai.api.errors import error_envelope

    envelope = error_envelope("validation_error", "bad input",
                              details={"field": "query"}, request_id="req-1")
    ErrorEnvelope.model_validate(envelope)
    assert envelope["error"]["code"] == "validation_error"
    assert envelope["error"]["details"] == {"field": "query"}
    assert envelope["error"]["request_id"] == "req-1"
