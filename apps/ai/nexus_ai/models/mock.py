"""`MockAdapter` — the deterministic heuristic provider (DECISIONS D4).

This is the backbone of offline / dev / CI. It is **not** a stub that raises: every LLM
task in AGENT_CONTRACT §9 has a real, deterministic implementation built from the same
lexicon + regex engine the NLU module uses, plus locale templates for copy. Because copy
is composed only from records handed to it, it cannot invent a fact (§19), which is why
the intent suite must pass against it (§71-72).
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from nexus_ai.models.base import (
    LLMError,
    LLMRequest,
    LLMResponse,
    TASK_MODEL_DEFAULTS,
    estimate_tokens,
    norm_locale,
    record_meters,
    record_price,
    record_rating,
    record_title,
    record_top_reason,
)

SUMMARY_TEMPLATES: dict[str, dict[str, str]] = {
    "zh-HK": {
        "found": "找到 {n} 個符合條件的選擇。",
        "best": "最佳匹配：{title}（{reason}）",
        "value": "最化算：{title}",
        "closest": "最近：{title}",
        "popular": "最受歡迎：{title}",
        "empty": "暫時找不到完全符合條件的選擇，可以放寬預算或擴大地區再試。",
        "none_grounded": "這個答案需要更多資料，未能確認。",
        "handoff": "唔好意思，呢個問題我需要同事幫你確認（轉人工）。",
    },
    "zh-CN": {
        "found": "找到 {n} 个符合条件的选择。",
        "best": "最佳匹配：{title}（{reason}）",
        "value": "最划算：{title}",
        "closest": "最近：{title}",
        "popular": "最受欢迎：{title}",
        "empty": "暂时找不到完全符合条件的选择，可以放宽预算或扩大地区再试。",
        "none_grounded": "这个答案需要更多资料，未能确认。",
        "handoff": "抱歉，这个问题我需要同事帮你确认（转人工）。",
    },
    "en": {
        "found": "I found {n} good options.",
        "best": "Best match: {title} ({reason})",
        "value": "Best value: {title}",
        "closest": "Closest: {title}",
        "popular": "Most popular: {title}",
        "empty": "No exact match — try widening the budget or the area.",
        "none_grounded": "I could not verify that, so I will not guess.",
        "handoff": "Sorry, I need a colleague to confirm this one (handing off to a human).",
    },
}


class MockAdapter:
    """Deterministic, clearly-labelled provider. `provider="mock"`, `degraded=True`."""

    name = "mock"
    model = "mock-heuristic-1"

    def __init__(self, *, latency_ms: int = 0):
        self._latency_ms = latency_ms
        self.calls: list[str] = []

    async def health(self) -> dict[str, Any]:
        return {"provider": self.name, "ok": True, "model": self.model, "offline": True}

    async def complete(self, req: LLMRequest) -> LLMResponse:
        started = time.perf_counter()
        if req.task_class not in TASK_MODEL_DEFAULTS:
            raise LLMError(f"unsupported task_class {req.task_class!r}", provider=self.name)
        self.calls.append(req.task_class)
        tc = req.task_class
        if tc in ("intent_extract", "classify", "route"):
            data: Any = self._intent(req)
            text = json.dumps(data, ensure_ascii=False, sort_keys=True)
        elif tc == "reason":
            data = self._plan(req)
            text = json.dumps(data, ensure_ascii=False, sort_keys=True)
        elif tc == "summary":
            text = self._summary(req)
            data = {"text": text}
        elif tc == "generate_ui_copy":
            text = self._copy(req)
            data = {"text": text}
        elif tc == "rerank":
            data = self._rerank(req)
            text = json.dumps(data, ensure_ascii=False, sort_keys=True)
        elif tc == "embed":
            raise LLMError("embed is served by EmbeddingAdapter, not the LLM adapter",
                           provider=self.name)
        else:  # pragma: no cover - defensive
            raise LLMError(f"unsupported task_class {tc!r}", provider=self.name)

        pt = estimate_tokens(req.prompt + json.dumps(req.payload, ensure_ascii=False)[:4000])
        ct = estimate_tokens(text)
        return LLMResponse(
            text=text, data=data, provider=self.name, model=self.model, task_class=tc,
            purpose=TASK_MODEL_DEFAULTS[tc]["purpose"], prompt_tokens=pt, completion_tokens=ct,
            cost_usd=0.0,
            latency_ms=int((time.perf_counter() - started) * 1000) + self._latency_ms,
            degraded=True,
        )

    # -- heuristics ---------------------------------------------------------
    def _intent(self, req: LLMRequest) -> dict[str, Any]:
        from nexus_ai.nlu.understand import extract_intent_dict

        query = req.payload.get("query") or req.prompt or ""
        context = req.payload.get("context") or {}
        return extract_intent_dict(query, context)

    def _plan(self, req: LLMRequest) -> dict[str, Any]:
        intent = req.payload.get("intent")
        if not intent:
            intent = self._intent(LLMRequest(task_class="intent_extract", payload={
                "query": req.payload.get("query", ""),
                "context": req.payload.get("context", {}),
            }))
        # D408: this used to import `nexus_ai.orchestrator.planner`, a module this
        # repository does not have, so the mock's "reason" task raised ImportError
        # the first time anything asked for a plan. The plan the router needs is
        # small - the intent, the steps it may run, and the budget (AGENT_CONTRACT
        # §2: <=6 tool calls, <=3 LLM calls).
        intent_kind = str((intent or {}).get("intent") or "discover_merchant")
        steps = ["intent_extract", "search_merchants"]
        if intent_kind == "compare":
            steps.append("compare_entities")
        return {"agent": "planner", "intent": intent_kind, "steps": steps,
                "budget": {"max_steps": 6, "max_llm_calls": 3}}

    def _records(self, req: LLMRequest) -> list[dict[str, Any]]:
        recs = req.payload.get("records") or req.payload.get("items") or []
        out: list[dict[str, Any]] = []
        for r in recs:
            out.append(r if isinstance(r, dict) else _as_dict(r))
        return out

    def _summary(self, req: LLMRequest) -> str:
        t = SUMMARY_TEMPLATES[norm_locale(str(req.payload.get("locale") or "zh-HK"))]
        recs = self._records(req)
        if not recs:
            return t["empty"]
        lines = [t["found"].format(n=len(recs))]
        first = recs[0]
        lines.append(t["best"].format(title=record_title(first), reason=record_top_reason(first) or "—"))
        if len(recs) > 1:
            priced = [r for r in recs if record_price(r) is not None]
            if priced:
                lines.append(t["value"].format(
                    title=record_title(min(priced, key=lambda r: float(record_price(r) or 0.0)))))
            near = [r for r in recs if record_meters(r) is not None]
            if near:
                lines.append(t["closest"].format(
                    title=record_title(min(near, key=lambda r: float(record_meters(r) or 0.0)))))
            rated = [r for r in recs if record_rating(r) is not None]
            if rated:
                lines.append(t["popular"].format(
                    title=record_title(max(rated, key=lambda r: float(record_rating(r) or 0.0)))))
        return "\n".join(lines)

    def _copy(self, req: LLMRequest) -> str:
        """UI copy from an explicit template key + vars only — never free generation."""
        t = SUMMARY_TEMPLATES[norm_locale(str(req.payload.get("locale") or "zh-HK"))]
        key = req.payload.get("template_key")
        if key and key in t:
            try:
                return t[key].format(**(req.payload.get("vars") or {}))
            except (KeyError, IndexError):
                return t["none_grounded"]
        return t["none_grounded"]

    def _rerank(self, req: LLMRequest) -> list[dict[str, Any]]:
        """Deterministic lexical re-scoring of the *given* candidates (top-40 by §9)."""
        query = str(req.payload.get("query") or "").lower()
        tokens = re.findall(r"[\w一-鿿]{2,}", query)
        scored: list[tuple[float, int, dict[str, Any]]] = []
        for i, r in enumerate(self._records(req)):
            hay = " ".join(str(v) for v in r.values()).lower()
            s = sum(1.0 for tok in tokens if tok in hay)
            s += (record_rating(r) or 0) / 50.0
            scored.append((s, i, r))
        scored.sort(key=lambda x: (-x[0], x[1]))
        return [r for _, _, r in scored]


def _as_dict(obj: Any) -> dict[str, Any]:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return dict(obj)
