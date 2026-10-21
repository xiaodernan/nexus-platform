"""`POST /ai/v1/query/understand`, `/ai/v1/recommend`, `/ai/v1/compare` (§7).

The compare test is the honesty one: a cell may only carry a value that resolves to a
fact, and where no fact exists the cell is null — never an invented number.
"""

from __future__ import annotations

from uuid import UUID

from nexus_ai.contract import EntityCard, Intent, RecommendResponse, UnderstandResponse


def test_understand_returns_strict_intent(client):
    r = client.post("/ai/v1/query/understand",
                    json={"query": "cheap family dinner under 100 in sha tin tonight"})
    assert r.status_code == 200
    body = r.json()
    UnderstandResponse.model_validate(body)
    # D466: the answer IS the intent (the contract's §7 row), so the intent's own fields
    # validate against §7.1's model - and the three service extras ride at the root.
    Intent.model_validate({k: v for k, v in body.items() if k in Intent.model_fields})
    assert body["provider"] in ("mock", "rules")
    assert isinstance(body["degraded"], bool)


def test_understand_rejects_empty_query(client):
    r = client.post("/ai/v1/query/understand", json={"query": "   "})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_recommend_shape_and_citations(client):
    r = client.post("/ai/v1/recommend", json={"query": "quiet dinner sha tin", "limit": 3})
    assert r.status_code == 200
    body = r.json()
    RecommendResponse.model_validate(body)
    UUID(body["set_id"])
    UUID(body["agent_run_id"])
    assert body["cost_usd"] == 0.0
    for item in body["items"]:
        EntityCard.model_validate(item)
    assert body["summary"]
    for cid in body["citations"]:
        UUID(cid)


def test_recommend_needs_intent_or_query(client):
    r = client.post("/ai/v1/recommend", json={"limit": 3})
    assert r.status_code == 422
    assert "intent" in r.json()["error"]["message"] or "query" in r.json()["error"]["message"]


def test_recommend_requires_valid_intent(client):
    r = client.post("/ai/v1/recommend", json={"intent": {"raw_query": "x", "bogus": 1}})
    assert r.status_code == 422  # strict Intent: extra field is a hard reject


def _two_subject_ids(client):
    items = client.post("/ai/v1/search", json={"query": "restaurant"}).json()["items"]
    return [i["id"] for i in items[:2]]


def test_compare_grid_and_subjects(client):
    ids = _two_subject_ids(client)
    assert len(ids) == 2
    r = client.post("/ai/v1/compare", json={"subject_ids": ids})
    assert r.status_code == 200
    body = r.json()
    assert body["subjects"] == ids
    assert body["source"] == "static"  # offline demo path
    assert body["degraded"] is True
    attrs = {row["attribute"] for row in body["rows"]}
    assert {"price", "rating"} <= attrs
    for row in body["rows"]:
        for cell in row["cards"]:
            assert set(cell) == {"value", "fact_id", "source", "observed_at", "confidence"}


def test_compare_never_fabricates_values(client):
    ids = _two_subject_ids(client)
    body = client.post("/ai/v1/compare", json={"subject_ids": ids}).json()
    # §4: the *values a user trusts* (price/hours/rating/availability/district) must
    # resolve to a fact. `category` is a structural listing field, not a trust fact.
    trust_attributes = {"price", "rating", "open_state", "district"}
    for row in body["rows"]:
        for cell in row["cards"]:
            if cell["value"] is not None:
                if row["attribute"] in trust_attributes:
                    assert cell["fact_id"], f"fabricated value in {row['attribute']}"
                    assert cell["source"] and cell["confidence"] is not None
            else:
                assert cell["fact_id"] is None  # an empty cell carries no phantom fact


def test_compare_validates_subject_count(client):
    one = _two_subject_ids(client)[:1]
    assert client.post("/ai/v1/compare", json={"subject_ids": one}).status_code == 422
    bad = client.post("/ai/v1/compare", json={"subject_ids": ["nope", "also-nope"]})
    assert bad.status_code == 422
