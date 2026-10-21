"""D466 - the answer to `query/understand` IS the intent, and the cross-lane type says so.

The contract's §7 row says `{query, context}` -> `Intent` (below); §7.1 is the intent's
shape; the cross-lane `Intent` interface (`packages/types/src/intent.ts`) carries the same
fields; the SDK types the call `queryUnderstand(): Promise<Intent>`; and the web lane's own
mock of this endpoint returns a bare intent.

The service answered with a WRAPPER - `{intent: {...}, provider, degraded, follow_up_question}` -
so every client that followed the contract or the SDK read `raw_query` and got `undefined`,
and read `intent` (the KIND) and got an object. The answer is the intent now, with the
service's three extras at the root.

This gate reads the cross-lane interface and requires the answer to carry every field the
interface declares as REQUIRED - so the two copies of the shape cannot drift apart again
without a test failing.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

#: The service's three extras, which ride at the root beside the intent's fields.
SERVICE_EXTRAS = ("provider", "degraded", "follow_up_question")


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "data" / "seed" / "generate.py").exists():
            return parent
    raise AssertionError("the repository root was not found from this file")


def _required_fields() -> list[str]:
    """The fields the cross-lane `Intent` interface declares as required (no `?`)."""
    text = (_repo_root() / "packages" / "types" / "src" / "intent.ts").read_text(
        encoding="utf-8")
    block = re.search(r"export interface Intent \{(.*?)\n\}", text, re.S)
    if block is None:
        raise AssertionError("the cross-lane Intent interface was not found")
    fields: list[str] = []
    for line in block.group(1).splitlines():
        match = re.match(r"\s{2}([a-z_]+)\??:", line)
        if match and "?" not in match.group(0):
            fields.append(match.group(1))
    return fields


def _answer() -> dict:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/query/understand",
                   json={"query": "coffee", "context": {"locale": "zh-HK"}})
        assert r.status_code == 200, r.text
        return r.json()


def test_the_cross_lane_interface_declares_the_fields_we_expect():
    fields = _required_fields()
    for expected in ("raw_query", "intent", "category", "location", "time", "budget",
                     "party_size", "preferences", "constraints", "sort_preference",
                     "urgency", "language", "confidence", "unknowns"):
        assert expected in fields, (
            f"the cross-lane Intent interface no longer declares {expected!r}: {fields} - "
            f"the parser or the type changed, and a gate that reads the wrong list proves "
            f"nothing")


def test_the_answer_carries_every_required_field_at_the_root():
    body = _answer()
    missing = [f for f in _required_fields() if f not in body]
    assert not missing, (
        "the answer does not carry these fields of the intent at its root: "
        + ", ".join(missing) + " - the contract's §7 row says the answer IS the Intent, and a "
        "client that reads the contract must find them")


def test_the_answer_does_not_nest_the_intent():
    body = _answer()
    assert isinstance(body.get("intent"), str), (
        f"the answer's `intent` is {type(body.get('intent')).__name__}, not a kind string - "
        f"the intent is NESTED under `intent`, so a client that follows the cross-lane type "
        f"(where `intent` is the KIND) reads an object where it expects a string")
    assert "raw_query" in body, (
        "the answer has no `raw_query` at its root - the intent is nested somewhere else")


def test_the_service_extras_ride_at_the_root():
    body = _answer()
    for extra in SERVICE_EXTRAS:
        assert extra in body, f"the answer lost the service's {extra!r} at the root"
    assert body["provider"] in ("mock", "rules")
    assert isinstance(body["degraded"], bool)


def test_the_intent_fields_still_validate_against_the_contract_model():
    from nexus_ai.contract import Intent

    body = _answer()
    Intent.model_validate({k: v for k, v in body.items() if k in Intent.model_fields})
