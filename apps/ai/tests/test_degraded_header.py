"""D451 - a degraded answer must say so in the header, not only in the body.

OBSERVABILITY.md §2: *"If `status='fallback'` the row must say which rung of the §105 ladder
was used, and the response carried `X-Nexus-Degraded` plus the UI '降級模式' badge. A
degraded answer that looks like a normal answer is an observability failure even when the
request returned 200."*

The search set the header from its own response; the recommendation and the intent
extraction carried a `degraded` field and set no header at all. The middleware set the
header when the BACKEND was degraded, which is a different signal - the answer can be
degraded while the backend is perfectly fine (the model layer fell back to the rules).

So this walks every endpoint that answers with a `degraded` field and requires the header to
agree with it.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.nlu import lexicon as L

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: the query comes from the product's own vocabulary - a hand-typed CJK code point is not a
#: reference (D409, D446)
RAMEN = L.CUISINE_TERMS["japanese"][5]

#: the endpoints that answer with a `degraded` field
ENDPOINTS = [
    ("/ai/v1/search", {"query": RAMEN, "limit": 3}),
    ("/ai/v1/recommend", {"query": RAMEN, "limit": 3}),
    ("/ai/v1/query/understand", {"query": RAMEN, "context": {}}),
]


@pytest.fixture
def client():
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        yield c


def test_every_degraded_answer_says_so_in_the_header(client):
    for path, body in ENDPOINTS:
        r = client.post(path, json=body)
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
        payload = r.json()
        if "degraded" not in payload:
            continue
        header = r.headers.get("x-nexus-degraded")
        assert header is not None, (
            f"{path} answered with degraded={payload['degraded']} and NO "
            f"X-Nexus-Degraded header - a degraded answer that looks like a normal "
            f"answer is an observability failure even when the request returned 200")
        assert header == ("true" if payload["degraded"] else "false"), (
            f"{path} says degraded={payload['degraded']} in the body and {header!r} in the "
            f"header - the two must agree")


def test_the_header_is_present_even_when_the_answer_is_healthy(client):
    # the header is not only for the degraded case: a client that reads the header has to
    # be able to read "false" too, or it cannot tell "not degraded" from "not reported".
    r = client.post("/ai/v1/search", json={"query": RAMEN, "limit": 3})
    assert "x-nexus-degraded" in r.headers, (
        "the header is missing from a healthy answer - a client cannot tell "
        "'not degraded' from 'not reported'")
    assert r.headers["x-nexus-degraded"] == ("true" if r.json()["degraded"] else "false")
