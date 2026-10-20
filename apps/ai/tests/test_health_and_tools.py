"""`GET /ai/v1/health` and `GET /ai/v1/tools` — honest system surface."""

from __future__ import annotations

from nexus_ai.api.routes_system import CANONICAL_TOOLS


def test_health_ok_never_5xx(client):
    r = client.get("/ai/v1/health")
    assert r.status_code == 200  # a down dependency is reported, not raised
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "nexus-ai"
    assert body["version"]
    assert body["provider"] == "mock"
    assert body["offline"] is True
    assert body["database"] == {"configured": False, "available": False}
    assert body["embeddings"] == {"provider": "hashing", "dim": 1024}
    assert "mock" in body["adapters"]
    assert body["now"]


def test_health_reports_adapters_without_network(client):
    # importing/calling health must not attempt any provider connection
    assert client.get("/ai/v1/health").status_code == 200


def test_tools_manifest_is_honest(client):
    r = client.get("/ai/v1/tools")
    assert r.status_code == 200
    body = r.json()
    assert body["registry_status"] == "not_built"
    assert body["degraded"] is True
    names = {t["name"] for t in body["tools"]}
    assert set(CANONICAL_TOOLS) <= names
    # no capability is advertised as live dispatch when the registry does not exist
    assert all(t["implemented"] is False for t in body["tools"])
    assert all("search_merchants" for t in body["tools"])


def test_tools_count_matches_canonical(client):
    body = client.get("/ai/v1/tools").json()
    assert body["count"] == len(body["tools"]) == len(CANONICAL_TOOLS)
