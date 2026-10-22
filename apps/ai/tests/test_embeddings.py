"""D356 — embedding adapter contract (DECISIONS D3; AGENT_CONTRACT §9).

Pins `models/embeddings.py`, the dev/test embedding layer, which is DB-free and
network-free when the hashing provider is used (the default). D507 changed the rule for the
semantic provider: the *real* endpoint is still never contacted, but the HTTP path is now
driven through the constructor's `client` seam by a stub that speaks the OpenAI-compatible
`/embeddings` contract. It used to be declared `pragma: no cover` and "must never run in
tests", and that declaration is what let a `NameError` ship in the only method that produces
semantic recall - see the D507 section.

Contract points locked:
* dim is fixed at 1024 everywhere (DECISIONS D3) — the constructor refuses anything else;
* `HashingEmbedding` is deterministic, cached by content, and emits L2-normalized unit
  vectors (so cosine == dot product); it is explicitly NON-semantic (`semantic=False`)
  — a lexical hashing trick, not meaning;
* `HttpEmbedding` refuses to be built without base_url + api_key (building it silently
  would be a quality lie), and refuses a non-1024 dim;
* `HttpEmbedding.embed` sends one request per call, lands each row on the input the
  endpoint's own `index` names (the response array is not promised in request order), caches
  by content so a repeat costs no call, and REFUSES an answer that leaves a row unset -
  a zero vector is retrievable by nothing and would be stored as if it meant something;
* the factory degrades an http provider with missing creds back to hashing rather than
  raising — the same no-silent-lie discipline as the LLM factory (§105).
"""

from __future__ import annotations

import math

import pytest

from nexus_ai.models import embeddings as E


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


class TestHashingEmbeddingSync:
    def test_dim_fixed(self):
        h = E.HashingEmbedding()
        assert h.name == "hashing"
        assert h.dim == 1024

    def test_dim_must_be_1024(self):
        with pytest.raises(ValueError):
            E.HashingEmbedding(dim=512)

    def test_embed_one_length(self):
        v = E.HashingEmbedding().embed_one("ramen hong kong")
        assert len(v) == 1024

    def test_embed_one_normalized(self):
        v = E.HashingEmbedding().embed_one("ramen hong kong")
        norm = math.sqrt(sum(x * x for x in v))
        assert abs(norm - 1.0) < 1e-9

    def test_embed_one_deterministic(self):
        h = E.HashingEmbedding()
        assert h.embed_one("ramen hong kong") == h.embed_one("ramen hong kong")

    def test_cache_copy_isolated(self):
        # embed_one returns a *copy*; mutating the result must not poison the cache
        h = E.HashingEmbedding()
        v1 = h.embed_one("stable input")
        v1[0] = 999.0
        v2 = h.embed_one("stable input")
        assert v2[0] != 999.0

    def test_cosine_identical_is_one(self):
        h = E.HashingEmbedding()
        a = h.embed_one("same text")
        b = h.embed_one("same text")
        assert abs(_cos(a, b) - 1.0) < 1e-9

    def test_cosine_shared_gt_disjoint(self):
        h = E.HashingEmbedding()
        shared = _cos(h.embed_one("ramen hong kong"), h.embed_one("ramen tokyo"))
        disjoint = _cos(
            h.embed_one("ramen hong kong"), h.embed_one("completely unrelated words")
        )
        assert shared > disjoint
        assert disjoint == 0.0  # no surface tokens in common

    def test_embed_one_empty_string(self):
        v = E.HashingEmbedding().embed_one("")
        assert len(v) == 1024
        assert all(x == 0.0 for x in v)


class TestHashingEmbeddingAsync:
    async def test_health_shape(self):
        h = E.HashingEmbedding()
        hc = await h.health()
        assert hc["provider"] == "hashing"
        assert hc["ok"] is True
        assert hc["dim"] == 1024
        assert hc["semantic"] is False
        assert isinstance(hc["note"], str) and hc["note"]

    async def test_embed_batch(self):
        h = E.HashingEmbedding()
        out = await h.embed(["alpha", "beta"])
        assert len(out) == 2
        assert all(len(v) == 1024 for v in out)
        # each row is a unit vector
        assert all(abs(math.sqrt(sum(x * x for x in v)) - 1.0) < 1e-9 for v in out)


class TestHttpEmbeddingGuards:
    def test_missing_creds_raises(self):
        with pytest.raises(RuntimeError):
            E.HttpEmbedding(base_url="", api_key="")

    def test_dim_mismatch_raises(self):
        with pytest.raises(ValueError):
            E.HttpEmbedding(base_url="http://x", api_key="k", dim=256)

    def test_built_with_creds_is_http(self):
        h = E.HttpEmbedding(base_url="http://x", api_key="k")
        assert h.name == "http"
        assert h.dim == 1024


def _vector(scale: float, dim: int = E.DIM) -> list[float]:
    return [float(scale)] * dim


class _StubResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _StubEmbeddingsClient:
    """The OpenAI-compatible `/embeddings` contract, with the response's own `index` values.

    `data` is handed over exactly as the test declares it, so a test can send the rows back
    in the wrong order, short, or with an index that was never asked for - the shapes the
    adapter must survive or refuse, not the shape that is convenient to assert against.
    """

    def __init__(self, data: list[dict]):
        self._data = data
        self.calls: list[dict] = []
        self.closed = 0

    async def post(self, url: str, headers: dict | None = None,
                   json: dict | None = None) -> _StubResponse:
        self.calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        return _StubResponse({"data": self._data})

    async def aclose(self) -> None:
        self.closed += 1


def _http(client: _StubEmbeddingsClient) -> E.HttpEmbedding:
    return E.HttpEmbedding(base_url="http://embed.test/v1", api_key="k", client=client)


class TestHttpEmbeddingRequest:
    """D507 — the method that produces semantic recall had never been called by a test.

    `conftest.offline_env` clears `embeddings._CACHE` around every test, which is what makes
    a call-counting assertion here safe: a row cached by another test would answer this
    one's request from cache and hide the call it is measuring.
    """

    async def test_one_request_per_call_with_the_contract_body(self):
        client = _StubEmbeddingsClient([{"index": i, "embedding": _vector(i)} for i in range(3)])
        await _http(client).embed(["alpha", "beta", "gamma"])
        assert len(client.calls) == 1
        call = client.calls[0]
        assert call["url"] == "http://embed.test/v1/embeddings"
        assert call["headers"]["authorization"] == "Bearer k"
        assert call["json"]["input"] == ["alpha", "beta", "gamma"]
        assert call["json"]["model"] == "nexus-embed-1024"
        assert call["json"]["dimensions"] == E.DIM

    async def test_each_row_lands_on_the_input_its_index_names(self):
        # rows arrive in the WRONG order: `index` is the position in `input`, so placement
        # must follow it rather than the arrival order of the array.
        client = _StubEmbeddingsClient([{"index": i, "embedding": _vector(i)}
                                        for i in reversed(range(4))])
        out = await _http(client).embed(["a", "b", "c", "d"])
        assert [v[0] for v in out] == [0.0, 1.0, 2.0, 3.0]
        assert all(len(v) == E.DIM for v in out)

    async def test_a_cached_text_costs_no_second_request(self):
        client = _StubEmbeddingsClient([{"index": 0, "embedding": _vector(7)}])
        adapter = _http(client)
        first = await adapter.embed(["leak-me"])
        second = await adapter.embed(["leak-me"])
        assert len(client.calls) == 1
        assert first == second

    async def test_a_short_answer_refuses_rather_than_storing_a_zero(self):
        client = _StubEmbeddingsClient([{"index": 0, "embedding": _vector(1)}])
        with pytest.raises(RuntimeError, match=r"1 row\(s\) for 2 input\(s\)"):
            await _http(client).embed(["one", "two"])

    async def test_a_duplicated_index_leaves_a_row_unset_and_refuses(self):
        client = _StubEmbeddingsClient([{"index": 0, "embedding": _vector(1)},
                                        {"index": 0, "embedding": _vector(1)}])
        with pytest.raises(RuntimeError, match=r"left 1 of 2 row\(s\) unset"):
            await _http(client).embed(["one", "two"])

    async def test_an_index_never_asked_for_refuses(self):
        client = _StubEmbeddingsClient([{"index": 5, "embedding": _vector(1)}])
        with pytest.raises(RuntimeError, match=r"index 5, outside the 1 input"):
            await _http(client).embed(["only"])

    async def test_a_wrong_dim_refuses_rather_than_storing_it(self):
        client = _StubEmbeddingsClient([{"index": 0, "embedding": [1.0, 2.0, 3.0]}])
        with pytest.raises(RuntimeError, match="refusing to store a mismatched vector"):
            await _http(client).embed(["only"])

    async def test_an_injected_client_is_not_closed_by_the_call(self):
        # the adapter does not own a client it was handed; closing it would break the caller.
        client = _StubEmbeddingsClient([{"index": 0, "embedding": _vector(1)}])
        await _http(client).embed(["one"])
        assert client.closed == 0


class TestFactory:
    def test_http_with_creds_builds_the_http_adapter(self):
        class Settings:
            embedding_provider = "http"
            embedding_base_url = "http://embed.test/v1"
            embedding_api_key = "k"
            embedding_model = ""

        adapter = E.get_embedding_adapter(Settings())
        assert isinstance(adapter, E.HttpEmbedding)
        assert adapter.model == "nexus-embed-1024"

    def test_http_missing_creds_degrades_to_hashing(self):
        class Settings:
            embedding_provider = "http"
            embedding_base_url = ""
            embedding_api_key = ""
            embedding_model = ""

        adapter = E.get_embedding_adapter(Settings())
        assert isinstance(adapter, E.HashingEmbedding)

    def test_hashing_provider_returns_hashing(self):
        class Settings:
            embedding_provider = "hashing"
            embedding_base_url = ""
            embedding_api_key = ""
            embedding_model = ""

        adapter = E.get_embedding_adapter(Settings())
        assert isinstance(adapter, E.HashingEmbedding)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
