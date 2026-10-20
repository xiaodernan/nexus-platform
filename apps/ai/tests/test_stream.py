"""`POST /ai/v1/search/stream` — the §7 / D13 canonical event stream.

Asserts: the exact event sequence, the exact stage order, every event's payload schema,
that only canonical names ever appear, that `error` travels *inside* the stream (never an
HTTP 5xx once started), and the §1 validation envelope before the stream begins.
"""

from __future__ import annotations

import re
from uuid import UUID


from nexus_ai.api.sse import CANONICAL_STREAM_EVENTS, parse_frames
from nexus_ai.contract import EntityCard, Intent

EXPECTED_NAMES = ["status", "intent", "status", "status", "results", "status",
                  "summary", "done"]
EXPECTED_STAGES = ["understanding", "searching", "comparing", "summarizing"]
DONE_KEYS = {"agent_run_id", "latency_ms", "cost_usd", "degraded", "provider"}


def _stream(client, query="sha tin", **body):
    r = client.post("/ai/v1/search/stream", json={"query": query, **body})
    assert r.status_code == 200, r.text
    return r, parse_frames(r.text)


def test_stream_headers_are_event_stream(client):
    r, _ = _stream(client)
    assert r.headers["content-type"].startswith("text/event-stream")
    assert "no-store" in r.headers.get("cache-control", "")


def test_event_sequence_is_the_happy_path(client):
    r, frames = _stream(client, "cheap quiet dinner in mong kok")
    assert [n for n, _ in frames] == EXPECTED_NAMES
    assert [d["stage"] for n, d in frames if n == "status"] == EXPECTED_STAGES


def test_only_canonical_names_in_raw_body(client):
    r, _ = _stream(client, "維港 晚餐")
    names = re.findall(r"^event: ([a-z_]+)$", r.text, flags=re.M)
    assert names == EXPECTED_NAMES
    assert set(names) <= CANONICAL_STREAM_EVENTS


def test_status_events_have_only_stage_and_text(client):
    _, frames = _stream(client)
    for n, d in frames:
        if n == "status":
            assert set(d) == {"stage", "text"}
            assert isinstance(d["text"], str) and d["text"]


def test_intent_payload_validates_against_strict_schema(client):
    _, frames = _stream(client, "開到半夜 銅鑼灣 餐廳")
    data = next(d for n, d in frames if n == "intent")
    intent = Intent.model_validate(data)  # extra="forbid" -> drift fails loudly
    assert intent.raw_query
    assert re.fullmatch(r"[A-Za-z_]+", intent.intent)


def test_results_payload_schema_and_cards(client):
    _, frames = _stream(client, "sha tin")
    data = next(d for n, d in frames if n == "results")
    assert set(data) == {"set_id", "items"}
    UUID(data["set_id"])  # must be a uuid
    assert isinstance(data["items"], list)
    assert data["items"], "offline demo catalogue must answer 'sha tin'"
    for item in data["items"]:
        EntityCard.model_validate(item)


def test_summary_payload_shape(client):
    _, frames = _stream(client, "sha tin")
    data = next(d for n, d in frames if n == "summary")
    assert set(data) == {"text", "citations"}
    assert isinstance(data["text"], str) and data["text"]
    assert isinstance(data["citations"], list)
    for cid in data["citations"]:
        UUID(cid)


def test_done_carries_agent_run_id_and_exact_keys(client):
    _, frames = _stream(client, "sha tin")
    done = dict(frames)["done"]
    assert set(done) == DONE_KEYS
    UUID(done["agent_run_id"])
    assert isinstance(done["latency_ms"], int)
    assert done["cost_usd"] == 0.0  # mock provider spends nothing
    assert done["degraded"] is True  # offline demo answers -> honest degrade


def test_offline_body_parses_as_complete_frames(client):
    from nexus_ai.api.sse import assert_canonical_stream

    r, _ = _stream(client, "中環")
    assert_canonical_stream(r.text)  # no stray bytes between frames


def test_error_is_an_event_never_an_http_500(client, monkeypatch):
    import nexus_ai.api.stream as stream_mod

    async def boom(*a, **k):
        raise RuntimeError("search backend exploded")

    monkeypatch.setattr(stream_mod, "run_search", boom)
    r = client.post("/ai/v1/search/stream", json={"query": "sha tin"})
    assert r.status_code == 200  # the stream still starts
    frames = parse_frames(r.text)
    names = [n for n, _ in frames]
    assert names[:3] == ["status", "intent", "status"]
    assert names[-1] == "error"
    assert "done" not in names  # never both error and done
    err = dict(frames)["error"]
    assert set(err) == {"code", "message", "request_id"}
    assert err["code"] == "internal"


def test_connection_error_maps_to_ai_unavailable_code(client, monkeypatch):
    import nexus_ai.api.stream as stream_mod

    async def boom(*a, **k):
        raise ConnectionError("cannot reach provider")

    monkeypatch.setattr(stream_mod, "run_search", boom)
    r = client.post("/ai/v1/search/stream", json={"query": "sha tin"})
    frames = parse_frames(r.text)
    err = dict(frames)["error"]
    assert err["code"] == "ai_unavailable"


def test_empty_query_returns_validation_envelope(client):
    r = client.post("/ai/v1/search/stream", json={"query": "   "})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error"
    assert "request_id" in err


def test_overlong_query_rejected(client):
    r = client.post("/ai/v1/search/stream", json={"query": "x" * 500})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_unknown_field_rejected(client):
    r = client.post("/ai/v1/search/stream", json={"query": "hi", "bogus": 1})
    assert r.status_code == 422


def test_stream_records_run_in_ledger(client):
    conv = str(UUID(int=0xabc))
    client.post("/ai/v1/search/stream", json={"query": "sha tin", "conversation_id": conv})
    j = client.get(f"/ai/v1/conversations/{conv}").json()
    assert j["count"] >= 1
    run = j["agent_runs"][0]
    assert run["agent_run_id"]
    assert run["status"] in ("succeeded", "failed")
    assert run["persisted"] is False  # offline -> in-process ledger only
