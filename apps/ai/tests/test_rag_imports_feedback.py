"""`POST /ai/v1/rag/retrieve`, `POST /ai/v1/imports/extract`, `POST /ai/v1/feedback`.

RAG is DB-only: offline it honestly returns zero chunks (never invented text). The import
extractor is a service-to-service door gated by `X-Internal-Token` and is **501 when the
token is unconfigured — never an open door** (D7); it always labels its proposals degraded
so a human reviews each one (§22). Feedback writes only the AI-owned table.
"""

from __future__ import annotations

from uuid import UUID

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings


def test_rag_offline_returns_no_invented_chunks(client):
    r = client.post("/ai/v1/rag/retrieve", json={"query": "signature milk tea"})
    assert r.status_code == 200
    body = r.json()
    assert body["chunks"] == []  # no corpus offline -> no fabricated answer text
    assert body["threshold_applied"] is True
    assert "note" in body


def test_rag_validates_request(client):
    assert client.post("/ai/v1/rag/retrieve", json={"nope": 1}).status_code == 422


def test_imports_closed_door_without_token(client):
    r = client.post("/ai/v1/imports/extract",
                    json={"source_type": "text", "raw_text": "招牌奶茶 48元"})
    assert r.status_code == 501  # token unconfigured => closed, not open (D7)
    assert r.json()["error"]["code"] == "ai_unavailable"


def _tokened_client():
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="sekrit-token")
    return TestClient(create_app(settings))


def test_imports_rejects_wrong_token():
    with _tokened_client() as c:
        r = c.post("/ai/v1/imports/extract",
                   json={"source_type": "text", "raw_text": "奶茶 48元"},
                   headers={"x-internal-token": "wrong"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_imports_rejects_missing_token():
    with _tokened_client() as c:
        r = c.post("/ai/v1/imports/extract",
                   json={"source_type": "text", "raw_text": "奶茶 48元"})
    assert r.status_code == 401


def test_imports_extracts_grounded_proposals():
    with _tokened_client() as c:
        r = c.post("/ai/v1/imports/extract",
                   json={"source_type": "menu", "raw_text":
                         "招牌奶茶 48元\n行山跑步鞋 HK$699"},
                   headers={"x-internal-token": "sekrit-token"})
    assert r.status_code == 200
    body = r.json()
    assert body["extractor"] == "heuristic-v1"
    assert body["degraded"] is True  # rule-based; a human approves before publish (§22)
    assert body["proposals"]
    for p in body["proposals"]:
        assert {"kind", "name", "confidence", "source_span"} <= set(p)
        assert 0.0 <= p["confidence"] <= 1.0
        start, end = p["source_span"]
        assert 0 <= start < end  # a real span into the input, never an invented value


def test_feedback_offline_records_nothing(client):
    r = client.post("/ai/v1/feedback",
                    json={"subject_type": "merchant", "subject_id": str(UUID(int=1)),
                          "signal": "view", "value": {"dwell_ms": 3200}})
    assert r.status_code == 200
    body = r.json()
    assert body["recorded"] is False
    assert body["degraded"] is True
    assert "reason" in body


def test_feedback_validates_schema(client):
    assert client.post("/ai/v1/feedback", json={"signal": "view"}).status_code == 422
