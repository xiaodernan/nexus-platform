"""`EmbeddingAdapter` — `HashingEmbedding` (dev default) and `HttpEmbedding`.

Dim is fixed at **1024** everywhere (DECISIONS D3, `chunks.embedding vector(1024)`).
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import OrderedDict
from typing import Any, Protocol, Sequence, runtime_checkable

DIM = 1024

# D974: the cache key embeds the RAW query / chunk text, which is external input (a RAG
# query from routes_rag.py, a document chunk from rag/embed.py). Each value is a 1024-d
# float tuple (~32 KB). An unbounded dict therefore grows with every distinct text ever
# seen and is directly attacker-/traffic-driven memory exhaustion — measured 2000 distinct
# queries -> 2000 entries -> ~62 MiB with the DEV-DEFAULT HashingEmbedding (no infra needed).
# D903/D972 bounded the tool-result cache; this is the SAME class of hole on a different,
# never-touched module. Keep it an LRU so hot queries still hit: O(1) get+move_to_end, and
# popitem(last=False) evicts the coldest entry once the cap is crossed. 4096 x ~32 KB is a
# ~128 MiB ceiling — generous for a hot set, bounded for a long-running worker.
_CACHE_MAX = 4096
_CACHE: OrderedDict[tuple[str, str], tuple[float, ...]] = OrderedDict()


def _cache_get(key: tuple[str, str]) -> tuple[float, ...] | None:
    """D974: LRU read — a hit is promoted so it survives the next eviction."""
    hit = _CACHE.get(key)
    if hit is not None:
        _CACHE.move_to_end(key)
    return hit


def _cache_put(key: tuple[str, str], vec: tuple[float, ...]) -> None:
    """D974: LRU write — cap the cache by entry count, never by write count (D972's lesson)."""
    _CACHE[key] = vec
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


# D974: one pooled httpx client for ALL HttpEmbedding instances in this process, mirroring
# D969's aclose_platform_client. The factory still returns a FRESH adapter per call (that
# contract is unchanged); only the expensive TCP(+TLS) connection is shared. Lazily built so
# importing this module touches no network; injected clients (tests) bypass it entirely.
_HTTP_CLIENT: Any = None


def _shared_client(timeout_s: float):
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None:
        import httpx
        _HTTP_CLIENT = httpx.AsyncClient(timeout=timeout_s)
    return _HTTP_CLIENT


async def aclose_embedding_client() -> None:
    """D974: release the pooled client on app shutdown; a no-op when never built (offline)."""
    global _HTTP_CLIENT
    if _HTTP_CLIENT is not None:
        aclose = getattr(_HTTP_CLIENT, "aclose", None)
        if aclose is not None:
            await aclose()
        _HTTP_CLIENT = None


@runtime_checkable
class EmbeddingAdapter(Protocol):
    name: str
    dim: int
    #: D705: whether the space this adapter writes is SEMANTIC. The search lane reads this
    #: to decide what a cosine from it may claim: a semantic cosine is a witness that a row
    #: answers the query, a lexical one is a second copy of the keyword lane. Published on
    #: the adapter rather than discovered by asking `health()`, because the search path
    #: needs the answer without an await on, and the two cannot drift if `health()` reports
    #: this attribute. An adapter that does not declare it is not trusted to testify.
    semantic: bool

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

    async def health(self) -> dict[str, object]: ...


class HashingEmbedding:
    """Deterministic hashing-trick embedding. **DEV / TEST ONLY.**

    NOT semantically meaningful: it is a signed bag-of-ngrams projection, so the
    cosine it produces measures *shared surface tokens*, not meaning. Real semantic
    recall requires `NEXUS_EMBEDDING_PROVIDER=http` against a 1024-d model. It is used
    offline because it is stable, needs no network and no GPU, and lets the pgvector
    code path be exercised end to end. Cached by content hash (AGENT_CONTRACT §9).
    """

    name = "hashing"
    dim = DIM
    #: D705: a signed bag-of-ngrams projection measures SHARED SURFACE TOKENS, not meaning -
    #: the class docstring has said so since it was written, and `health()` reported it as
    #: `semantic: False` - but nothing in the search lane read that verdict, so the cosine
    #: was fused into `relevance` exactly as a semantic one was.
    semantic = False

    def __init__(self, dim: int = DIM):
        if dim != DIM:
            raise ValueError(f"embedding dim is fixed at {DIM} (DECISIONS D3), got {dim}")

    async def health(self) -> dict[str, object]:
        return {"provider": self.name, "ok": True, "dim": self.dim,
                "semantic": self.semantic,
                "note": "dev-only lexical hashing, not a semantic model"}

    def embed_one(self, text: str) -> list[float]:
        cached = _cache_get((self.name, text))  # D974: LRU read
        if cached is not None:
            return list(cached)
        vec = [0.0] * self.dim
        for tok in _tokens(text):
            digest = hashlib.blake2b(tok.encode("utf-8"), digest_size=8).digest()
            h = int.from_bytes(digest, "big")
            idx = h % self.dim
            sign = 1.0 if (h >> 63) & 1 == 0 else -1.0
            vec[idx] += sign
        for i in range(self.dim):
            if vec[i]:
                vec[i] = math.copysign(1.0 + math.log1p(abs(vec[i])), vec[i])
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        out = [v / norm for v in vec]
        _cache_put((self.name, text), tuple(out))  # D974: LRU write (bounded)
        return out

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self.embed_one(t or "") for t in texts]


class HttpEmbedding:
    """OpenAI-compatible `/embeddings` endpoint. Base url + key from env only."""

    name = "http"
    dim = DIM
    #: D705: the endpoint this class speaks is a real 1024-d embedding model, so its cosine
    #: is meaning and may stand alone as relevance.
    semantic = True

    def __init__(self, *, base_url: str, api_key: str, model: str = "",
                 timeout_s: float = 20.0, client=None, dim: int = DIM):
        if not base_url or not api_key:
            raise RuntimeError(
                "HttpEmbedding needs NEXUS_EMBEDDING_BASE_URL + NEXUS_EMBEDDING_API_KEY; "
                "falling back to HashingEmbedding would be a silent quality lie, so the "
                "factory keeps NEXUS_EMBEDDING_PROVIDER=hashing instead."
            )
        if dim != DIM:
            raise ValueError(f"embedding dim is fixed at {DIM} (DECISIONS D3), got {dim}")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model or "nexus-embed-1024"
        self.timeout_s = timeout_s
        self._client = client

    async def health(self) -> dict[str, object]:
        return {"provider": self.name, "ok": True, "dim": self.dim, "model": self.model,
                "semantic": self.semantic}

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """One `/embeddings` request per call, rows placed by the endpoint's own `index`.

        D507: the response's `data` array is not promised in request order, and a row that
        never arrived is a provider failure, not a zero to store - `chunks.embedding` is read
        by cosine, so a zero vector makes that row permanently unretrievable.
        """
        out: list[list[float] | None] = [None] * len(texts)
        # cached by content hash (AGENT_CONTRACT §9): a re-embedded chunk costs no call
        todo: list[tuple[int, str]] = []
        for i, t in enumerate(texts):
            hit = _cache_get((self.model, t or ""))  # D974: LRU read
            if hit is not None:
                out[i] = list(hit)
            else:
                todo.append((i, t or ""))
        if todo:
            # D974: reuse the process-pooled client instead of one TCP(+TLS) handshake per
            # embed call. An injected client is still used verbatim and NEVER closed by the
            # call (the caller owns it); the shared client is closed by the lifespan hook.
            client = self._client or _shared_client(self.timeout_s)
            # D974: no per-call close — the pooled client outlives this request and is released
            # by aclose_embedding_client() at shutdown; an injected client is the caller's to own.
            resp = await client.post(
                f"{self.base_url}/embeddings",
                headers={"authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "dimensions": self.dim,
                      "input": [t for _, t in todo]},
            )
            resp.raise_for_status()
            data = resp.json()["data"]
            if len(data) != len(todo):
                raise RuntimeError(
                    f"embedding endpoint answered {len(data)} row(s) for "
                    f"{len(todo)} input(s) - a short answer would leave rows unset")
            for item in data:
                index = item["index"]
                if not isinstance(index, int) or not 0 <= index < len(todo):
                    raise RuntimeError(
                        f"embedding endpoint returned index {index!r}, outside the "
                        f"{len(todo)} input(s) it was sent")
                i, text = todo[index]
                vec = [float(v) for v in item["embedding"]]
                if len(vec) != self.dim:
                    raise RuntimeError(
                        f"embedding endpoint returned dim {len(vec)}, contract requires "
                        f"{self.dim} (DECISIONS D3) — refusing to store a mismatched vector")
                out[i] = vec
                _cache_put((self.model, text), tuple(vec))  # D974: LRU write (bounded)
        unfilled = [i for i, v in enumerate(out) if v is None]
        if unfilled:
            raise RuntimeError(
                f"embedding endpoint left {len(unfilled)} of {len(out)} row(s) unset "
                f"(positions {unfilled[:5]}) - refusing to store a zero vector")
        return [v for v in out if v is not None]


_TOKEN_RE = re.compile(r"[a-z0-9]+|[㐀-鿿]")


def _tokens(text: str):
    low = (text or "").lower()
    uni = _TOKEN_RE.findall(low)
    yield from uni
    # char bigrams for CJK give the lexical signal a bit of context
    cjk = [c for c in low if "\u3400" <= c <= "\u9fff"]
    for a, b in zip(cjk, cjk[1:]):
        yield a + b


def get_embedding_adapter(settings=None) -> EmbeddingAdapter:
    from nexus_ai.config import get_settings

    settings = settings or get_settings()
    if settings.embedding_provider == "http":
        try:
            return HttpEmbedding(base_url=settings.embedding_base_url,
                                 api_key=settings.embedding_api_key,
                                 model=settings.embedding_model)
        except RuntimeError:
            return HashingEmbedding()
    return HashingEmbedding()
