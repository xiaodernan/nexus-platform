"""LIVE probe for the /ai/v1/handbook/ask lane — a REAL round trip through the app.

Run on the operator plane (Clash Verge for this account — direct traffic is geo-blocked):

    HTTPS_PROXY=http://127.0.0.1:7897 \
    NEXUS_LLM_PROVIDER=openai \
    NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=gpt-6.2-sol NEXUS_LLM_MODEL_MID=gpt-6.2-sol NEXUS_LLM_MODEL_REASON=gpt-6.2-sol \
    uv run python handbook_probe.py

Never run in CI: conftest forces `NEXUS_LLM_PROVIDER=mock` there.
"""
from __future__ import annotations

import json
import os
import sys


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


SECTIONS = [
    {"id": "search", "kicker": "SEARCH",
     "title": "1 · SearchBox：一句話，就是一張地圖",
     "body": "在 SearchBox 裡輸入任何你想吃、想做、想遇見的——油麻地 魚蛋 抵食、廟街 宵夜。系統會拆出地區、類別、預算與時間偏好，再返回附近的商戶；每張卡下面都寫明為什麼推荐你這一間。"},
    {"id": "gameplay", "kicker": "GAME",
     "title": "4 · /hk-type 香港人格：先做一個人格題",
     "body": "點「香港人格」——八道情境題各選一式，系統給你一個港式人格，附一句語錄和可分享的結果卡。做完就知道你是個怎樣的香港人。"},
    {"id": "concierge", "kicker": "TOOL",
     "title": "5 · 說明書 ask= 問手冊：不需要 AI",
     "body": "網址加上 ?ask=你的問題，說明書直接查出最相關的章節並引用原句作答。檢索路徑不調用任何模型、不需要網絡、離線也可用；答案是手冊本身的原句加出處，不編造、不改寫。"},
]


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

    question = "SearchBox 應該怎麼用？要點什麼才能得到推薦？"
    print(f"POST /ai/v1/handbook/ask question={question!r}")
    resp = client.post("/ai/v1/handbook/ask",
                       json={"question": question, "sections": SECTIONS, "locale": "zh-HK"},
                       timeout=120)
    print(f"status={resp.status_code}")
    print(json.dumps(resp.json(), ensure_ascii=False, indent=2))

    data = resp.json()
    if data.get("degraded"):
        print(f"RESULT: DEGRADED ({data.get('reason')}) — the grounded deterministic lane owns this question; model kept its hands off")
        return 0
    answer = data.get("answer") or ""
    citations = data.get("citations") or []
    if not answer:
        print("FAIL: non-degraded lane answered empty")
        return 1
    if not citations:
        print("FAIL: non-degraded lane carried zero citations")
        return 1
    for c in citations:
        if c.get("id") not in {s["id"] for s in SECTIONS}:
            print(f"FAIL: citation {c!r} is not a provided section")
            return 1
    print("PASS: the live provider phrased the manual's answer with in-corpus citations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
