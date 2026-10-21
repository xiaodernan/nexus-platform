"""D467 - every answer's shape is a contract model's shape, and only one.

The service's answers were hand-built dicts with a model bolted on afterwards: the search's
route dumped the model and patched three fields onto the dict, the RAG's route patched a
fourth, and two of those patched fields were in NO model at all - so the models did not
describe the answers they stood for, and two surfaces (the comparison, the feedback) answered
with a shape no model declared.

This gate asks every surface that has a model and requires the answer's keys to be EXACTLY
one model's fields - the models are read out of the contract module, not listed here, so a
model added later is covered without touching this file.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from pydantic import BaseModel

from nexus_ai import contract as contract_module
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

#: The surfaces whose answer has a model - asked with a valid request.
PROBES: dict[str, dict[str, Any]] = {
    "/ai/v1/search": {"query": "coffee", "limit": 3},
    "/ai/v1/query/understand": {"query": "coffee", "context": {}},
    "/ai/v1/recommend": {"query": "coffee", "limit": 3},
    "/ai/v1/rag/retrieve": {"query": "coffee", "filters": {}, "top_k": 3},
    "/ai/v1/compare": {"subject_ids": [str(uuid.UUID(int=7)), str(uuid.UUID(int=8))]},
    "/ai/v1/feedback": {"subject_type": "merchant", "signal": "click"},
}

#: The surfaces with NO model, and why. Each one is asked too - and the rule is that its
#: answer must match no model at all, so a surface that grows a model must lose its entry.
NO_MODEL_PROBES: dict[str, tuple[str, str]] = {
    "/ai/v1/health": ("GET", "the diagnostic surface - its shape is the health checker's own"),
    "/ai/v1/tools": ("GET", "the tool manifest - the shape is the registry's own"),
    "/ai/v1/conversations/{conversation_id}": (
        "GET", "the §52 audit view - filed: a model for it belongs with the contract's owner"),
}

#: The surfaces the gate cannot ask: one answers with SSE, one is the service-to-service door.
DECLARED_UNREACHABLE = {
    "/ai/v1/merchant-agent/chat": "the answer is the canonical SSE event set, not a JSON body",
    "/ai/v1/imports/extract": "the service-to-service door (API_CONTRACT §7.0), not a public surface",
}


def _models() -> dict[str, type[BaseModel]]:
    return {
        name: obj
        for name, obj in vars(contract_module).items()
        if name.endswith("Response")
        and isinstance(obj, type)
        and issubclass(obj, BaseModel)
    }


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def test_the_contract_module_has_the_models_the_gate_expects():
    models = _models()
    for expected in ("SearchResponse", "UnderstandResponse", "RecommendResponse",
                     "RagRetrieveResponse", "CompareResponse", "FeedbackResponse"):
        assert expected in models, (
            f"the contract module has no {expected} - the gate reads the models out of the "
            f"module, so a renamed or removed model changes what the gate can see: "
            f"{sorted(models)}")


def test_every_answer_is_exactly_one_contract_models_shape():
    models = _models()
    with _client() as c:
        for path, body in PROBES.items():
            r = c.post(path, json=body)
            assert r.status_code == 200, f"{path} -> {r.status_code} {r.text[:200]}"
            keys = set(r.json())
            matching = [name for name, model in models.items()
                        if set(model.model_fields) == keys]
            assert len(matching) == 1, (
                f"{path} answers with the fields {sorted(keys)}, which match "
                f"{len(matching)} contract models ({matching}) - the answer's shape must be "
                f"ONE model's fields, or the model does not describe the answer")


def test_the_surfaces_with_no_model_match_no_model():
    models = _models()
    with _client() as c:
        for path, (method, reason) in NO_MODEL_PROBES.items():
            concrete = path.replace("{conversation_id}", str(uuid.uuid4()))
            r = c.request(method, concrete)
            assert r.status_code == 200, f"{path} -> {r.status_code} {r.text[:200]}"
            keys = set(r.json())
            matching = [name for name, model in models.items()
                        if set(model.model_fields) == keys]
            assert not matching, (
                f"{path} is declared as having no model ({reason}) but its answer matches "
                f"{matching} - drop the declaration when the model arrives")


def test_the_gate_knows_which_surfaces_it_cannot_ask():
    # the SSE chat and the service-to-service door are not JSON answers; the gate says so
    # rather than skipping them silently
    assert set(DECLARED_UNREACHABLE) == {"/ai/v1/merchant-agent/chat",
                                         "/ai/v1/imports/extract"}
    for reason in DECLARED_UNREACHABLE.values():
        assert reason, "a declared unreachable surface must say why"
