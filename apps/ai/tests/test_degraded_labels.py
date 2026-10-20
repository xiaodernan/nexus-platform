"""Every answer surface labels its own degradation — the payloads, not the code.

PLAN.md's P3 asked that "every agent answer must carry `degraded` and its reason when it could not do
the real thing", and to check the live payloads rather than the code. This is that census, pinned as a
test on the plane where the claim is strongest and the verdict is unambiguous: with no database and no
model configured, NOT ONE of these surfaces can be doing the real thing, so every one of them has to
say so in its own payload. A surface that answered `degraded: false` here would be claiming a real
answer it did not give.

Measured on both planes before this test existed, for the record: `search` false/true, `understand`
true/true, `recommend` true/true, `compare` false/true, `imports/extract` true/true, `conversations`
false/true + `reason`, and both streaming `done` events true/true (live/offline). `understand` and
`recommend` read degraded even with a database, because the mock model is not the real thing.

The one surface that carries no boolean is `/ai/v1/rag/retrieve`: API_CONTRACT.md:330 names its shape as
`{chunks:[...]}` and nothing more, so a `degraded` field there would be inventing contract surface
rather than reporting one. It carries a `note` instead, and this file pins that instead — the honest
variant of the same claim, not a waiver of it.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

CONVERSATION_ID = "00000000-0000-0000-0000-0000000000aa"
OTHER_ID = "00000000-0000-0000-0000-0000000000bb"

#: (name, method, path, body) for every answer surface that returns a JSON object.
ANSWER_CALLS = [
    ("search", "POST", "/ai/v1/search", {"query": "sha tin restaurant", "limit": 3}),
    ("understand", "POST", "/ai/v1/query/understand", {"query": "sha tin restaurant"}),
    ("recommend", "POST", "/ai/v1/recommend", {"query": "sha tin restaurant", "limit": 3}),
    ("compare", "POST", "/ai/v1/compare", {"subject_ids": [CONVERSATION_ID, OTHER_ID]}),
    ("imports.extract", "POST", "/ai/v1/imports/extract",
     {"source_type": "text", "source_ref": "test://degraded", "raw_text": "叉燒飯 $45"}),
    ("conversations", "GET", f"/ai/v1/conversations/{CONVERSATION_ID}", None),
]

INTERNAL_TOKEN = "unit-test-internal-token-0123456789"


@pytest.fixture
def tokened_client():
    """Offline, but with the service-to-service token configured, so `/imports/extract` is
    reachable: without it the door answers 501 by design and the surface under test is never
    exercised. Every other setting matches the suite's offline fixture."""
    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing", database_url="",
                        internal_token=INTERNAL_TOKEN)
    with TestClient(create_app(settings)) as c:
        yield c


def _call(client, method, path, body, name):
    headers = {"X-Internal-Token": INTERNAL_TOKEN} if name == "imports.extract" else {}
    if body is None:
        return client.request(method, path, headers=headers)
    return client.request(method, path, json=body, headers=headers)


@pytest.mark.parametrize("name,method,path,body", ANSWER_CALLS,
                         ids=[c[0] for c in ANSWER_CALLS])
def test_every_json_answer_surface_labels_its_degradation(tokened_client, name, method, path, body):
    r = _call(tokened_client, method, path, body, name)
    assert r.status_code == 200, f"{name}: {r.status_code} {r.text[:200]}"
    payload = r.json()
    assert "degraded" in payload, f"{name} answered without a `degraded` field: {sorted(payload)}"
    assert payload["degraded"] is True, (
        f"{name} claims a real answer with no database and no model: degraded={payload['degraded']!r}")


def test_conversations_carries_the_reason_the_contract_asks_for(tokened_client):
    """API_CONTRACT.md:334 names `{..., degraded, reason?}` for this read alone, and `reason` is the
    field that tells an operator why a timeline came from the in-process ledger."""
    body = tokened_client.get(f"/ai/v1/conversations/{CONVERSATION_ID}").json()
    assert body["degraded"] is True
    assert body.get("reason"), f"degraded with no reason: {sorted(body)}"


def _sse_events(text: str) -> dict[str, list]:
    out: dict[str, list] = {}
    for block in text.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" not in fields or "data" not in fields:
            continue
        try:
            out.setdefault(fields["event"], []).append(json.loads(fields["data"]))
        except json.JSONDecodeError:
            continue
    return out


def test_both_streaming_answers_label_their_done_event(tokened_client):
    """`done` is where a stream tells its client whether the answer was real; API_CONTRACT.md:349
    prints it with `degraded` in it."""
    calls = [
        ("search/stream", "/ai/v1/search/stream", {"query": "sha tin restaurant", "limit": 3}),
        ("merchant-agent/chat", "/ai/v1/merchant-agent/chat",
         {"merchant_id": CONVERSATION_ID, "message": "你们几点开门?", "conversation_id": OTHER_ID}),
    ]
    for name, path, body in calls:
        with tokened_client.stream("POST", path, json=body) as r:
            assert r.status_code == 200, name
            events = _sse_events("".join(r.iter_text()))
        done = events.get("done")
        assert done, f"{name} streamed {sorted(events)} with no `done` event"
        assert done[0].get("degraded") is True, f"{name} done={done[0]!r}"


def test_rag_retrieve_says_why_instead_of_claiming_a_real_answer(tokened_client):
    """The contract gives this read no `degraded` field (API_CONTRACT.md:330), so it must not grow
    one here — and it must not return the empty list silently either. Measured offline: `chunks`
    is empty and `note` explains that there is no corpus to search."""
    body = tokened_client.post("/ai/v1/rag/retrieve",
                               json={"query": "sha tin restaurant", "top_k": 3}).json()
    assert body["chunks"] == [], body
    assert "degraded" not in body, "a `degraded` field here is contract surface the document does not name"
    assert body.get("note"), f"an empty chunk list with no explanation: {sorted(body)}"
