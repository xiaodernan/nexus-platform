"""D1314 — the growing-history lead for the merchant agent chat."""
from __future__ import annotations

import json
import uuid

MERCHANT = str(uuid.UUID("66666666-6666-6666-6666-666666666666"))
CONVERSATION = str(uuid.UUID("77777777-7777-7777-7777-777777777777"))


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url="postgres://fake/db", internal_token="tok-internal-pass-1234")


def _frames(client, message: str = "what are your hours?"):
    with client.stream("POST", "/ai/v1/merchant-agent/chat", json={
            "merchant_id": MERCHANT, "message": message,
            "conversation_id": CONVERSATION}) as resp:
        assert resp.status_code == 200, resp.status_code
        frames: list[dict] = []
        for line in resp.iter_lines():
            if line.startswith("data:"):
                frames.append(json.loads(line[len("data:"):].strip()))
        return frames


class _CannedDB:
    async def write(self, *args, **kwargs):
        return None

    async def execute(self, *args, **kwargs):
        return None


class _FakeRouter:
    """Accepts the meter kwarg the real router is fed, records what it was handed."""

    def __init__(self, reply, captured) -> None:
        self.calls = [reply]
        self.captured = captured

    async def run(self, req, meter=None):
        self.captured["req"] = req
        self.captured["meter"] = meter
        return _RoutedCall(_llm_response())


class _LossyRouter:
    """The relay is down on this plane: any read is a failure; the stream must carry on."""

    def __init__(self, captured) -> None:
        self.captured = captured

    async def run(self, req, meter=None):
        self.captured["req"] = req
        return _RoutedCall(_llm_response())


class _LeadClient:
    def __init__(self, messages) -> None:
        self.messages = messages
        self.read_calls: list[dict] = []

    async def append_conversation_message(self, *a, **kw):
        return {"message_id": "m1", "handoff_id": None}

    async def list_conversation_messages(self, conversation_id, *, limit=12, internal_token=None, tenant=None):
        self.read_calls.append({"conversation_id": conversation_id, "limit": limit,
                                "internal_token": internal_token, "tenant": tenant})
        return {"messages": self.messages, "returned": len(self.messages),
                "total": len(self.messages), "limit": limit, "stub": True}


class _BoomClient:
    async def append_conversation_message(self, *a, **kw):
        return {"message_id": "m1"}

    async def list_conversation_messages(self, *a, **kw):
        raise RuntimeError("relay is down")


class _ProbeClient:
    def __init__(self) -> None:
        self.probe_calls: list = []

    async def append_conversation_message(self, *a, **kw):
        return {"message_id": "m1"}

    async def list_conversation_messages(self, *a, **kw):
        self.probe_calls.append(kw)
        return {"messages": [], "returned": 0}


def _llm_response():
    from nexus_ai.models.base import LLMResponse

    return LLMResponse(text="We are open daily 11:30-21:00.", data=None,
                       provider="fake", model="fake-1",
                       prompt_tokens=100, completion_tokens=8, cached_tokens=0,
                       cache_reported=True, cost_usd=0.0001, latency_ms=5, degraded=False)


def _RoutedCall(response):
    class _R:
        def __init__(self, r):
            self.response = r

    return _R(response)


def _ground_env(monkeypatch, history, captured):
    import nexus_ai.adapters.platform as plat
    import nexus_ai.api.routes_rag as rag

    async def _fake_retrieve(*args, **kwargs):
        return [{"id": "c1", "section": "hours", "document_id": "d1",
                 "text": "Open daily 11:30-21:00", "hit": True, "score": 0.9}], 0.9

    monkeypatch.setattr(rag, "retrieve_chunks", _fake_retrieve)

    client = _LeadClient(history)
    monkeypatch.setattr(plat, "get_platform_client", lambda *a, **kw: client)

    class _Router(_FakeRouter):
        def __init__(self):
            self.captured = captured
            self.calls: list = []

        async def run(self, req, meter=None):
            self.captured["req"] = req
            return _RoutedCall(_llm_response())

    return client, lambda: _Router()


def test_the_growing_lead_is_ordered_oldest_to_newest(monkeypatch):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    history = [
        {"sender_type": "user", "role": "user", "content": "hello"},
        {"sender_type": "ai_agent", "role": "assistant", "content": "hi there"},
        {"sender_type": "user", "role": "user", "content": "any seat?"},
    ]
    captured: dict = {}
    client_holder, router_factory = _ground_env(monkeypatch, history, captured)
    app = create_app(_settings())
    with TestClient(app) as c:
        deps = c.app.state.deps
        monkeypatch.setattr(deps, "database", lambda: _CannedDB())
        monkeypatch.setattr(deps, "router", router_factory)
        frames = _frames(c)
        assert any(f.get("citations") for f in frames), f"no grounded answer: {frames}"
        req = captured["req"]
        assert isinstance(req.prompt, str) and req.prompt
        hello_idx = req.prompt.index("hello")
        hi_idx = req.prompt.index("hi there")
        seat_idx = req.prompt.index("any seat?")
        latest_idx = req.prompt.index("what are your hours?")
        records_idx = req.prompt.index("Merchant knowledge")
        assert hello_idx < hi_idx < seat_idx < latest_idx < records_idx
        got = client_holder.read_calls[0]
        assert got["conversation_id"] == CONVERSATION
        assert got["internal_token"] == "tok-internal-pass-1234"
        assert got["tenant"]


def test_a_failed_history_relay_still_answers(monkeypatch):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    import nexus_ai.adapters.platform as plat
    import nexus_ai.api.routes_rag as rag

    async def _fake_retrieve(*args, **kwargs):
        return [{"id": "c1", "section": "hours", "document_id": "d1",
                 "text": "Open daily 11:30-21:00", "hit": True, "score": 0.9}], 0.9

    monkeypatch.setattr(rag, "retrieve_chunks", _fake_retrieve)
    monkeypatch.setattr(plat, "get_platform_client", lambda *a, **kw: _BoomClient())

    captured: dict = {}

    class _Router(_LossyRouter):
        def __init__(self):
            self.captured = captured

    app = create_app(_settings())
    with TestClient(app) as c:
        deps = c.app.state.deps
        monkeypatch.setattr(deps, "database", lambda: _CannedDB())
        monkeypatch.setattr(deps, "router", lambda: _Router())
        frames = _frames(c)
        assert any(f.get("citations") for f in frames), (
            f"the chat did not answer: {frames}")
        # without history the prompt kwarg is never set against the mock plane — pre-D1314 wire
        assert captured["req"].prompt == ""


def test_no_service_token_means_no_history_probe_at_all(monkeypatch):
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    import nexus_ai.adapters.platform as plat
    import nexus_ai.api.routes_rag as rag

    async def _fake_retrieve(*args, **kwargs):
        return [{"id": "c1", "section": "hours", "document_id": "d1",
                 "text": "Open daily 11:30-21:00", "hit": True, "score": 0.9}], 0.9

    monkeypatch.setattr(rag, "retrieve_chunks", _fake_retrieve)
    client = _ProbeClient()
    monkeypatch.setattr(plat, "get_platform_client", lambda *a, **kw: client)

    captured: dict = {}

    class _Router(_LossyRouter):
        def __init__(self):
            self.captured = captured

    from nexus_ai.config import Settings
    no_token = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="postgres://fake/db", internal_token="")
    app = create_app(no_token)
    with TestClient(app) as c:
        deps = c.app.state.deps
        monkeypatch.setattr(deps, "database", lambda: _CannedDB())
        monkeypatch.setattr(deps, "router", lambda: _Router())
        frames = _frames(c)
        assert any(f.get("citations") for f in frames)
        assert client.probe_calls == []
