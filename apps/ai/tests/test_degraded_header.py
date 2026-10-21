"""D451/D459 - a degraded answer must say so in the header, not only in the body.

OBSERVABILITY.md §2: *"If `status='fallback'` the row must say which rung of the §105 ladder
was used, and the response carried `X-Nexus-Degraded` plus the UI '降級模式' badge. A
degraded answer that looks like a normal answer is an observability failure even when the
request returned 200."*

The search set the header from its own response; the recommendation and the intent
extraction carried a `degraded` field and set no header at all. The middleware set the
header when the BACKEND was degraded, which is a different signal - the answer can be
degraded while the backend is perfectly fine (the model layer fell back to the rules).

D452 widened the fix to the three endpoints the first census missed (the feedback, the
conversation timeline, the tool manifest).

D459 widened it to the seventh: the COMPARISON. The D452 census never reached it - the
probe's request was invalid (the comparison needs at least two subjects), so it answered 422
and the endpoint was never measured - and a degraded comparison looked exactly like a normal
one.

And the gate now CENSORS the surface instead of listing the paths somebody remembered: it
walks the application's own OpenAPI document - the surface a client can actually see - asks
every route, and requires every route that answers with a `degraded` field to be listed in
COVERED and to carry the header.
"""

from __future__ import annotations

import os
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.nlu import lexicon as L

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: the query comes from the product's own vocabulary - a hand-typed CJK code point is not a
#: reference (D409, D446)
RAMEN = L.CUISINE_TERMS["japanese"][5]
CONVERSATION = "77777777-7777-7777-7777-777777777777"

#: the comparison needs at least two subjects - that is the request model's own rule, and
#: it is why the D452 census never reached this endpoint: its probe sent one
COMPARE_SUBJECTS = [str(uuid.UUID(int=7)), str(uuid.UUID(int=8))]

#: The body that reaches each route. The census needs a body for EVERY route it asks, so
#: that "the route could not be reached" never hides "the route answered wrong".
PROBE_BODIES = {
    "/ai/v1/search": {"query": RAMEN, "limit": 3},
    "/ai/v1/recommend": {"query": RAMEN, "limit": 3},
    "/ai/v1/query/understand": {"query": RAMEN, "context": {}},
    "/ai/v1/feedback": {"subject_type": "merchant", "signal": "click"},
    "/ai/v1/compare": {"subject_ids": COMPARE_SUBJECTS},
    "/ai/v1/rag/retrieve": {"query": RAMEN, "filters": {}, "top_k": 2},
    "/ai/v1/search/stream": {"query": RAMEN, "limit": 3},
    "/ai/v1/merchant-agent/chat": {"merchant_id": str(uuid.UUID(int=7)), "message": RAMEN},
}

#: The routes that answer with a `degraded` field. Every one of them must carry the
#: header, and the census below says when a route answers with the field and is not here.
COVERED = {
    "/ai/v1/search",
    "/ai/v1/recommend",
    "/ai/v1/query/understand",
    "/ai/v1/feedback",
    "/ai/v1/compare",
    "/ai/v1/tools",
    "/ai/v1/conversations/{conversation_id}",
}


@pytest.fixture
def client():
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        yield c


def _request(client, method: str, path: str, body):
    if method == "GET":
        return client.get(path)
    if body is None:
        return client.post(path)
    return client.post(path, json=body)


def _assert_the_header_agrees(path: str, payload: dict, header: str | None) -> None:
    assert header is not None, (
        f"{path} answered with degraded={payload['degraded']} and NO "
        f"X-Nexus-Degraded header - a degraded answer that looks like a normal "
        f"answer is an observability failure even when the request returned 200")
    assert header == ("true" if payload["degraded"] else "false"), (
        f"{path} says degraded={payload['degraded']} in the body and {header!r} in the "
        f"header - the two must agree")


def test_every_degraded_answer_says_so_in_the_header(client, monkeypatch):
    # The route's OWN header. The middleware writes the header too when the BACKEND is
    # degraded (the offline demo answers every question from the demo catalogue), and that
    # would mask a route that says nothing - so the backend's signal is switched off here
    # and measured on its own below. Without this, the gate would pass in the offline mode
    # whatever the route did, and fail only on the live plane: a gate whose power depends
    # on the environment is a gate that is green for the wrong reason.
    monkeypatch.setattr(client.app.state.deps, "backend_degraded", lambda: False)
    for path in sorted(COVERED):
        concrete = path.replace("{conversation_id}", CONVERSATION)
        body = PROBE_BODIES.get(path)
        method = "GET" if body is None else "POST"
        r = _request(client, method, concrete, body)
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
        payload = r.json()
        if "degraded" not in payload:
            continue
        _assert_the_header_agrees(path, payload, r.headers.get("x-nexus-degraded"))


def test_the_backends_own_degradation_says_so_too(client):
    # The other half of the header: when the backend is degraded (the offline demo
    # catalogue), every answer is degraded - whatever the route thought. The health
    # endpoint never sets the header itself, so it is the clean probe. On the live plane
    # the backend is healthy, and the health endpoint says nothing about its own answer.
    degraded = client.app.state.deps.backend_degraded()
    r = client.get("/ai/v1/health")
    header = r.headers.get("x-nexus-degraded")
    if degraded:
        assert header == "true", (
            "the backend is answering from the demo catalogue, so the header must say so "
            "- the backend being down degrades every answer, whatever the route said "
            "about its own")
    else:
        assert header in (None, "false"), (
            f"the backend is live and the health endpoint answered {header!r} - the "
            f"backend's own degradation must not be reported when there is none")


def test_the_header_is_present_even_when_the_answer_is_healthy(client):
    # the header is not only for the degraded case: a client that reads the header has to
    # be able to read "false" too, or it cannot tell "not degraded" from "not reported".
    r = client.post("/ai/v1/search", json={"query": RAMEN, "limit": 3})
    assert "x-nexus-degraded" in r.headers, (
        "the header is missing from a healthy answer - a client cannot tell "
        "'not degraded' from 'not reported'")
    assert r.headers["x-nexus-degraded"] == ("true" if r.json()["degraded"] else "false")


def test_the_census_covers_every_route_that_answers_with_a_degraded_field(client):
    # D459: the gate that found the comparison missed it - its table was a list of the
    # paths somebody remembered, and the remembered list was wrong. So the census now walks
    # the application's own OpenAPI document (the surface a client can see) and asks every
    # route: a route that answers with a `degraded` field has to be in COVERED, or
    # COVERED is incomplete.
    uncovered = []
    for path, operations in client.app.openapi()["paths"].items():
        for method in sorted(set(operations) & {"get", "post"}):
            concrete = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
            body = PROBE_BODIES.get(path)
            r = _request(client, method.upper(), concrete, body)
            if r.status_code != 200:
                continue
            if "json" not in r.headers.get("content-type", ""):
                continue  # a stream: the frames carry the flag, not the header
            try:
                payload = r.json()
            except ValueError:  # pragma: no cover - a JSON content type that is not JSON
                continue
            if not isinstance(payload, dict) or "degraded" not in payload:
                continue
            if path not in COVERED:
                uncovered.append(f"{method.upper()} {path}")
                continue
            _assert_the_header_agrees(path, payload, r.headers.get("x-nexus-degraded"))
    assert not uncovered, (
        "these routes answer with a `degraded` field and are not covered by the census - "
        "the list is the paths somebody remembered, and the remembered list is how the "
        "comparison was missed (D459): " + ", ".join(uncovered))
