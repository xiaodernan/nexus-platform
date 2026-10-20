"""`POST /ai/v1/search` — the deterministic (non-streaming) §105 fallback target.

Zero LLM calls, so it must answer even when every model provider is down, and every
rendered value must trace to a fact. These tests pin the SearchResponse shape, the
`intent | query` input paths, strict schema rejection, honest degrade, SQL-injection-safe
queries, and the "never fabricate a fact" discipline on the demo catalogue.
"""

from __future__ import annotations

from uuid import UUID

from nexus_ai.contract import EntityCard, SearchResponse


def _search(client, **body):
    r = client.post("/ai/v1/search", json=body)
    return r


def test_search_response_contract_shape(client):
    r = _search(client, query="quiet dinner in sha tin")
    assert r.status_code == 200, r.text
    data = r.json()
    SearchResponse.model_validate(data)  # known fields parse
    assert isinstance(data["items"], list)
    for item in data["items"]:
        EntityCard.model_validate(item)
    assert isinstance(data["took_ms"], int)
    assert data["strategy"]
    assert UUID(data["agent_run_id"])


def test_offline_search_is_degraded_and_headered(client):
    r = _search(client, query="sha tin")
    data = r.json()
    assert data["degraded"] is True  # labelled demo catalogue, never live data
    assert r.headers.get("x-nexus-degraded") == "true"
    assert data["provider"] in ("mock", "rules", "none")


def test_query_and_intent_paths(client):
    by_query = _search(client, query="sha tin", limit=5).json()
    assert by_query["items"]
    full_intent = {
        "raw_query": "sha tin family", "intent": "discover_merchant", "category": None,
        "location": {"type": "district", "value": "sha tin"}, "time": {},
        "budget": None, "party_size": None, "preferences": [], "constraints": [],
        "sort_preference": "relevance", "urgency": "normal", "language": "zh-HK",
        "confidence": {}, "unknowns": [], "mentioned_entities": [], "merchant_id": None,
    }
    by_intent = _search(client, intent=full_intent, limit=5).json()
    assert by_intent["items"]
    assert by_intent["intent"]["location"]["value"] == "sha tin"


def test_extracted_preferences_reach_the_ranking_lane(client):
    """A query that extracts a preference must answer, not 503: the ranking lane reads
    preferences by key, and the contract hands it PreferenceItem models."""
    r = _search(client, query="安静的咖啡店，适合工作，有插座", locale="zh-HK", limit=5)
    assert r.status_code == 200, r.text
    prefs = r.json()["intent"]["preferences"]
    assert prefs, "the query must extract at least one preference, or this test proves nothing"
    assert set(prefs[0]) == {"key", "value", "polarity"}


def test_unknown_top_level_field_rejected(client):
    r = _search(client, query="sha tin", not_a_field=True)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_malformed_field_rejected(client):
    # SearchRequest has no required field, but a wrong type is still a hard reject
    r = _search(client, query="sha tin", limit="not-an-int")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_sql_injection_style_query_is_data_not_code(client):
    nasty = "'); DROP TABLE merchants; -- sha tin"
    r = _search(client, query=nasty)
    assert r.status_code == 200  # treated as a search string, parameterised
    # the service is still serving afterwards
    assert _search(client, query="sha tin").status_code == 200


def test_limit_is_bounded(client):
    r = _search(client, query="restaurant", limit=10_000)
    assert r.status_code == 200
    assert len(r.json()["items"]) <= 50  # server caps the page (§7)


def test_no_facts_are_fabricated(client):
    """Every rendered number on a card must carry source + confidence + observed_at."""
    data = _search(client, query="sha tin").json()
    for card in data["items"]:
        for fact in card["facts"]:
            assert {"fact_id", "source", "confidence", "observed_at"} <= set(fact)
            UUID(fact["fact_id"])
            assert fact["source"] in {
                "merchant", "imported", "observed", "third_party", "inferred", "demo"}
            assert isinstance(fact["confidence"], (int, float))
        # a price on the card must be backed by a price fact, else absent
        if card.get("price") is not None:
            assert any(f["attribute"] == "price" for f in card["facts"])


def test_demo_flag_set_on_offline_catalogue(client):
    data = _search(client, query="sha tin").json()
    for card in data["items"]:
        assert card["flags"]["demo"] is True  # reviewers cannot mistake fixtures for live
