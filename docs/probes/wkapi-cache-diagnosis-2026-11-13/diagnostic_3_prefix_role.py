"""WKAPI cache diagnosis, diagnostic 3 — is the cacheable run the user prefix, and only the user prefix?

Reconstructed from the session transcript (2026-11-13). Original scratch removed with the
parallel lane's vanish. This arm held a ~20k-token user prefix fixed and varied ONLY the
tail — the decisive experiment for the "user role is what the prefix cache sees" hypothesis.
Result at the time: `user=BIG` repeated byte-identically reported cached=20042/20045 (100%);
`user=OTHER` (same length, different first tokens) reported cached=None.

Run:
    NEXUS_LLM_BASE_URL=... NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_MID=gpt-6-sol \
    uv run python diagnostic_3_prefix_role.py
"""
from __future__ import annotations

import asyncio
import os
import sys

import httpx

BASE = (os.environ.get("NEXUS_LLM_BASE_URL") or "").strip().rstrip("/")
KEY = (os.environ.get("NEXUS_LLM_API_KEY") or "").strip()
MODEL = (os.environ.get("NEXUS_LLM_MODEL_MID") or "gpt-6-sol").strip()

BIG = "\n".join(
    f"RULE {i:04d}: fixed sentence used only to measure whether this role is tokenised. "
    f"It carries no instruction and no data."
    for i in range(1, 220)
)


async def once(client, label, messages, n=3):
    for i in range(n):
        body = {"model": MODEL, "messages": messages, "max_tokens": 12,
                "temperature": 0, "stream": True,
                "stream_options": {"include_usage": True}}
        r = await client.post(
            f"{BASE}/chat/completions",
            headers={"authorization": f"Bearer {KEY}",
                     "content-type": "application/json"}, json=body)
        if r.status_code >= 400:
            print(f"{label}[{i + 1}] HTTP {r.status_code} {r.text[:140]}")
            continue
        usage = {}
        for line in (r.text or "").splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            c = line[5:].strip()
            if not c or c == "[DONE]":
                continue
            try:
                import json as _json
                ev = _json.loads(c)
            except Exception:
                continue
            if ev.get("usage"):
                usage = ev["usage"]
        import json as _json
        pt = usage.get("prompt_tokens")
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        print(f"{label}[{i + 1}] prompt={pt} cached={cached}")


async def main() -> int:
    if not BASE or not KEY:
        print("SKIP: NEXUS_LLM_BASE_URL / NEXUS_LLM_API_KEY not supplied")
        return 2
    async with httpx.AsyncClient(timeout=180.0) as client:
        print(f"model={MODEL} big_chars={len(BIG)}")
        await once(client, "user=BIG fixed, tail identical",
                   [{"role": "user", "content": BIG + "\n\nSay exactly: PING."}], n=3)
        other = BIG.replace("RULE 0001", "RULE 9999")
        await once(client, "user=OTHER same length, head differs",
                   [{"role": "user", "content": other + "\n\nSay exactly: PING."}], n=2)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
