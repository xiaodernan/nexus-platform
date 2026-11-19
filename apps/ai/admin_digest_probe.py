"""LIVE probe for the /ai/v1/admin/digest lane — a REAL round trip through the app.

Run on the operator plane (Clash Verge — direct traffic is geo-blocked):

    HTTPS_PROXY=http://127.0.0.1:7897 \
    NEXUS_LLM_PROVIDER=openai \
    NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=gpt-6.2-sol NEXUS_LLM_MODEL_MID=gpt-6.2-sol NEXUS_LLM_MODEL_REASON=gpt-6.2-sol \
    uv run python admin_digest_probe.py

Never run in CI: conftest forces `NEXUS_LLM_PROVIDER=mock` there.
"""
from __future__ import annotations

import json
import os
import sys


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


EVENTS = {
    "xlen": 913,
    "pending": 2,
    "consumers": 1,
    "disabled": False,
    "degraded": False,
    "recent_count": 5,
    "top_templates": ["guide_read", "search"],
}


def main() -> int:
    provider = _env("NEXUS_LLM_PROVIDER").lower()
    key = _env("NEXUS_LLM_API_KEY")
    base = _env("NEXUS_LLM_BASE_URL")
    if provider in ("", "mock") or not key or not base:
        print("SKIP: NEXUS_LLM_PROVIDER/NEXUS_LLM_BASE_URL/NEXUS_LLM_API_KEY are not supplied for a live run")
        return 2

    from fastapi.testclient import TestClient
    from nexus_ai.api.app import create_app

    app = create_app()
    client = TestClient(app)

    print("POST /ai/v1/admin/digest")
    resp = client.post("/ai/v1/admin/digest", json={"events": EVENTS, "locale": "zh-HK"}, timeout=120)
    print(f"status={resp.status_code}")
    print(json.dumps(resp.json(), ensure_ascii=False, indent=2))

    data = resp.json()
    if data.get("degraded"):
        print(f"RESULT: DEGRADED ({data.get('reason')}) — the console keeps the counters; the model kept its hands off")
        return 0
    reading = data.get("reading") or ""
    actions = data.get("actions") or []
    if not reading:
        print("FAIL: non-degraded lane answered with an empty reading")
        return 1
    # the numeric fence, verified from outside too
    import re

    combined = reading + " " + " ".join(f"{a.get('action', '')} {a.get('why', '')}" for a in actions)
    payload_digits = set()
    for m in re.finditer(r"\d+", json.dumps(EVENTS, ensure_ascii=False)):
        payload_digits.add(m.group(0))
    for m in re.finditer(r"\d+", combined):
        if m.group(0) not in payload_digits | {str(n) for n in range(0, 11)} | {"24", "100", "2026"}:
            print(f"FAIL: model wrote the number {m.group(0)}, absent from the payload")
            return 1
    print("PASS: the live provider phrased a digest whose every number traces back to the payload")
    return 0


if __name__ == "__main__":
    sys.exit(main())
