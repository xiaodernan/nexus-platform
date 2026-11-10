"""D884 — the FastAPI service receives W3C trace context without inventing any of its own."""

from __future__ import annotations

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.api.tracing import parse_traceparent
from nexus_ai.config import Settings

VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT = "00f067aa0ba902b7"


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing", database_url="")
    return TestClient(create_app(settings))


def test_a_valid_traceparent_parses_into_its_three_fields():
    assert parse_traceparent(VALID) == {
        "trace_id": TRACE, "parent_id": PARENT, "flags": "01",
    }
    assert parse_traceparent("  " + VALID + "  ") is not None


def test_a_malformed_or_all_zero_traceparent_is_refused():
    for bad in (None, "", "nonsense", VALID.upper(), VALID + "-extra",
                "01-" + TRACE + "-" + PARENT + "-01",
                "00-" + "0" * 32 + "-" + PARENT + "-01",
                "00-" + TRACE + "-" + "0" * 16 + "-01"):
        assert parse_traceparent(bad) is None, bad


def test_a_propagated_trace_is_echoed_on_the_response():
    with _client() as client:
        response = client.get("/ai/v1/health", headers={"traceparent": VALID})
    assert response.status_code == 200
    assert response.headers.get("x-trace-id") == TRACE
    assert response.headers.get("x-trace-parent-id") == PARENT


def test_a_request_without_a_trace_gets_no_invented_id():
    with _client() as client:
        response = client.get("/ai/v1/health")
    assert response.status_code == 200
    assert response.headers.get("x-trace-id") is None
    assert response.headers.get("x-trace-parent-id") is None
    # The request id is still minted locally by this service's own middleware.
    assert response.headers.get("x-request-id")


def test_a_malformed_trace_is_not_laundered_into_a_response_header():
    with _client() as client:
        response = client.get("/ai/v1/health", headers={"traceparent": VALID.upper()})
    assert response.status_code == 200
    assert response.headers.get("x-trace-id") is None


def test_the_actuator_info_declares_participant_not_origin():
    with _client() as client:
        body = client.get("/actuator/info").json()
    tracing = body.get("tracing", {})
    assert tracing.get("propagation") == "w3c-traceparent"
    assert tracing.get("role") == "participant"
    assert tracing.get("mints_trace_ids") is False
    assert tracing.get("exports_spans") is False
