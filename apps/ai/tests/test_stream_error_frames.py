"""D455 - the two SSE error frames were hand-built, and they disagreed.

The search stream and the merchant-agent chat are two surfaces that answer the same
question - "what broke?" - and they answered it differently:

    the search stream:  "ai_unavailable" when the model layer or the database was
                        unreachable, "internal" for anything else
    the merchant chat:  "internal", whatever broke

So the same kind of failure got two different codes depending on which stream the client
was talking to, and a client that retries on "ai_unavailable" (the code the contract
gives for "try again") would not retry the chat. Both frames were also written by hand,
which is the §438 class: a shape that is written once and copied is a shape that drifts,
and the copy still looks right.

So the frame is built in ONE place, from the contract's own error body, and the code
follows ONE rule - and this gate walks both surfaces to say so.
"""

from __future__ import annotations

import ast
import json
import os
import uuid
from pathlib import Path

import pytest

from nexus_ai.contract import ErrorBody

PACKAGE = Path(__file__).resolve().parents[1] / "nexus_ai"
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

MERCHANT = str(uuid.UUID("66666666-6666-6666-6666-666666666666"))
CONVERSATION = str(uuid.UUID("77777777-7777-7777-7777-777777777777"))


def _client():
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    return TestClient(create_app(settings))


def _frames(client, path: str, body: dict) -> list[dict]:
    with client.stream("POST", path, json=body) as resp:
        assert resp.status_code == 200, resp.status_code
        frames = []
        for line in resp.iter_lines():
            if line.startswith("data:"):
                frames.append(json.loads(line[len("data:"):].strip()))
    return frames


def test_no_module_hand_builds_an_sse_error_frame():
    # the census: the frame is built in ONE place (api/errors.py), and the frame's own
    # shape is the contract's error body
    offenders = []
    for path in sorted((PACKAGE / "api").rglob("*.py")):
        if path.name == "errors.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            keys = [k.value for k in node.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)]
            if "code" in keys and "message" in keys:
                offenders.append(f"{path.relative_to(PACKAGE).as_posix()}:{node.lineno}")
    assert not offenders, (
        "these modules hand-build an error frame - the frame is built in one place, from "
        "the contract's own error body, so the two streams cannot disagree about a code "
        "(D455): " + ", ".join(offenders))


def test_the_frame_is_the_contract_s_own_error_body():
    from nexus_ai.api.errors import error_frame

    frame = error_frame(RuntimeError("the retrieval fell over"), request_id="req-1")
    ErrorBody.model_validate(frame)
    assert frame["code"] == "internal"
    assert frame["message"] == "the retrieval fell over"
    assert frame["request_id"] == "req-1"


def test_one_rule_decides_the_code():
    from nexus_ai.api.errors import error_code_for

    assert error_code_for(ConnectionError("the database is unreachable")) == "ai_unavailable"
    assert error_code_for(TimeoutError("the model layer timed out")) == "ai_unavailable"
    assert error_code_for(RuntimeError("the retrieval fell over")) == "internal"


def test_both_streams_answer_the_same_failure_the_same_way(monkeypatch):
    # the search stream: the retrieval is broken on purpose
    import nexus_ai.api.stream as stream_module

    async def _boom(*_args, **_kwargs):
        raise ConnectionError("the model layer is unreachable")

    monkeypatch.setattr(stream_module, "run_search", _boom)

    with _client() as c:
        frames = _frames(c, "/ai/v1/search/stream", {"query": "coffee", "limit": 3})

    errors = [f for f in frames if "code" in f]
    assert errors, f"the stream did not fail: {frames}"
    frame = errors[-1]
    ErrorBody.model_validate(frame)
    assert frame["code"] == "ai_unavailable", (
        f"an unreachable dependency answered {frame['code']!r} - the code that means "
        f"'try again' is the one a client retries on")


@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_merchant_chat_answers_the_same_failure_the_same_way(monkeypatch):
    # the merchant chat: the same failure, through the other stream
    import nexus_ai.api.routes_rag as rag

    async def _boom(*_args, **_kwargs):
        raise ConnectionError("the database is unreachable")

    monkeypatch.setattr(rag, "retrieve_chunks", _boom)

    with _client() as c:
        frames = _frames(c, "/ai/v1/merchant-agent/chat", {
            "merchant_id": MERCHANT, "message": "what are your opening hours?",
            "conversation_id": CONVERSATION})

    errors = [f for f in frames if "code" in f]
    assert errors, f"the chat did not fail: {frames}"
    frame = errors[-1]
    ErrorBody.model_validate(frame)
    assert frame["code"] == "ai_unavailable", (
        f"the chat answered {frame['code']!r} for the failure the search stream answers "
        f"'ai_unavailable' - the same failure must get the same code")
