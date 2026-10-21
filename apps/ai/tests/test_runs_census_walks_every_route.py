"""D460 - the runs census walks EVERY route, the way a client would.

D432's census said it "walked the service's endpoints and counted what each leaves in the
in-process ledger" - and the table it published had SEVEN endpoints ✓. The committed test
file asked FIVE ✓. The comparison was never asked, and it was the one task surface that
wrote no run: it reads merchants, builds a grid and grounds every cell in a fact, and
none of that was recorded anywhere, so "why did the comparison put these two side by side"
had no answer.

The D459 lesson applies here too: **a census has to ask the surface the way a client
would, and a request that is rejected is not an answer.** The comparison needs at least two
subjects, and a probe that sends one gets a 422 - which looks like a surface that was
measured and was not.

So this census walks the application's own OpenAPI document (the surface a client can
see), asks every route with a request a client could send, and requires a run for every
task surface. The surfaces that are NOT tasks are declared here, with the reason - a
census that has no declared exemptions cannot tell the difference between "this writes no
run" and "nobody asked it".
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

#: The surfaces that answer with no run, and why. A signal is not a task (the D432 ruling:
#: the feedback EVENT is its record), a manifest is not a task, a health check is not a
#: task, and the timeline is a READ of the run ledger - it would be a run that reads runs.
NO_RUN = {
    "/ai/v1/feedback": "a signal, not a task - the feedback event is its record (§8)",
    "/ai/v1/tools": "a manifest, not a task",
    "/ai/v1/health": "a health check, not a task",
    "/ai/v1/conversations/{conversation_id}": "a read of the run ledger, not a task",
}

#: A request a client could send for each route. The comparison needs TWO subjects (that
#: is its request model's own rule) - a probe that sends one gets a 422, and a 422 is not
#: an answer.
PROBE_BODIES: dict[str, dict[str, Any]] = {
    "/ai/v1/search": {"query": "coffee", "limit": 3},
    "/ai/v1/recommend": {"query": "coffee", "limit": 3},
    "/ai/v1/query/understand": {"query": "coffee", "context": {}},
    "/ai/v1/rag/retrieve": {"query": "coffee", "filters": {}, "top_k": 3},
    "/ai/v1/compare": {"subject_ids": [str(uuid.UUID(int=7)), str(uuid.UUID(int=8))]},
    "/ai/v1/feedback": {"subject_type": "merchant", "signal": "click"},
    "/ai/v1/search/stream": {"query": "coffee", "limit": 3},
    "/ai/v1/merchant-agent/chat": {"merchant_id": str(uuid.UUID(int=7)),
                                   "message": "coffee",
                                   "conversation_id": str(uuid.UUID(int=8))},
}


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def _ask(client: TestClient, method: str, template: str) -> int:
    """Ask one route the way a client would, and return its status code."""
    body = PROBE_BODIES.get(template)
    concrete = template.replace("{conversation_id}", str(uuid.uuid4()))
    if "{conversation_id}" in template:
        return client.get(concrete).status_code
    if method.upper() == "GET":
        return client.get(concrete).status_code
    return client.post(concrete, json=body).status_code


def test_every_task_surface_writes_a_run():
    client = _client()
    with client:
        ledger = client.app.state.deps.ledger
        missing: list[str] = []
        for template, operations in client.app.openapi()["paths"].items():
            if not template.startswith("/ai/"):
                continue
            for method in sorted(set(operations) & {"get", "post"}):
                before = len(ledger.get_all())
                status = _ask(client, method, template)
                assert status == 200, (
                    f"{template} answered {status} - a request that is rejected is not an "
                    f"answer, and a census that counts it as measured is a census that "
                    f"measured nothing")
                if template in NO_RUN:
                    continue
                # the search stream writes its run in a BACKGROUND task, so the ledger is
                # read a moment later (the same wait the cost-ledger gate uses). The count
                # is a DELTA: the ledger carries every earlier surface's run, so "the
                # ledger is not empty" would be true whatever this surface did.
                deadline = time.time() + 5.0
                while len(ledger.get_all()) <= before and time.time() < deadline:
                    time.sleep(0.02)
                if len(ledger.get_all()) <= before:
                    missing.append(f"{method.upper()} {template}")
        assert not missing, (
            "these surfaces are tasks and wrote no agent_runs row - §8 says every task "
            "writes one, and a task nobody records is a question nobody can answer: "
            + ", ".join(missing))


def test_the_comparison_writes_a_run_of_its_own():
    client = _client()
    with client:
        r = client.post("/ai/v1/compare", json={
            "subject_ids": [str(uuid.UUID(int=7)), str(uuid.UUID(int=8))]})
        assert r.status_code == 200, r.text
        runs = client.app.state.deps.ledger.get_all()
        assert runs, "the comparison wrote no run"
        run = runs[-1]
        assert run["agent"] == "compare_entities", (
            f"the comparison's run says {run.get('agent')!r} - the grid it builds is the "
            f"compare_entities work")
        assert run["status"] == "succeeded", run.get("status")
        assert run["tool_calls"], "the comparison's run records no tool call"
        assert run["tool_calls"][0]["tool"] == "compare_entities"
        assert run["retrieval"], "the comparison's run records which subjects it compared"
