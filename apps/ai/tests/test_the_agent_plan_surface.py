"""D854 - POST /ai/v1/agent/plan: the orchestrator's first user-reachable agent surface.

AGENT_CONTRACT §10 names the loop; this route is the deterministic half served to callers.
These tests pin: the two halves of the response (plan + verdicts), the refusal contract,
the execute=false plan-only mode, the missing-context skip, strict body validation, and
the §10 rule-4 audit record (the run lands in the ledger with the executor's real verdicts
in tool_calls, never a fabricated one).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.api.demo_data import demo_backend
from nexus_ai.tools.builtin import register_read_tools
from nexus_ai.tools.registry import Registry

MERCHANT = next(r["merchant_id"] for r in demo_backend().merchants)


def _client():
    app = create_app()
    return TestClient(app)


class TestPlanRoute:
    def test_hours_turn_dispatches_and_answers(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={
            "query": "你們幾點開？",
            "context": {"merchant_id": MERCHANT},
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["plan"]["steps"][0]["tool"] == "get_business_hours"
        assert body["report"]["answerable"] is True
        step = body["report"]["steps"][0]
        assert step["status"] == "ok"
        assert step["ok"] is True
        assert step["result"]["merchant_id"] == MERCHANT
        assert isinstance(step["result"]["weekly_hours"], list) and step["result"]["weekly_hours"]
        assert body["agent_run_id"]

    def test_greeting_refuses_and_plans_nothing(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={"query": "你好"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["plan"]["refused"]
        assert body["plan"]["steps"] == []
        assert body["report"]["steps"] == []
        assert body["report"]["answerable"] is False

    def test_plan_only_mode_returns_no_report(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={
            "query": "my preferences",
            "execute": False,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["plan"]["steps"][0]["tool"] == "get_user_preferences"
        assert body["report"] is None

    def test_missing_context_skips_never_guesses(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={"query": "幾點開"})
        assert r.status_code == 200, r.text
        body = r.json()
        step = body["report"]["steps"][0]
        assert step["status"] == "skipped"
        assert body["report"]["needs_clarification"] == ["merchant_id"]
        assert body["report"]["answerable"] is False

    def test_unknown_context_key_is_a_422(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={
            "query": "幾點開",
            "context": {"merchant_id": MERCHANT, "user_id": "someone-else"},
        })
        assert r.status_code == 422

    def test_empty_query_is_a_422(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={"query": ""})
        assert r.status_code == 422

    def test_extra_body_key_is_a_422(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={"query": "my preferences", "extra": 1})
        assert r.status_code == 422


class TestTheAuditRecord:
    def test_the_run_lands_with_the_executors_real_verdicts(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={
            "query": "你們幾點開？",
            "context": {"merchant_id": MERCHANT},
        })
        assert r.status_code == 200, r.text
        run_id = r.json()["agent_run_id"]
        deps = client.app.state.deps
        run = deps.ledger.get(run_id)
        assert run is not None
        assert run["agent"] == "agent_plan"
        assert run["tool_calls"] and run["tool_calls"][0]["tool"] == "get_business_hours"
        assert run["tool_calls"][0]["ok"] is True

    def test_a_denied_tool_is_a_failed_verdict_never_a_500(self):
        client = _client()
        deps = client.app.state.deps
        # a registry that holds the real tools but refuses every grant: the verdict is a
        # verdict (an honest "no"), never a 500
        deps._registry = register_read_tools(Registry(permissions=lambda _s: set()), deps.backend())
        r = client.post("/ai/v1/agent/plan", json={
            "query": "你們幾點開？",
            "context": {"merchant_id": MERCHANT},
        })
        assert r.status_code == 200, r.text
        step = r.json()["report"]["steps"][0]
        assert step["status"] == "failed"
        assert "PermissionDenied" in step["reason"]
        assert r.json()["report"]["answerable"] is False
        run = deps.ledger.get(r.json()["agent_run_id"])
        assert run["tool_calls"][0]["ok"] is False

    def test_the_zero_llm_path_costs_nothing(self):
        client = _client()
        r = client.post("/ai/v1/agent/plan", json={"query": "my preferences"})
        assert r.status_code == 200, r.text
        run = client.app.state.deps.ledger.get(r.json()["agent_run_id"])
        assert run["cost_usd"] == 0.0
        assert run["prompt_tokens"] == 0
