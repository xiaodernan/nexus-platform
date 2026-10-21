"""D468 - every SSE frame's payload is one contract model's shape.

The frames' payloads were hand-built dicts: the search stream's `results`, `summary` and
`done` frames and the merchant chat's `status`, `summary` and `done` frames all spelled their
fields out in the route, with no model and no gate - the JSON answers had models (D467), the
SSE frames did not.

This gate reads both streams and requires every frame's payload to be EXACTLY one contract
model's fields - the models are read out of the contract module, not listed here, so a model
added later is covered without touching this file.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from pydantic import BaseModel

from nexus_ai import contract as contract_module
from nexus_ai.api.app import create_app
from nexus_ai.api.sse import parse_frames
from nexus_ai.config import Settings

MERCHANT = "66666666-6666-6666-6666-666666666666"
CONVERSATION = "66666666-6666-6666-6666-666666666666"


def _models() -> dict[str, type[BaseModel]]:
    return {
        name: obj
        for name, obj in vars(contract_module).items()
        if isinstance(obj, type) and issubclass(obj, BaseModel)
        and obj.__module__ == contract_module.__name__
    }


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def _search_frames(c: TestClient) -> list[tuple[str, Any]]:
    r = c.post("/ai/v1/search/stream", json={"query": "cheap quiet dinner in mong kok"})
    assert r.status_code == 200, r.text
    return parse_frames(r.text)


def _chat_frames(c: TestClient) -> list[tuple[str, Any]]:
    r = c.post("/ai/v1/merchant-agent/chat", json={
        "merchant_id": MERCHANT, "message": "coffee",
        "conversation_id": CONVERSATION})
    assert r.status_code == 200, r.text
    return parse_frames(r.text)


def test_the_contract_module_has_the_frame_models_the_gate_expects():
    models = _models()
    for expected in ("StreamStatusFrame", "StreamResultsFrame", "StreamSummaryFrame",
                     "StreamDoneFrame", "Intent", "ErrorBody"):
        assert expected in models, (
            f"the contract module has no {expected} - the gate reads the models out of the "
            f"module, so a renamed or removed model changes what the gate can see: "
            f"{sorted(models)}")


def test_every_frame_is_exactly_one_contract_models_shape():
    models = _models()
    with _client() as c:
        streams = {"the search stream": _search_frames(c), "the merchant chat": _chat_frames(c)}
    for label, frames in streams.items():
        assert frames, f"{label} emitted no frame"
        for name, data in frames:
            keys = set(data)
            matching = [model for model, obj in models.items()
                        if set(obj.model_fields) == keys]
            assert len(matching) == 1, (
                f"{label}: the {name!r} frame carries the fields {sorted(keys)}, which match "
                f"{len(matching)} contract models ({matching}) - a frame's payload must be "
                f"ONE model's fields, or the model does not describe the frame")


def test_the_frames_still_carry_the_fields_the_contract_names():
    with _client() as c:
        for name, data in _search_frames(c):
            if name == "status":
                assert set(data) == {"stage", "text"}
            elif name == "results":
                assert set(data) == {"set_id", "items"}
            elif name == "summary":
                assert set(data) == {"text", "citations"}
            elif name == "done":
                assert set(data) == {"agent_run_id", "latency_ms", "cost_usd",
                                     "degraded", "provider"}
            elif name == "intent":
                # the intent frame's payload IS the intent (the SDK's mapper reads it
                # that way); the cross-lane AiIntentEvent still promises a wrapper - filed
                assert "raw_query" in data and isinstance(data.get("intent"), str)
            else:
                assert name == "error", f"an unexpected frame: {name!r}"


def test_the_chats_frames_carry_the_same_shapes():
    with _client() as c:
        frames = _chat_frames(c)
    names = [name for name, _ in frames]
    assert "summary" in names and "done" in names, names
    for name, data in frames:
        if name == "status":
            assert set(data) == {"stage", "text"}
        elif name == "summary":
            assert set(data) == {"text", "citations"}
        elif name == "done":
            assert set(data) == {"agent_run_id", "latency_ms", "cost_usd",
                                 "degraded", "provider"}


def test_the_chat_needs_no_merchant_id_that_is_not_a_uuid():
    # the gate's own request must be a valid client request (a 422 would be a probe that
    # measured nothing - the D452 lesson)
    with _client() as c:
        r = c.post("/ai/v1/merchant-agent/chat", json={
            "merchant_id": str(uuid.uuid4()), "message": "coffee",
            "conversation_id": CONVERSATION})
        assert r.status_code == 200, r.text
