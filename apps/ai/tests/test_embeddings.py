"""D356 — embedding adapter contract (DECISIONS D3; AGENT_CONTRACT §9).

Pins `models/embeddings.py`, the dev/test embedding layer, which is DB-free and
network-free when the hashing provider is used (the default). The semantic-HTTP
provider is only exercised for its *construction guards* — its network path is
`pragma: no cover` and must never run in tests.

Contract points locked:
* dim is fixed at 1024 everywhere (DECISIONS D3) — the constructor refuses anything else;
* `HashingEmbedding` is deterministic, cached by content, and emits L2-normalized unit
  vectors (so cosine == dot product); it is explicitly NON-semantic (`semantic=False`)
  — a lexical hashing trick, not meaning;
* `HttpEmbedding` refuses to be built without base_url + api_key (building it silently
  would be a quality lie), and refuses a non-1024 dim;
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


class TestFactory:
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
