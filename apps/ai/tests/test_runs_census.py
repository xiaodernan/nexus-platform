"""D432 - every task writes an `agent_runs` row (AGENT_CONTRACT §8).

The census that started this unit (the in-process ledger, DB-free):

    /ai/v1/search               runs: 1
    /ai/v1/search/stream        runs: 1
    /ai/v1/merchant-agent/chat  runs: 1
    /ai/v1/rag/retrieve         runs: 0   <- D431/D432
    /ai/v1/query/understand     runs: 0   <- D432
    /ai/v1/recommend            runs: 0   <- D432 (and its response handed out an
                                                  `agent_run_id` that resolved to nothing)
    /ai/v1/feedback             runs: 0   (correct: the feedback EVENT is its record)

The feedback is the one that is right to write no run: it is a signal, not a task, and it
records itself in `feedback_events`. Everything else is a task, and §8 says every task writes
a run - a promise nothing fails on when it is broken, which is why it was broken.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

MERCHANT = str(uuid.UUID("66666666-6666-6666-6666-666666666666"))


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def _ledger(client: TestClient):
    return client.app.state.deps.ledger


def test_the_search_writes_a_run():
    with _client() as c:
        r = c.post("/ai/v1/search", json={"query": "拉麵", "limit": 3})
        assert r.status_code == 200, r.text
        assert _ledger(c).get_all(), "the search wrote no run"


def test_the_intent_extraction_writes_a_run():
    with _client() as c:
        r = c.post("/ai/v1/query/understand", json={"query": "拉麵", "context": {}})
        assert r.status_code == 200, r.text
        runs = _ledger(c).get_all()
        assert runs, "the intent extraction wrote no run"
        assert runs[-1]["agent"] == "intent_extract"


def test_the_retrieval_writes_a_run():
    with _client() as c:
        r = c.post("/ai/v1/rag/retrieve", json={"query": "菜式", "filters": {}, "top_k": 3})
        assert r.status_code == 200, r.text
        runs = _ledger(c).get_all()
        assert runs, "the retrieval wrote no run"
        assert runs[-1]["agent"] == "retrieval"


def test_the_recommendation_writes_a_run_and_its_run_id_resolves():
    with _client() as c:
        r = c.post("/ai/v1/recommend", json={"query": "拉麵", "limit": 3})
        assert r.status_code == 200, r.text
        body = r.json()
        runs = _ledger(c).get_all()
        assert runs, "the recommendation wrote no run"
        run = runs[-1]
        assert run["agent"] == "recommendation"
        # The response hands the caller an `agent_run_id`; it has to resolve to a run.
        assert str(run["agent_run_id"]) == str(body["agent_run_id"]), (
            "the recommendation's response hands out a run id that no run carries")


def test_the_feedback_writes_its_own_record_and_no_run():
    # A signal is not a task: the feedback event IS the record (§8's second table), so a
    # run here would be a second, redundant record of the same thing.
    with _client() as c:
        r = c.post("/ai/v1/feedback", json={"subject_type": "merchant", "signal": "click"})
        assert r.status_code == 200, r.text
        assert not _ledger(c).get_all(), "the feedback wrote a run as well as its event"
