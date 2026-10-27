"""Contract tests for the two response helpers (``api/degraded`` and ``api/errors``).

`degraded_json` says whether a response is degraded **in the body and in the header** — the header
is what a client/proxy can read without parsing. `error_response` is the §1 error envelope with the
request id the service is carrying. Both are pure JSONResponse builders; their call sites are
covered through TestClient, the helpers themselves were not.

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import json

from nexus_ai.api.degraded import degraded_json
from nexus_ai.api.errors import error_response


def _body(response) -> dict:
    return json.loads(response.body)


class TestDegradedJson:
    def test_true_sets_the_header_and_keeps_the_body(self):
        r = degraded_json({"degraded": True, "x": 1})
        assert r.status_code == 200
        assert r.headers["x-nexus-degraded"] == "true"
        assert _body(r) == {"degraded": True, "x": 1}

    def test_false_sets_false(self):
        r = degraded_json({"degraded": False})
        assert r.headers["x-nexus-degraded"] == "false"

    def test_absent_means_not_degraded(self):
        r = degraded_json({"x": 1})
        assert r.headers["x-nexus-degraded"] == "false"

    def test_status_is_passed_through(self):
        r = degraded_json({"degraded": False}, status=503)
        assert r.status_code == 503


class TestErrorResponse:
    def test_default_status_and_envelope(self):
        r = error_response("not_found", "no such thing")
        assert r.status_code == 400
        assert _body(r) == {"error": {"code": "not_found", "message": "no such thing",
                                      "details": {}, "request_id": None}}

    def test_details_and_request_id_are_carried(self):
        r = error_response("bad", "msg", details={"field": "x"}, request_id="rid-1", status=422)
        assert r.status_code == 422
        assert _body(r)["error"] == {"code": "bad", "message": "msg",
                                     "details": {"field": "x"}, "request_id": "rid-1"}

    def test_the_code_and_message_are_the_callers(self):
        r = error_response("ai_unavailable", "model is down")
        err = _body(r)["error"]
        assert (err["code"], err["message"]) == ("ai_unavailable", "model is down")
