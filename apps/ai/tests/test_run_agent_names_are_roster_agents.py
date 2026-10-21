"""D461 - the run's `agent` names a ROSTER agent, and the roster is read from the contract.

`agent_runs.agent` is the name of the agent that did the work, and AGENT_CONTRACT §1 holds
the authoritative roster: "Implement the roster exactly; do not add ad-hoc agents that
bypass the registry" (AGENTS.md). The service was writing three names that are not on it:

    search          - the roster's executor                          (on the roster)
    retrieval       - the roster's executor                          (on the roster)
    recommendation  - the roster's synthesiser                       (on the roster)
    intent_extract  - the ROUTER'S TASK CLASS (§9), not an agent      (fixed: user_intent)
    merchant_agent  - a name the roster does not define              (declared below)
    compare_entities- a §3 TOOL name, and the roster has no tool agent (declared below)

The roster is parsed out of the contract rather than copied here: a copied list is a
second copy, and the second copy is the one that goes stale - which is exactly what
happened to the schema's own comment on the column (it still lists `fraud` and `cart`).

The two names that are not on the roster are DECLARED, with the reason, and they are the
filing: the merchant agent's chat and the comparison are surfaces the roster does not
name, and a run has to say who did the work - so the contract has to name them, and until
it does, the name is declared rather than invented quietly.
"""

from __future__ import annotations

import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "docs" / "AGENT_CONTRACT.md"

#: The surfaces whose run names an agent the roster does not define, and why.
DECLARED_OFF_ROSTER = {
    "merchant_agent": (
        "the merchant agent's chat is a conversational surface the roster does not name "
        "(`customer_service` and `merchant_sales` both run via the platform door, §7.0) - "
        "filed: the roster has to name this surface, or the surface has to be a roster agent"
    ),
    "compare_entities": (
        "the comparison is the §3 tool `compare_entities` and the roster has no tool agent "
        "- filed: a tool endpoint that is a task needs a name in the roster, or the run "
        "needs a column for the tool"
    ),
}

#: The surfaces that answer with no run at all (the D460 census's exemptions).
NO_RUN = {
    "/ai/v1/feedback",
    "/ai/v1/tools",
    "/ai/v1/health",
    "/ai/v1/conversations/{conversation_id}",
}

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


def roster_agents() -> set[str]:
    """The agents AGENT_CONTRACT §1 defines - read from the contract, not copied."""
    text = CONTRACT.read_text(encoding="utf-8")
    section = text.split("## 2.", 1)[0]
    names: set[str] = set()
    for line in section.splitlines():
        if not line.startswith("|"):
            continue
        for cell in line.split("|"):
            for name in re.findall(r"`([a-z_]+)`", cell):
                names.add(name)
    return names


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def test_the_roster_the_contract_defines_is_readable():
    agents = roster_agents()
    for expected in ("user_intent", "search", "retrieval", "recommendation",
                     "customer_service", "merchant_sales", "fact_verification"):
        assert expected in agents, (
            f"the roster read out of {CONTRACT.name} does not carry {expected!r} - the "
            f"parser or the contract changed, and a census that reads the wrong list is a "
            f"census that proves nothing")
    assert len(agents) >= 16, f"the roster read only {len(agents)} names: {sorted(agents)}"


def test_every_run_names_a_roster_agent():
    roster = roster_agents()
    client = _client()
    with client:
        ledger = client.app.state.deps.ledger
        seen: dict[str, str] = {}
        for template, operations in client.app.openapi()["paths"].items():
            if not template.startswith("/ai/") or template in NO_RUN:
                continue
            for method in sorted(set(operations) & {"get", "post"}):
                before = len(ledger.get_all())
                body = PROBE_BODIES.get(template)
                concrete = template.replace("{conversation_id}", str(uuid.uuid4()))
                if method.upper() == "GET":
                    client.get(concrete)
                else:
                    client.post(concrete, json=body)
                # the search stream writes its run in a BACKGROUND task
                deadline = time.time() + 5.0
                while len(ledger.get_all()) <= before and time.time() < deadline:
                    time.sleep(0.02)
                runs = ledger.get_all()
                if len(runs) <= before:
                    continue
                agent = str(runs[-1].get("agent") or "")
                seen[template] = agent
        assert seen, "no surface wrote a run - the census measured nothing"
        unknown = {path: agent for path, agent in seen.items()
                   if agent not in roster and agent not in DECLARED_OFF_ROSTER}
        assert not unknown, (
            "these runs name an agent the contract's roster does not define: "
            + ", ".join(f"{path} -> {agent!r}" for path, agent in unknown.items())
            + " - §1 is the authoritative roster, and a run that names an agent nobody "
              "can look up is a run nobody can replay")
