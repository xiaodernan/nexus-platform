"""WKAPI cache diagnosis, diagnostic 4 — is the proxy's usage accounting even stable?

Reconstructed from the session transcript (2026-11-13). Original scratch removed with the
parallel lane's vanish. Eight identical requests; if prompt_tokens varies across them,
the provider's accounting is approximate, not a meter — which is why this repo treats the
cached_tokens signal as trustworthy only when it is non-zero and the text is deterministic.

Run:
    NEXUS_LLM_BASE_URL=... NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_MID=gpt-6-sol \
    uv run python diagnostic_4_stability.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx

BASE = (os.environ.get("NEXUS_LLM_BASE_URL") or "").strip().rstrip("/")
KEY = (os.environ.get("NEXUS_LLM_API_KEY") or "").strip()
MODEL = (os.environ.get("NEXUS_LLM_MODEL_MID") or "gpt-6-sol").strip()


async def once(client):
    body = {"model": MODEL,
            "messages": [{"role": "user", "content": "Say exactly: PING. reply json {\"x\":1}"}],
            "max_tokens": 8, "temperature": 0,
            "stream": True, "stream_options": {"include_usage": True},
            "response_format": {"type": "json_object"}}
    r = await client.post(
        f"{BASE}/chat/completions",
        headers={"authorization": f"Bearer {KEY}",
                 "content-type": "application/json"}, json=body)
    usage = {}
    for line in (r.text or "").splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        c = line[5:].strip()
        if not c or c == "[DONE]":
            continue
        try:
            ev = json.loads(c)
        except json.JSONDecodeError:
            continue
        if ev.get("usage"):
            usage = ev["usage"]
    if r.status_code >= 400:
        return (f"HTTP{r.status_code}", None, None)
    return (usage.get("prompt_tokens"),
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            usage.get("completion_tokens"))


async def main():
    if not BASE or not KEY:
        print("SKIP")
        return 2
    async with httpx.AsyncClient(timeout=120.0) as c:
        rows = [await once(c) for _ in range(8)]
    for i, (p, ca, co) in enumerate(rows, 1):
        print(f"  call {i}: prompt={p} cached={ca} completion={co}")
    ps = [p for p, _, _ in rows if isinstance(p, int)]
    if len(ps) > 1:
        print(f"  spread: min={min(ps)} max={max(ps)} ratio={max(ps) / max(1, min(ps)):.2f}x  distinct={sorted(set(ps))}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
