"""D1451 — the analyst StateGraph (measure -> predict -> prescribe -> verify), pinned.

MOCK mode is asserted exactly: a mock-provider setting must return `degraded: true` with an
empty forecast/measures list — no call, no pretend (§105).

LIVE mode is asserted on its seam contract: with the router wired to a two-reply canned
sequence, the graph must call twice (forecast, then measures) — the canned replies stand in
for the model and only the seam is measured. Every fence holds: a digit the replay never
carried, a URL, a wrong-language draft or an over-long draft all collapse to the deterministic
fallback (or drop the offending row); the deterministic measure node computes verdict / peak
hour / dominant profile itself, never from the model.
"""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from fastapi.testclient import TestClient

import nexus_ai.api.app as A
from nexus_ai.models.base import LLMResponse
from nexus_ai.orchestrator import insights_analyst_graph


STATS: dict[str, Any] = {
    "date": "2026-11-19",
    "total": 22,
    "hourRamp": [0, 1, 2, 4, 6, 9, 12, 15, 18, 20, 22, 24, 25, 26, 27, 28, 30, 32, 34, 38, 40, 34, 22, 9],
    "headline": "Impatient glance dominated",
    "recommendation": "cut two buttons",
    "profiles": [
        {"profile": "impatient glance", "count": 7},
        {"profile": "slow reader", "count": 3},
        {"profile": "silent bounce", "count": 2},
    ],
    "week": {
        "weeklyTotal": 142,
        "slope": 1.4,
        "adviceKind": "up",
        "points": [
            {"date": "2026-11-13", "label": "Thu", "total": 15, "dropRate": 28, "topProfile": "impatient glance"},
            {"date": "2026-11-14", "label": "Fri", "total": 18, "dropRate": 30, "topProfile": "impatient glance"},
            {"date": "2026-11-15", "label": "Sat", "total": 21, "dropRate": 26, "topProfile": "silent bounce"},
            {"date": "2026-11-16", "label": "Sun", "total": 19, "dropRate": 33, "topProfile": "impatient glance"},
            {"date": "2026-11-17", "label": "Mon", "total": 22, "dropRate": 38, "topProfile": "window shopper"},
            {"date": "2026-11-18", "label": "Tue", "total": 23, "dropRate": 41, "topProfile": "window shopper"},
            {"date": "2026-11-19", "label": "Wed", "total": 24, "dropRate": 44, "topProfile": "impatient glance"},
        ],
    },
    "slope": 1.4,
}


def _client() -> TestClient:
    return TestClient(A.create_app())


class _CannedRouter:
    def __init__(self, replies: list[LLMResponse | Exception]) -> None:
        self._replies = list(replies)
        self.calls: list[object] = []

    async def run(self, req, meter=None):
        self.calls.append(req)
        item = self._replies[len(self.calls) - 1] if len(self.calls) <= len(self._replies) else None
        if item is None:
            raise AssertionError(f"the analyst graph made more than {len(self._replies)} calls")
        if isinstance(item, Exception):
            raise item
        return _RoutedCall(item)


class _RoutedCall:
    def __init__(self, response):
        self.response = response


def _resp(text: str) -> LLMResponse:
    return LLMResponse(
        text=text,
        data=json.loads(text),
        provider="fake",
        model="fake-1",
        prompt_tokens=180,
        completion_tokens=96,
        cached_tokens=64,
        cache_reported=True,
        cost_usd=0.001,
        latency_ms=42,
        degraded=False,
    )


_GOOD_FORECAST = json.dumps({
    "forecast": "A rising week reads 142 ghosts; the line drifts up by 1.4 a day. Watch the 44 drop-off day.",
    "watch": "the 44 drop-off day",
    "confidence": "medium",
}, ensure_ascii=False)

_GOOD_MEASURES = json.dumps({
    "measures": [
        {"action": "Cap the first screen at three buttons; push the rest one tap deeper.",
         "why": "The 44 drop-off day is the tell — the landing is teaching too much."},
        {"action": "Add one why-to-read line above every rail before a card ships.",
         "why": "7 ghosts read as impatient glances — reasons stop the wander, numbers do not."},
        {"action": "Leave the funnel alone while slope stays at 1.4 and the replay is this thin.",
         "why": "142 in the week — a thin sample is a mirror, not a mandate."},
    ],
    "confidence": "medium",
}, ensure_ascii=False)

_LEAKED_FORECAST = json.dumps({
    "forecast": "Next week 3491 readers pour in and drop by 77 per day. Act now.",
    "watch": "the flood",
    "confidence": "high",
}, ensure_ascii=False)

_URL_MEASURES = json.dumps({
    "measures": [
        {"action": "Ship this now: https://example.com/playbook", "why": "7 ghosts"},
        {"action": "Read https://example.com/guide", "why": "44"},
        {"action": "Visit https://example.com", "why": "142"},
    ],
    "confidence": "high",
}, ensure_ascii=False)

_NON_CJK_FORECAST = json.dumps({
    "forecast": "The week flatlines at 142 and nobody changes anything; watch the 44 drop-off day.",
    "watch": "the 44 drop-off day",
    "confidence": "low",
}, ensure_ascii=False)


def _ask(client: TestClient, router, locale: str = "en") -> tuple[int, dict]:
    app = client.app
    deps = app.state.deps
    original_router = deps.router
    original_settings = deps.settings
    deps.router = lambda: router  # type: ignore[assignment]
    deps.settings = replace(original_settings, llm_provider="openai")  # type: ignore[assignment]
    try:
        resp = client.post("/ai/v1/insights/analyst", json={"stats": STATS, "locale": locale})
        return resp.status_code, resp.json()
    finally:
        deps.router = original_router
        deps.settings = original_settings


def test_mock_provider_returns_empty_and_inert():
    client = _client()
    resp = client.post("/ai/v1/insights/analyst", json={"stats": STATS, "locale": "en"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["degraded"] is True
    assert body["reason"] == "mock_provider"
    assert body["forecast"] == ""
    assert body["measures"] == []


def test_the_graph_calls_twice_and_fences_hold():
    client = _client()
    router = _CannedRouter([_resp(_GOOD_FORECAST), _resp(_GOOD_MEASURES)])
    status, body = _ask(client, router, "en")
    assert status == 200
    assert len(router.calls) == 2
    assert body["verdict"] == "rising"
    assert body["source"] == "llm"
    assert body["confidence"] in {"low", "medium", "high"}
    assert body["forecast"].startswith("A rising week")
    assert body["watch"] == "the 44 drop-off day"
    assert len(body["measures"]) == 3
    assert body["measured"]["calls"] == 2
    assert body["measured"]["cached_tokens"] == 128
    assert all("https://" not in (m["action"] + m["why"]) for m in body["measures"])


def test_a_digit_the_replay_never_carried_collapses_the_forecast():
    client = _client()
    router = _CannedRouter([_resp(_LEAKED_FORECAST), _resp(_GOOD_MEASURES)])
    status, body = _ask(client, router, "en")
    assert status == 200
    # the forecast leaked 3491/77 (never in the payload) -> the graph substitutes its own
    assert "3491" not in body["forecast"]
    assert body["source"] != "llm"
    assert body.get("reason", "").startswith("forecast")
    # the measures node still runs and its clean rows survive the fence
    assert body["measures"]


def test_urls_in_every_measure_collapse_to_the_fallback():
    client = _client()
    router = _CannedRouter([_resp(_GOOD_FORECAST), _resp(_URL_MEASURES)])
    status, body = _ask(client, router, "en")
    assert status == 200
    joined = " ".join(m["action"] + " " + m["why"] for m in body["measures"])
    assert "https://" not in joined
    assert "Cap the first screen" in joined  # the deterministic fallback measure


def test_the_wrong_language_is_refused():
    client = _client()
    router = _CannedRouter([_resp(_NON_CJK_FORECAST), _resp(_GOOD_MEASURES)])
    status, body = _ask(client, router, "zh-HK")
    assert status == 200
    # an English-only forecast in a zh-HK turn is dropped for the deterministic line
    assert body["forecast"] != "The week flatlines"
    assert body.get("reason", "").split("/")[0] in {"forecast", "watch"}


def test_the_measure_node_math_is_deterministic_not_modelled():
    final = insights_analyst_graph._measure_node({"locale": "en", "stats": STATS})
    measured = final["measured"]
    assert measured["verdict"] == "rising"
    assert measured["slope"] == 1.4
    assert measured["days"] == 7
    assert measured["weeklyTotal"] == 142
    assert measured["avgDropRate"] == round(sum([28, 30, 26, 33, 38, 41, 44]) / 7, 1)
    assert measured["worstDropRate"] == 44
    assert measured["worstDay"] == "2026-11-19"
    assert measured["dominantProfile"] == "impatient glance"
    assert measured["rampPeakHour"] == 20
