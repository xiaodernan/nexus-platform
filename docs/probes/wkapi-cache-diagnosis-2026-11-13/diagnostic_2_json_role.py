"""WKAPI cache diagnosis, diagnostic 2 — on the json_object path, is the system role forwarded at all?

Reconstructed from the session transcript (2026-11-13). The original scratch file was removed
with the parallel lane's vanish. Why this arm exists: diagnostic 1 showed the proxy has two
backends — plain chat (prompt_tokens carries a ~multi-k fixed preamble, system IS counted)
and a json_object path that reported prompt_tokens ~146 for a call whose system message was
~440 tokens, i.e. the system role appeared dropped before tokenisation at that time of day.
The json path is the one the intent extractor uses. Measurements that contradict the first
read (system IS carried, warm-hit 21586/21589 on a later sweep) are recorded in the README.

Run:
    NEXUS_LLM_BASE_URL=... NEXUS_LLM_API_KEY=... NEXUS_LLM_MODEL_MID=gpt-6-sol \
    uv run python diagnostic_2_json_role.py
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

BIG = "\n".join(
    f"RULE {i:04d}: fixed sentence used only to measure whether this role is tokenised. "
    f"It carries no instruction and no data."
    for i in range(1, 61)
)


async def once(client: httpx.AsyncClient, label: str, messages: list[dict[str, str]],
               *, json_mode: bool):
    body = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": 12,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    resp = await client.post(
        f"{BASE}/chat/completions",
        headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"}, json=body)
    if resp.status_code >= 400:
        print(f"{label:44} HTTP {resp.status_code} {resp.text[:140]}")
        return
    usage: dict = {}
    for line in (resp.text or "").splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            ev = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        if ev.get("usage"):
            usage = ev["usage"]
    pt = usage.get("prompt_tokens")
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
    print(f"{label:44} prompt={pt} cached={cached} completion={usage.get('completion_tokens')} "
          f"text_chars={sum(len(m['content']) for m in messages)}")


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
        await once(client, "json   same user-BIG arm again (is the second identical call cached?)",
                   [{"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": BIG + "\n\nreturn json please"}], json_mode=True)
        other = BIG.replace("RULE 0001", "RULE 9999")
        await once(client, "json   user=OTHER (same length, different head) — prefix-based?",
                   [{"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": other + "\n\nreturn json please"}], json_mode=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
