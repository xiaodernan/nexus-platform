"""`GET /ai/v1/conversations/{id}` — the D13 agent-run timeline (AI-owned observability only).

The dialogue rows themselves are the platform door's (D20); this endpoint answers from
`agent_runs` (+ the offline in-process ledger) and never touches a commerce write path.
"""

from __future__ import annotations

from uuid import UUID


def test_bad_conversation_id_is_validation_error(client):
    r = client.get("/ai/v1/conversations/not-a-uuid")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_unknown_conversation_returns_empty_timeline(client):
    cid = str(UUID(int=0x1234))
    r = client.get(f"/ai/v1/conversations/{cid}")
    assert r.status_code == 200
    body = r.json()
    assert body["conversation_id"] == cid
    assert body["agent_runs"] == []
    assert body["degraded"] is True
    assert "reason" in body


def test_stream_then_timeline_shows_the_run(client):
    cid = str(UUID(int=0xfeed))
    resp = client.post("/ai/v1/search/stream",
                       json={"query": "sha tin", "conversation_id": cid})
    assert resp.status_code == 200
    body = client.get(f"/ai/v1/conversations/{cid}").json()
    assert body["count"] >= 1
    run = body["agent_runs"][0]
    assert UUID(run["agent_run_id"])
    assert run["status"] == "succeeded"
    assert run["persisted"] is False  # offline -> ledger, honestly flagged
    assert run["degraded"] is True


def test_failed_stream_is_recorded_too(client, monkeypatch):
    import nexus_ai.api.stream as stream_mod

    async def boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(stream_mod, "run_search", boom)
    cid = str(UUID(int=0xbeef))
    client.post("/ai/v1/search/stream", json={"query": "sha tin", "conversation_id": cid})
    body = client.get(f"/ai/v1/conversations/{cid}").json()
    assert body["count"] >= 1
    assert body["agent_runs"][0]["status"] == "failed"
    assert "kaboom" in (body["agent_runs"][0].get("error") or "")


def test_timeline_is_scoped_per_conversation(client):
    a, b = str(UUID(int=0x11)), str(UUID(int=0x22))
    client.post("/ai/v1/search/stream", json={"query": "sha tin", "conversation_id": a})
    assert client.get(f"/ai/v1/conversations/{b}").json()["count"] == 0
    assert client.get(f"/ai/v1/conversations/{a}").json()["count"] >= 1
