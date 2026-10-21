"""D442 - the service-to-service door is absent from the public OpenAPI document.

API_CONTRACT §7.0 says it in one sentence:

    These paths exist only between our own services. The BFF must not proxy them, they are
    absent from the public OpenAPI document, and a request that arrives from an edge is
    rejected for missing the shared secret.

Two of the three held and one did not: the secret stands (D7 - an unconfigured token is a
closed door, and a wrong one is a 401 ✓), but `/ai/v1/imports/extract` was IN the public
OpenAPI document - so a client that reads the document could discover the door and call
it. The document was telling the world where the door is.

So this file checks all three halves: the path is absent from the document, the door is
still closed without the secret, and the door still opens with it.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "data" / "seed" / "generate.py").exists():
            return parent
    raise AssertionError("the repository root was not found from this file")


def _service_to_service_paths() -> list[str]:
    """The paths API_CONTRACT §7.0 names - read from the contract, not hand-kept here.

    A hand-kept list would be the same fact in two places, and the two would drift (D438).
    """
    contract = (_repo_root() / "docs" / "API_CONTRACT.md").read_text(encoding="utf-8")
    start = contract.find("### 7.0")
    assert start != -1, "the contract has no §7.0 section"
    end = contract.find("\n### ", start + 1)
    section = contract[start:end if end != -1 else len(contract)]
    return sorted(set(re.findall(r"`(/[A-Za-z0-9_./{}:-]+)`", section)))


def _client(token: str = "") -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token=token)
    return TestClient(create_app(settings))


def test_the_service_to_service_paths_are_absent_from_the_openapi_document():
    paths = _service_to_service_paths()
    assert paths, "the contract's §7.0 names no path - the rule below would be vacuous"
    with _client() as c:
        doc = c.get("/openapi.json").json()
        listed = set((doc.get("paths") or {}).keys())
        for path in paths:
            assert path not in listed, (
                f"{path} is a service-to-service path and is in the public OpenAPI "
                f"document (§7.0): the document must not tell the world where the door is")


def test_the_door_is_closed_without_the_secret():
    with _client() as c:
        r = c.post("/ai/v1/imports/extract",
                   json={"source_type": "text", "source_ref": "x", "raw_text": "y"})
        assert r.status_code in (401, 501), (
            f"the service-to-service door answered {r.status_code} without the secret")


def test_the_door_opens_with_the_secret():
    token = "s" * 32
    with _client(token) as c:
        r = c.post("/ai/v1/imports/extract",
                   json={"source_type": "text", "source_ref": "x", "raw_text": "y"},
                   headers={"X-Internal-Token": token})
        assert r.status_code == 200, (
            f"the service-to-service door answered {r.status_code} WITH the secret: "
            f"{r.text[:200]}")
        assert r.json().get("proposals") is not None
