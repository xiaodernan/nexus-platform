"""D1502 — the real-facts HTTP door: guarded, mock-inert, no LLM tokens."""

from __future__ import annotations

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings


def _client(provider="mock"):
    return TestClient(create_app(Settings(
        llm_provider=provider, llm_base_url="https://api.aizzz.xyz/v1",
        llm_api_key="sk-test", embedding_provider="hashing",
        database_url="", internal_token="",
    )))


def test_mock_mode_is_inert():
    with _client() as c:
        r = c.post("/ai/v1/world/web-facts", json={"query": "Happy Valley"})
        assert r.status_code == 200
        body = r.json()
        assert body["degraded"] is True
        assert body["reason"] == "mock_provider"
        assert body["results"] == []


def test_empty_query_is_refused():
    with _client("openai") as c:
        r = c.post("/ai/v1/world/web-facts", json={"query": "   "})
        assert r.status_code == 200
        assert r.json()["reason"] == "invalid_query"
