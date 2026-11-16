"""LIVE probe of the embedding lane — opt-in, never CI, never commits a key.

The RAG vector lane (`HttpEmbedding`) speaks `{base}/embeddings` with `dimensions: 1024`.
Whether the configured provider can actually answer it is exactly the question the app's
keyword lane silently hides behind `semantic = False` — the hashing adapter still answers
token-similarity, not meaning.

Measured 2026-11-16 on the operator's provider (through the host's Clash Verge egress,
Clash at 127.0.0.1:7897 — the host is geo-blocked to direct):

    text-embedding-3-small  HTTP 503  model_not_found  ("分组 GPT特价 下模型 … 无可用渠道")
    text-embedding-3-large  HTTP 503  model_not_found  (同)
    text-embedding-ada-002  TCP/proxy error            (no channel)
    gpt-6.1-terra           HTTP 404  model_not_found  (chat model, not an embedding account)
    nexus-embed-1024        HTTP 503  model_not_found  (默认型號並未注册 upstream)

Exit 0 with "AN EMBEDDING MODEL IS AVAILABLE" when at least one candidate answered a
1024-d vector; exit 1 with the full matrix (and copy-pasteable error bodies) otherwise —
which is the current honest state: **no live embedding model is served on this account**,
so the vector lane keeps running lexical-hashing only and the docs say so.

Run: NEXUS_EMBEDDING_BASE_URL=https://api.aizzz.xyz/v1 NEXUS_EMBEDDING_API_KEY=sk-... uv run python live_embedding_probe.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("NEXUS_EMBEDDING_BASE_URL", "https://api.aizzz.xyz/v1").rstrip("/")
KEY = (os.environ.get("NEXUS_EMBEDDING_API_KEY") or os.environ.get("NEXUS_LLM_API_KEY") or "").strip()

CANDIDATES = [
    # OpenAI-first-party shapes (documented for the operator's provider choice)
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
    # Provider-shaped guesses (e.g. what a private distributor group might expose)
    "nexus-embed-1024",
    "text-embedding-3",
    # Sanity: the chat model must NOT be accepted as an embedding lane answer
    "gpt-6.1-terra",
]

PROBE = "香港荔枝角の拉麵 / Hong Kong ramen at Lai Chi Kok"


def probe_one(model: str) -> tuple[bool, str]:
    body = json.dumps({"model": model, "dimensions": 1024, "input": [PROBE]}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/embeddings",
        data=body,
        headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:400].decode("utf-8", "replace")
        return False, f"HTTP {exc.code} {detail}"
    except Exception as exc:
        return False, f"{type(exc).__name__} {exc}"
    rows = data.get("data") or []
    dims = {len((row.get("embedding") or [])) for row in rows}
    if not rows:
        return False, "zero rows returned"
    if dims != {1024}:
        return False, f"dim {sorted(dims)} — contract requires 1024 (DECISIONS D3)"
    return True, f"dim 1024, {len(rows)} row(s)"


def main() -> int:
    if not KEY:
        print("SKIP: NEXUS_EMBEDDING_API_KEY or NEXUS_LLM_API_KEY is not supplied for a live run")
        return 2

    # models list, when the provider serves it, is the freshest source of truth
    print(f"GET {BASE}/models ...")
    try:
        req = urllib.request.Request(f"{BASE}/models", headers={"authorization": f"Bearer {KEY}"})
        with urllib.request.urlopen(req, timeout=90) as resp:
            models = [m.get("id") for m in (json.loads(resp.read()).get("data") or [])]
        print("models:", ", ".join(str(m) for m in models))
    except urllib.error.HTTPError as exc:
        print(f"models list HTTP {exc.code}: {exc.read()[:300].decode('utf-8', 'replace')}")
    except Exception as exc:
        print(f"models list {type(exc).__name__}: {exc}")

    print(f"\nPOST {BASE}/embeddings (dimensions=1024, input≈{PROBE!r})")
    passed = 0
    log: list[str] = []
    for model in CANDIDATES:
        ok, detail = probe_one(model)
        status = "PASS" if ok else "FAIL"
        log.append(f"  {status}  {model:30s}  {detail}")
        print(log[-1])
        passed += 1 if ok else 0

    print()
    if passed:
        print(f"AN EMBEDDING MODEL IS AVAILABLE — {passed} of {len(CANDIDATES)} candidate(s) answered 1024-d vectors")
        return 0

    print("NO LIVE EMBEDDING MODEL IS AVAILABLE on this account — contracts: HttpEmbedding / keyword lane stands;")
    print("ask the operator to enable one in the provider's console (or a different distributor group),")
    print("then re-run this probe — the CI/adapter contract did not change.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
