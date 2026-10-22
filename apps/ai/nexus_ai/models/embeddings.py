"""`EmbeddingAdapter` — `HashingEmbedding` (dev default) and `HttpEmbedding`.

Dim is fixed at **1024** everywhere (DECISIONS D3, `chunks.embedding vector(1024)`).
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol, Sequence, runtime_checkable

DIM = 1024

_CACHE: dict[tuple[str, str], tuple[float, ...]] = {}


@runtime_checkable
class EmbeddingAdapter(Protocol):
    name: str
    dim: int

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

    def __init__(self, dim: int = DIM):
        if dim != DIM:
            raise ValueError(f"embedding dim is fixed at {DIM} (DECISIONS D3), got {dim}")

    async def health(self) -> dict[str, object]:
        return {"provider": self.name, "ok": True, "dim": self.dim,
                "semantic": False,
                "note": "dev-only lexical hashing, not a semantic model"}

    def embed_one(self, text: str) -> list[float]:
        cached = _CACHE.get((self.name, text))
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
        _CACHE[(self.name, text)] = tuple(out)
        return out

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self.embed_one(t or "") for t in texts]


class HttpEmbedding:
    """OpenAI-compatible `/embeddings` endpoint. Base url + key from env only."""

    name = "http"
    dim = DIM

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
                "semantic": True}

    async def embed(self, texts: Sequence[str]) -> list[list[float] | None]:  # pragma: no cover - network
        import httpx

        missing = [t for t in texts]
        out: list[list[float] | None] = [None] * len(missing)
        # batched, and cached by content hash (§9)
        todo: list[tuple[int, str]] = []
        for i, t in enumerate(missing):
            hit = _CACHE.get((self.model, t or ""))
            if hit is not None:
                out[i] = list(hit)
            else:
                todo.append((i, t or ""))
        if todo:
            # Group by model to minimize API calls when multiple providers are configured
            by_model: Dict[str, list[tuple[int, str]]] = {}
            for i, t in todo:
                key = self.model or "hashing"
                by_model.setdefault(key, []).append((i, t))
            client = self._client or httpx.AsyncClient(timeout=self.timeout_s)
            try:
                resp = await client.post(
                    f"{self.base_url}/embeddings",
                    headers={"authorization": f"Bearer {self.api_key}"},
                    json={"model": model_key, "dimensions": self.dim,
                          "input": [t for _, t in items]},
                )
                resp.raise_for_status()
                data = sorted(resp.json()["data"], key=lambda d: d["index"])
                for (i, t), item in zip(todo, data):
                    vec = [float(v) for v in item["embedding"]]
                    if len(vec) != self.dim:
                        raise RuntimeError(
                            f"embedding endpoint returned dim {len(vec)}, contract requires "
                            f"{self.dim} (DECISIONS D3) — refusing to store a mismatched vector")
                    out[i] = vec
                    _CACHE[(self.model, t)] = tuple(vec)
            finally:
                if self._client is None:
                    await client.aclose()
        return [v if v is not None else [0.0] * self.dim for v in out]


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
