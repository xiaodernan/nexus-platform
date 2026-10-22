"""D507 — the semantic embedding provider must reach the lane it exists to serve.

The pgvector lane is what makes a paraphrase findable. Two links had to both hold for it
to ever run, and one of them was broken while the other was inverted:

* `api/pipeline.py` gated the embed call on `settings.embedding_provider == "hashing"`, so
  the provider the contract names for semantic recall (`AGENT_CONTRACT` §6) was the one
  provider that never asked for a vector;
* `models/embeddings.py::HttpEmbedding.embed` — the method that would have answered that
  call — was dead code that could not have run (blamed to `f80fadd`), and its own test file
  declared the network path must never be exercised.

These legs walk the real `run_search` with the real deterministic search underneath, and
substitute only the two things an offline process cannot have: the provider behind
`Deps.embeddings()` (patched at the factory seam the route itself calls through) and the
`name` the lane gate reads off the backend. Every row still comes from the demo catalogue.
"""

from __future__ import annotations

import pytest

from nexus_ai.api import pipeline
from nexus_ai.api.deps import Deps
from nexus_ai.config import Settings
from nexus_ai.models import embeddings as E

#: a query the offline catalogue actually answers, so "the keyword lane is the floor"
#: is a measured claim rather than an assumption.
QUERY = "cafe"
PROVIDER_VECTOR = [0.5] * E.DIM


def _settings(provider: str, *, base_url: str = "", api_key: str = "") -> Settings:
    return Settings(llm_provider="mock", embedding_provider=provider,
                    embedding_base_url=base_url, embedding_api_key=api_key,
                    embedding_dim=E.DIM, database_url="", internal_token="", demo_data=True)


class _RecordingAdapter:
    """Stands in for whatever provider the factory would build, and keeps every answer."""

    def __init__(self, *, fail: bool = False) -> None:
        self.calls: list[list[str]] = []
        self.fail = fail

    async def embed(self, texts):
        self.calls.append(list(texts))
        if self.fail:
            raise RuntimeError("embedding provider is down")
        return [list(PROVIDER_VECTOR) for _ in texts]


class _LaneSpy:
    """Records what the lane gate handed the real deterministic search."""

    def __init__(self, real) -> None:
        self._real = real
        self.kwargs: list[dict] = []

    async def __call__(self, **kw):
        self.kwargs.append(kw)
        return await self._real(**kw)


def _wrap_search(monkeypatch) -> _LaneSpy:
    spy = _LaneSpy(pipeline.deterministic_search)
    monkeypatch.setattr(pipeline, "deterministic_search", spy)
    return spy


def _install(monkeypatch, adapter: _RecordingAdapter) -> _LaneSpy:
    monkeypatch.setattr(E, "get_embedding_adapter", lambda settings=None: adapter)
    return _wrap_search(monkeypatch)


def _backend_names_postgres(monkeypatch) -> None:
    """The lane gate reads `backend.name`; offline the catalogue reports `static`.

    Only that one attribute is flipped — candidates, facts and hours still come from the
    same demo rows, so this simulates the gate's input, not the database's answers.
    """
    backend = Deps(_settings("hashing")).backend()
    backend.name = "postgres"
    monkeypatch.setattr(Deps, "backend", lambda self: backend)


class _StubHttpResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"data": [{"index": 0, "embedding": list(PROVIDER_VECTOR)}]}


class _StubWire:
    """The `/embeddings` transport, so the real adapter runs its real request logic."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def post(self, url, headers=None, json=None):
        self.calls.append({"url": url, "headers": headers, "json": json})
        return _StubHttpResponse()

    async def aclose(self) -> None:
        return None


async def _run(provider: str = "http", **kw) -> pipeline.SearchPack:
    return await pipeline.run_search(Deps(_settings(provider, **kw)), None, query=QUERY)


class TestTheProviderIsAsked:
    """`conftest.offline_env` clears the embedding cache per test, so a request counted
    here is a request the pipeline actually made."""

    async def test_the_http_provider_is_asked_for_the_query(self, monkeypatch):
        adapter = _RecordingAdapter()
        _install(monkeypatch, adapter)
        await _run()
        assert adapter.calls == [[QUERY]]

    async def test_the_providers_vector_reaches_the_vector_lane(self, monkeypatch):
        adapter = _RecordingAdapter()
        spy = _install(monkeypatch, adapter)
        _backend_names_postgres(monkeypatch)
        pack = await _run()
        assert spy.kwargs, "the pipeline never reached the deterministic search"
        handed = spy.kwargs[-1]
        assert handed["vector_lane"] is True
        assert handed["embedding"] == PROVIDER_VECTOR
        assert pack.vector_lane is True

    async def test_the_real_http_adapter_asks_over_the_wire(self, monkeypatch):
        """Provider -> factory -> `HttpEmbedding` -> HTTP body, with only the transport faked."""
        _backend_names_postgres(monkeypatch)
        spy = _wrap_search(monkeypatch)
        wire = _StubWire()
        real_http = E.HttpEmbedding

        def _build(**kw):
            return real_http(client=wire, **kw)

        monkeypatch.setattr(E, "HttpEmbedding", _build)
        pack = await _run(base_url="http://embed.test/v1", api_key="k")
        assert len(wire.calls) == 1
        assert wire.calls[0]["json"]["input"] == [QUERY]
        assert wire.calls[0]["json"]["dimensions"] == E.DIM
        assert spy.kwargs[-1]["vector_lane"] is True
        assert spy.kwargs[-1]["embedding"] == PROVIDER_VECTOR
        assert pack.vector_lane is True

    async def test_the_offline_hashing_provider_still_reaches_the_lane(self, monkeypatch):
        """The repair must not trade away the lane the offline adapter already fed."""
        spy = _wrap_search(monkeypatch)
        _backend_names_postgres(monkeypatch)
        pack = await _run("hashing")
        assert spy.kwargs[-1]["vector_lane"] is True
        assert len(spy.kwargs[-1]["embedding"]) == E.DIM
        assert pack.vector_lane is True


class TestTheFloorHolds:
    async def test_a_provider_failure_keeps_the_keyword_answer(self, monkeypatch):
        _backend_names_postgres(monkeypatch)
        adapter = _RecordingAdapter()
        spy = _install(monkeypatch, adapter)
        baseline = await _run()
        adapter.fail = True
        pack = await _run()

        assert pack.vector_lane is False
        assert spy.kwargs[-1]["embedding"] is None
        assert spy.kwargs[-1]["vector_lane"] is False
        # the floor is not an empty answer: the same search minus the vector still serves
        # the same rows. The cards cannot be compared whole — `open.as_of` carries the wall
        # clock each run read — so compare what the ranking actually chose.
        assert [c["id"] for c in pack.items] == [c["id"] for c in baseline.items]
        assert pack.items, "the keyword lane answered nothing, so the equality above is vacuous"

    async def test_an_empty_query_pays_for_no_embedding_call(self, monkeypatch):
        adapter = _RecordingAdapter()
        _install(monkeypatch, adapter)
        _backend_names_postgres(monkeypatch)
        pack = await pipeline.run_search(Deps(_settings("http")), None, query="")
        assert adapter.calls == []
        assert pack.vector_lane is False


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
