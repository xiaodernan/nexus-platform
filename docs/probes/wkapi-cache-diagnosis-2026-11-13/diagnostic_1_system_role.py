"""WKAPI cache diagnosis, diagnostic 1 — does the proxy count a large `system` message?

Reconstructed from the session transcript that originally ran this probe (2026-11-13), when the
parallel lane built the frozen-prefix solution and then vanished from the working tree that same
night (see docs/probes/wkapi-cache-diagnosis-2026-11-13/README.md). The original scratch file was
removed with it. The code below is byte-for-byte the shape the original ran; the answers are
recorded in the README.

Run:
    NEXUS_LLM_BASE_URL=... NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_MID=gpt-6-sol \
    uv run python diagnostic_1_system_role.py
"""
from __future__ import annotations

import asyncio
import os

import httpx

BASE = (os.environ.get("NEXUS_LLM_BASE_URL") or "").strip().rstrip("/")
KEY = (os.environ.get("NEXUS_LLM_API_KEY") or "").strip()
MODEL = (os.environ.get("NEXUS_LLM_MODEL_MID") or "gpt-6-sol").strip()

BIG = "\n".join(
    f"RULE {i:04d}: fixed sentence used only to measure whether this role is tokenised. "
    f"It carries no instruction and no data."
    for i in range(1, 61)
)


async def once(client, label, messages, *, json_mode, n=2):
    for i in range(n):
        body = {"model": MODEL, "messages": messages, "max_tokens": 12,
                "temperature": 0, "stream": True,
                "stream_options": {"include_usage": True}}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        r = await client.post(
            f"{BASE}/chat/completions",
            headers={"authorization": f"Bearer {KEY}",
                     "content-type": "application/json"}, json=body)
        if r.status_code >= 400:
            print(f"{label} HTTP {r.status_code} {r.text[:140]}")
            return
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
        print(f"{label}[{i + 1}] prompt={pt} cached={cached} completion={usage.get('completion_tokens')}")


async def main() -> int:
    if not BASE or not KEY:
        print("SKIP: NEXUS_LLM_BASE_URL / NEXUS_LLM_API_KEY not supplied")
        return 2
    async with httpx.AsyncClient(timeout=120.0) as client:
        print(f"model={MODEL} big_chars={len(BIG)}")
        await once(client, "chat   system=BIG user=hi",
                   [{"role": "system", "content": BIG}, {"role": "user", "content": "hi"}],
                   json_mode=False)
        await once(client, "json   system=BIG user='return json please'",
                   [{"role": "system", "content": BIG},
                    {"role": "user", "content": "return json please"}], json_mode=True)
        await once(client, "json   system=small user=BIG+'return json'",
                   [{"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": BIG + "\n\nreturn json please"}], json_mode=True)
        await once(client, "json   system=small user='return json please'",
                   [{"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "return json please"}], json_mode=True)
        other = BIG.replace("RULE 0001", "RULE 9999")
        await once(client, "json   system=small user=OTHER+'return json'",
                   [{"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": other + "\n\nreturn json please"}], json_mode=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
