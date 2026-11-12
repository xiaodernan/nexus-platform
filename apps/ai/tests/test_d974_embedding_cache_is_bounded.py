"""D974 — the module-level embedding cache must be bounded, and the HTTP embed path must reuse one client.

THE HOLE (two defects, one module, `models/embeddings.py`).

(1) `_CACHE` is a plain module-level dict keyed by `(name/model, RAW TEXT)`. The text is
external input: a RAG query (`api/routes_rag.py`) or a document chunk (`rag/embed.py`), high
cardinality and caller-controlled. Each value is a 1024-d float tuple (~32 KB). The
DEV-DEFAULT `HashingEmbedding.embed_one` writes it unconditionally (`:_CACHE[(name, text)]`),
so even with NO infra configured, every distinct query/chunk is retained forever. Measured
before the fix: 2000 distinct queries -> 2000 entries -> ~62 MiB. This is unbounded,
traffic-driven memory growth — the same class D903/D972 closed on the tool-result cache, but
on a module those units never touched. The shipped D903 door inspected `registry.py:_store`,
not this dict, so CI never saw it.

(2) `HttpEmbedding.embed` did `client = self._client or httpx.AsyncClient(...)` then
`finally: await client.aclose()` on EVERY call, and `deps.embeddings()` returns a fresh
adapter each time without injecting a client. So each embed paid a full TCP(+TLS) handshake
with no keep-alive — D969's hole, still open on a second adapter. (D969 pooled the AI→platform
client; `embeddings.py` was never wired to it.)

THE FIX. `_CACHE` becomes an `OrderedDict` capped at `_CACHE_MAX` (default 4096): `_cache_get`
promotes a hit (`move_to_end`), `_cache_put` evicts the coldest entry (`popitem(last=False)`)
once the cap is crossed — O(1) per op, so the hot set still hits and the ceiling is ~128 MiB.
No returned vector changes. Client reuse: a module-level pooled `httpx.AsyncClient` built once
by `_shared_client`, released by `aclose_embedding_client()` at app shutdown; an injected
client is still used verbatim and is never closed by a call (caller owns it). The factory still
returns a FRESH adapter per call, byte-for-byte.

WHAT THIS PROVES / DOES NOT. Pure offline: fake text + stub clients, no network/DB/Redis/JVM.
It proves the cache is bounded by the cap (not by write count), evicts LRU (not FIFO), keeps
vectors byte-identical, and builds one client for N embeds. It does NOT measure any live
latency/footprint number; the cap is a structural bound, not a benchmark.
"""

from __future__ import annotations

import asyncio

import pytest

from nexus_ai.models import embeddings as E


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    """Isolate the module-level cache + pool between arms; restore the real cap/client."""
    E._CACHE.clear()
    monkeypatch.setattr(E, "_CACHE_MAX", 8, raising=True)
    monkeypatch.setattr(E, "_HTTP_CLIENT", None, raising=True)
    yield
    E._CACHE.clear()
    monkeypatch.setattr(E, "_HTTP_CLIENT", None, raising=True)


class _Resp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        return None

    def json(self):
        return {"data": self._data}


class _StubClient:
    """Speaks just enough of the OpenAI `/embeddings` contract for the reuse arm."""

    def __init__(self):
        self.posts = 0
        self.closed = 0

    async def post(self, url, headers=None, json=None):
        self.posts += 1
        data = [{"index": i, "embedding": [float(i)] * E.DIM}
                for i in range(len(json["input"]))]
        return _Resp(data)

    async def aclose(self):
        self.closed += 1


def test_cache_stays_bounded_under_distinct_query_churn():
    """Positive arm: 2000 distinct queries with cap=8 leave at most cap entries."""
    h = E.HashingEmbedding()
    for i in range(2000):
        h.embed_one(f"unique-query-{i}")
    assert len(E._CACHE) <= E._CACHE_MAX
    assert len(E._CACHE) == E._CACHE_MAX  # full hot set, never more


def test_eviction_disabled_is_the_one_variable_falsifier(monkeypatch):
    """Flip ONE variable — make _cache_put stop evicting — and the bound must break."""

    def no_evict(key, vec):
        E._CACHE[key] = vec
        E._CACHE.move_to_end(key)
        # deliberately no popitem(last=False): the pre-fix behaviour

    monkeypatch.setattr(E, "_cache_put", no_evict, raising=True)
    h = E.HashingEmbedding()
    for i in range(2000):
        h.embed_one(f"unique-query-{i}")
    assert len(E._CACHE) == 2000  # write-count growth returns -> RED against the cap claim


def test_lru_promotes_a_hit_and_evicts_the_coldest_not_fifo(monkeypatch):
    """A cache hit must refresh recency, so the coldest (not the oldest-inserted) goes."""
    monkeypatch.setattr(E, "_CACHE_MAX", 4, raising=True)
    h = E.HashingEmbedding()
    for i in range(4):
        h.embed_one(f"k{i}")           # order: k0 k1 k2 k3
    h.embed_one("k0")                  # promote k0 -> k1 k2 k3 k0
    h.embed_one("k4")                  # insert -> evict k1
    keys = [k[1] for k in E._CACHE.keys()]
    assert ("hashing", "k0") in E._CACHE
    assert ("hashing", "k1") not in E._CACHE
    assert keys == ["k2", "k3", "k0", "k4"]


def test_eviction_never_changes_a_vector_value():
    """Bounding is a memory policy only: every vector is still the exact deterministic value."""
    h = E.HashingEmbedding()
    reference = h.embed_one("stable text")
    for i in range(200):
        h.embed_one(f"filler-{i}")     # force many evictions
    after = h.embed_one("stable text")  # recomputed after eviction
    assert after == reference
    assert len(after) == E.DIM
    assert abs(sum(x * x for x in after) - 1.0) < 1e-9  # L2-normalized contract intact


def test_http_embed_builds_one_shared_client_for_n_calls(monkeypatch):
    """N embeds through the real pooled path construct exactly one httpx client."""
    stub = _StubClient()
    built = []

    class FakeHttpx:
        AsyncClient = staticmethod(lambda **kw: _record(stub, kw))

    def _record(s, kw):
        built.append(kw)
        return s

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", FakeHttpx.AsyncClient, raising=True)
    E._HTTP_CLIENT = None
    adapter = E.HttpEmbedding(base_url="http://embed.test/v1", api_key="k")

    async def run():
        for i in range(3):
            await adapter.embed([f"text-{i}"])
        await E.aclose_embedding_client()

    asyncio.run(run())
    assert len(built) == 1                 # one construction, not three
    assert stub.posts == 3                 # three real requests still went through
    assert stub.closed == 1                # shutdown hook released it exactly once
    assert E._HTTP_CLIENT is None          # hook clears the handle (next boot re-builds lazily)


def test_per_call_client_is_the_falsifier_and_injected_client_survives(monkeypatch):
    """Falsifier: reverting to a per-call client makes constructions equal the call count."""
    stub = _StubClient()
    built = []

    def fake_ctor(**kw):
        built.append(kw)
        return stub

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", fake_ctor, raising=True)
    adapter = E.HttpEmbedding(base_url="http://embed.test/v1", api_key="k")

    async def per_call():
        # The pre-fix shape: a fresh AsyncClient per embed, closed each time.
        for i in range(3):
            client = httpx.AsyncClient(timeout=adapter.timeout_s)
            try:
                await client.post("http://embed.test/v1/embeddings", json={"input": [f"t{i}"]})
            finally:
                await client.aclose()

    asyncio.run(per_call())
    assert len(built) == 3                # the hole: three handshakes for three embeds

    # Injected client contract (D507) is untouched: the adapter never closes the caller's client.
    injected = _StubClient()
    other = E.HttpEmbedding(base_url="http://embed.test/v1", api_key="k", client=injected)

    async def with_injected():
        await other.embed(["one"])
        await other.embed(["two"])

    asyncio.run(with_injected())
    assert injected.closed == 0           # caller-owned client not closed by the calls
    assert injected.posts == 2


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
