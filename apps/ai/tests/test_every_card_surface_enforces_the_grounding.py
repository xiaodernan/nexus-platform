"""D502 - the grounding boundary is enforced on EVERY surface that ships cards.

AGENT_CONTRACT §4 (non-negotiable): *"Renderer contract: `EntityCard.facts[]` +
`ai_match.reasons[].fact_id`. If `fact_id` is missing, the UI must not render that
bullet."*

The boundary has a guard - `drop_ungrounded_reasons` - and the RECOMMEND route called it on
every card before it shipped. The SEARCH route did not, and the STREAM route did not. So the
boundary the contract calls non-negotiable was enforced on the surface the recommendation
product uses and NOT on the surface the CONSUMER uses - and `/ai/v1/search` is both the main
consumer surface and the §105 fallback target the stream degrades to.

The rules path never emits an ungrounded reason today, so the live corpus shows no
difference. That is exactly why the guard belongs in the shared place: the guard is there
for the producer that does not exist yet. So this gate INJECTS one - it makes the producer
that would break the contract, and asks every surface what it does with the result.

This gate holds every surface to it:
  * an injected ungrounded reason is GONE from the search route's cards ✓;
  * and from the recommend route's cards ✓;
  * and from the STREAM's frames ✓;
  * and the guard lives in the ONE function all three call ✓ - so a surface cannot forget
    it ✓ (a route that remembered it on its own would be a second copy of the rule ✓).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api import pipeline
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import AiMatch, MatchExplanation

#: the labels the wire guard allows to carry no fact_id (a sponsored placement is LABELLED
#: as such rather than faked into a trust reason - §1846)
NO_FACT_ALLOWED = {"sponsored"}

#: the routes that ship cards
CARD_ROUTES = ["/ai/v1/search", "/ai/v1/recommend"]

#: the query the offline demo corpus answers with cards
QUERY = "restaurant"

#: the label of the reason this gate INJECTS - a claim with no fact behind it
INJECTED = "injected_ungrounded"


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="", demo_data=True)
    return TestClient(create_app(settings))


def _ungrounded(card: dict) -> list[str]:
    reasons = ((card.get("ai_match") or {}).get("reasons")) or []
    return [r.get("label") for r in reasons
            if r.get("fact_id") is None and r.get("label") not in NO_FACT_ALLOWED]


@pytest.fixture
def ungrounded_producer(monkeypatch):
    """Make the producer emit one ungrounded reason - the case the guard exists for."""
    original = pipeline.deterministic_search

    async def producer(*args, **kwargs):
        cards, response, bundle, scored = await original(*args, **kwargs)
        for card in cards:
            reasons = list((card.ai_match.reasons if card.ai_match else []) or [])
            reasons.append(MatchExplanation(label=INJECTED, text="an ungrounded claim",
                                            value="999", fact_id=None))
            card.ai_match = AiMatch(score=1.0, reasons=reasons)
        return cards, response, bundle, scored

    monkeypatch.setattr(pipeline, "deterministic_search", producer)
    return INJECTED


@pytest.mark.parametrize("route", CARD_ROUTES)
def test_the_surface_drops_the_ungrounded_reason(route: str, ungrounded_producer):
    with _client() as c:
        r = c.post(route, json={"query": QUERY, "limit": 5})
        assert r.status_code == 200, r.text
        cards = r.json().get("items") or []
        assert cards, f"{route} returned no card - the gate measured nothing"
        for card in cards:
            assert INJECTED not in _ungrounded(card), (
                f"{route} shipped a card with the ungrounded reason {INJECTED!r} - §4: if "
                f"`fact_id` is missing, the UI must not render that bullet")


def test_the_stream_drops_the_ungrounded_reason(ungrounded_producer):
    """The stream is the browser's path - the same boundary applies to its frames."""
    with _client() as c:
        r = c.post("/ai/v1/search/stream", json={
            "query": QUERY, "limit": 5,
            "conversation_id": "11111111-2222-3333-4444-555555555555"})
        assert r.status_code == 200, r.text
        frames = []
        for block in r.text.split("\n\n"):
            data = None
            for line in block.splitlines():
                if line.startswith("data: "):
                    data = line[6:]
            if data:
                frames.append(json.loads(data))
        cards = []
        for frame in frames:
            items = frame.get("items")
            if isinstance(items, list):
                cards.extend(i for i in items if isinstance(i, dict))
        assert cards, "the stream shipped no card - the gate measured nothing"
        for card in cards:
            assert INJECTED not in _ungrounded(card), (
                f"the stream shipped a card with the ungrounded reason {INJECTED!r}")


def test_the_guard_lives_in_the_shared_search_path():
    """One place, not one place per surface.

    A route that remembered the guard on its own would be a second copy of the rule - and
    the next surface would not have it.
    """
    api = Path(__file__).resolve().parents[1] / "nexus_ai" / "api"
    pipeline_source = (api / "pipeline.py").read_text(encoding="utf-8")
    assert "drop_ungrounded_reasons" in pipeline_source, (
        "the shared search path does not enforce the grounding boundary - a surface that "
        "does not call `run_search` would ship cards without it")

    for path in sorted(api.glob("routes_*.py")):
        text = path.read_text(encoding="utf-8")
        if "drop_ungrounded_reasons" in text:
            pytest.fail(
                f"{path.name} enforces the grounding boundary itself - the rule is in the "
                f"shared search path, and a route that keeps its own copy is a second copy "
                f"of the rule (and the next surface would not have it)")
