"""D877 — the AI's actuator shim speaks the Spring Boot Admin protocol, nothing more.

The AI service is Python; Spring Boot Admin is Spring. The only shared surface either side
may touch is /actuator: health (the status shape) and info (what this is). Anything more,
Spring Boot Admin or the executor injects, does not exist here by design.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing", database_url="")
    return TestClient(create_app(settings))


def test_actuator_health_is_the_spring_boot_admin_shape():
    with _client() as client:
        response = client.get("/actuator/health", follow_redirects=False)
    assert response.status_code == 200
    body = response.json()
    assert body.get("status") == "UP"
    assert "groups" in body


def test_actuator_info_names_the_stack():
    with _client() as client:
        response = client.get("/actuator/info")
    assert response.status_code == 200
    body = response.json()
    app = body.get("app", {})
    assert app.get("name") == "nexus-ai"
    assert app.get("stack") == "fastapi"


def test_actuator_index_links_only_health_and_info():
    with _client() as client:
        response = client.get("/actuator")
    assert response.status_code == 200
    links = response.json().get("_links", {})
    assert set(links) == {"health", "info"}
    assert links["health"]["href"] == "/actuator/health"
