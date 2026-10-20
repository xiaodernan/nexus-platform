"""Framing parity: the mock provider and a *live-shaped* provider emit identical bytes.

The task's hardest correctness rule is that mock/offline and live mode share one framing,
so a client cannot tell the transport apart by its bytes — only by the honest `provider`
and `degraded` flags the server declares. This proves it:

1. make the whole stream deterministic (fixed ids + fixed clock + fixed demo catalogue);
2. capture the mock stream;
3. inject a fake "live" adapter as the router's PRIMARY (delegating to the deterministic
   heuristics so its payload content equals mock) and capture the stream again;
4. show mock-vs-mock is byte-identical (determinism), and mock-vs-"live" is byte-identical
   once — and only once — the declared `done.provider` value is masked.

No network, no key, no live model: the fake adapter is a stand-in that reports a live
provider name over the same offline heuristics.
"""

from __future__ import annotations

import dataclasses
import itertools
import re
from datetime import datetime, timezone

import pytest

from nexus_ai.config import Settings
from nexus_ai.models.mock import MockAdapter

# frozen clock: fact timestamps / open-state all derive from "now", so the whole stream is
# byte-reproducible only when the demo catalogue answers at one instant.
FIXED_NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
FIXED_ISO = "2026-01-01T12:00:00+00:00"


class FakeLiveAdapter:
    """Stands in for a configured provider: delegates to the deterministic heuristics but
    reports a *live* provider name. Never touches network."""

    name = "claude-live"

    def __init__(self) -> None:
        self._mock = MockAdapter()

    async def complete(self, req):
        resp = await self._mock.complete(req)
        return dataclasses.replace(resp, provider=self.name, degraded=True)

    def health(self):  # pragma: no cover - not exercised offline
        return {"provider": self.name, "ok": True}


FIXED_IDS = ["11111111-1111-1111-1111-111111111111",
             "22222222-2222-2222-2222-222222222222",
             "33333333-3333-3333-3333-333333333333",
             "44444444-4444-4444-4444-444444444444"]


@pytest.fixture
def deterministic(monkeypatch):
    """Freeze ids + clock + the demo catalogue's timestamps so a stream is byte-reproducible."""
    from nexus_ai.api import deps as deps_mod
    from nexus_ai.api import runs, stream
    from nexus_ai.api import demo_data
    from nexus_ai.search import cards

    def _capture(_=None):
        cycle = itertools.cycle(FIXED_IDS)
        monkeypatch.setattr(runs, "new_id", lambda: next(cycle))
        monkeypatch.setattr(stream, "monotonic_ms", lambda: 0)
        frozen = lambda **kw: demo_data.demo_backend(now=FIXED_NOW)  # noqa: E731
        monkeypatch.setattr(deps_mod, "demo_backend", frozen)
        # card-level computed facts take their timestamp from _now(); their ids are content-
        # derived (uuid5), so freezing the clock is enough to make the frames reproducible.
        monkeypatch.setattr(cards, "_now", lambda row: FIXED_NOW)
        return cycle

    return _capture


def _mask_done_provider(body: str) -> str:
    return re.sub(r'("provider":")[^"]*(")', r"\1\g<1>MASKED\2", body)


def _drain(client, query="sha tin"):
    r = client.post("/ai/v1/search/stream", json={"query": query,
                                                  "context": {"now": FIXED_ISO}})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    return r.text


def test_mock_stream_is_deterministic(client, deterministic):
    deterministic(None)
    first = _drain(client)
    deterministic(None)
    second = _drain(client)
    assert first == second  # same bytes, twice -> the seams really froze it


def test_mock_and_live_framing_are_byte_identical(offline_env, deterministic):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.models import factory

    # --- mock mode: default provider pool {mock} ---
    mock_settings = Settings(llm_provider="mock", embedding_provider="hashing",
                             database_url="", internal_token="")
    deterministic(None)
    with TestClient(create_app(mock_settings)) as c:
        mock_body = _drain(c)

    # --- live-shaped mode: fake primary adapter over the same heuristics ---
    live_settings = Settings(llm_provider="anthropic", llm_base_url="https://api.invalid",
                             embedding_provider="hashing", database_url="",
                             internal_token="")
    key = f"{live_settings.llm_provider}|{live_settings.llm_base_url}"
    factory._POOL_CACHE[key] = {"claude-live": FakeLiveAdapter(), "mock": MockAdapter()}
    try:
        deterministic(None)
        with TestClient(create_app(live_settings)) as c:
            live_body = _drain(c)
    finally:
        factory._POOL_CACHE.pop(key, None)

    # the raw streams differ ONLY in the declared provider string inside `done`
    assert mock_body != live_body  # live honestly declares a different provider...
    assert _mask_done_provider(mock_body) == _mask_done_provider(live_body)
    # ...every frame boundary, event name, order and payload is identical
    from nexus_ai.api.sse import parse_frames

    assert [n for n, _ in parse_frames(mock_body)] == \
        [n for n, _ in parse_frames(live_body)]


def test_live_run_declares_live_provider(offline_env):
    """Sanity: the injection actually routed through the fake live adapter."""
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.api.sse import parse_frames
    from nexus_ai.models import factory

    live_settings = Settings(llm_provider="anthropic", llm_base_url="https://api.live",
                             embedding_provider="hashing", database_url="",
                             internal_token="")
    key = f"{live_settings.llm_provider}|{live_settings.llm_base_url}"
    factory._POOL_CACHE[key] = {"claude-live": FakeLiveAdapter(), "mock": MockAdapter()}
    try:
        with TestClient(create_app(live_settings)) as c:
            body = _drain(c)
    finally:
        factory._POOL_CACHE.pop(key, None)
    done = dict(parse_frames(body))["done"]
    assert done["provider"] == "claude-live"  # honestly labels the responding provider
    assert done["degraded"] is True           # heuristics underneath -> still degraded
