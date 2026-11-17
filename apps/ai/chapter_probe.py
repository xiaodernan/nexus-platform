"""LIVE probe for the /ai/v1/chapter/ask lane — a REAL round trip through the app.

Run on the operator plane (Clash Verge for this account — direct traffic is geo-blocked):

    HTTPS_PROXY=http://127.0.0.1:7897 \
    NEXUS_LLM_PROVIDER=openai \
    NEXUS_LLM_BASE_URL=https://api.aizzz.xyz/v1 \
    NEXUS_LLM_API_KEY=sk-... \
    NEXUS_LLM_MODEL_CHEAP=gpt-6.1-terra NEXUS_LLM_MODEL_MID=gpt-6.1-terra NEXUS_LLM_MODEL_REASON=gpt-6.1-terra \
    uv run python chapter_probe.py

Never run in CI: conftest forces `NEXUS_LLM_PROVIDER=mock` there.
The excerpts below are verbatim from the committed corpus (hk-cha-chaan-teng-chronicle).
"""
from __future__ import annotations

import json
import os
import sys


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


SECTIONS = [
    {"id": "p1", "kicker": "activities",
     "title": "茶餐廳（香港系列 · 第五章） · §1",
     "body": "合成敘事示例（非真實行程建議）：這裏有一種聲音。大嗌的鍋鏟響，水槽嘩啦嘩啦，常餐突然落在我面前。每一次走進茶餐廳，你會聽到一句廣東歇——「唔該等一等」。不會等很久，但都得等。"},
    {"id": "p3", "kicker": "activities",
     "title": "茶餐廳（香港系列 · 第五章） · §3",
     "body": "茶餐廳常餐的三個不可少：第一，一定要有一個主食——米飯、伊麵或者一個明爐的叉燒；第二，一碗湯——它沉默地坐在你一桌兩個中間，誰也不挑揀它；第三，一杯奶茶——這是這座城市一切關於「慢」的懷念。"},
    {"id": "p5", "kicker": "activities",
     "title": "茶餐廳（香港系列 · 第五章） · §5",
     "body": "趕時間的話，先去 SearchBox 搜「沙田 常餐」。"},
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

    question = "茶餐廳嘅常餐一定要有啲乜？"
    print(f"POST /ai/v1/chapter/ask question={question!r}")
    resp = client.post("/ai/v1/chapter/ask",
                       json={
                           "question": question,
                           "chapter_id": "hk-cha-chaan-teng-chronicle",
                           "chapter_title": "茶餐廳（香港系列 · 第五章）",
                           "sections": SECTIONS,
                           "locale": "zh-HK",
                       },
                       timeout=120)
    print(f"status={resp.status_code}")
    print(json.dumps(resp.json(), ensure_ascii=False, indent=2))

    data = resp.json()
    if data.get("degraded"):
        print(f"RESULT: DEGRADED ({data.get('reason')}) — the chapter stands alone; the model kept its hands off")
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
            print(f"FAIL: citation {c!r} is not a provided excerpt")
            return 1
    print("PASS: the live provider phrased the chapter's answer with in-corpus citations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
