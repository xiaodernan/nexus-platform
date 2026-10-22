"""Contract tests for the app factory's surface (``api/app``, §1/§7/§105).

`create_app()` is the one seam that wires every §7 route, the request-id middleware and the
error-envelope handlers. These tests pin the *surface* — the route set, the envelope shape, and
the offline-degrade header — not the handlers' internals. The app builds with no env and no
network (the DB pool opens best-effort and stays None offline).

Every assertion was confirmed against the running app (empirical probe), never guessed.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.api.deps import Deps
from nexus_ai.api import runs

#: The §7 surface the frontend/platform code against. This is a *subset* check: adding a route is
#: a feature, dropping one of these is a regression.
REQUIRED_PATHS = {
    "/",
    "/ai/v1/compare",
    "/ai/v1/conversations/{conversation_id}",
    "/ai/v1/feedback",
    "/ai/v1/health",
    "/ai/v1/merchant-agent/chat",
    "/ai/v1/query/understand",
    "/ai/v1/rag/retrieve",
    "/ai/v1/recommend",
    "/ai/v1/search",
    "/ai/v1/search/stream",
    "/ai/v1/tools",
}


class TestEnvelope:
    def test_shape_and_status(self):
        resp = A._envelope("validation_error", "bad", status=422)
        assert resp.status_code == 422
        body = resp.body.decode()
        assert '"code":"validation_error"' in body
        assert '"message":"bad"' in body
        assert '"details":{}' in body
        assert '"request_id":null' in body

    def test_details_and_request_id_carried(self):
        resp = A._envelope("internal", "boom", details={"x": 1},
                           request_id="req-1", status=500)
        body = resp.body.decode()
        assert '"details":{"x":1}' in body
        assert '"request_id":"req-1"' in body

    def test_request_id_falls_back_to_context(self):
        runs.set_request_id("ctx-id")
        try:
            body = A._envelope("internal", "boom", status=500).body.decode()
            assert '"request_id":"ctx-id"' in body
        finally:
            runs.set_request_id("")


class TestJsonableErrors:
    def test_loc_is_stringified(self):
        out = A._jsonable_errors([{"loc": ("body", "x"), "msg": "req", "type": "missing"}])
        assert out == [{"loc": ["body", "x"], "msg": "req", "type": "missing"}]

    def test_missing_fields_are_safe(self):
        out = A._jsonable_errors([{}])
        assert out == [{"loc": [], "msg": "", "type": None}]


class TestAppSurface:
    def test_create_app_returns_fastapi_with_deps(self):
        app = A.create_app()
        assert isinstance(app, FastAPI)
        assert app.title == "NEXUS AI service"
        assert app.version == "0.1.0"
        assert isinstance(app.state.deps, Deps)

    def test_required_routes_present(self):
        # every §7 surface the frontend codes against must be present; extra routes are fine
        paths = set(A.create_app().openapi()["paths"].keys())
        assert REQUIRED_PATHS <= paths


class TestRootAndDegradeHeaders:
    def test_root_payload(self):
        with TestClient(A.create_app()) as client:
            resp = client.get("/")
        assert resp.status_code == 200
        assert resp.json() == {"service": "nexus-ai", "docs": "/docs",
                               "health": "/ai/v1/health"}

    def test_request_id_and_degraded_headers(self):
        with TestClient(A.create_app()) as client:
            resp = client.get("/")
        assert resp.headers.get("x-request-id")
        # offline (no DB) -> the response says so
        assert resp.headers.get("x-nexus-degraded") == "true"

    def test_validation_error_uses_the_envelope(self):
        with TestClient(A.create_app()) as client:
            resp = client.post("/ai/v1/search", json={"limit": "not-an-int"})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "validation_error"
