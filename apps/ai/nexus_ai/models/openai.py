"""OpenAI-compatible Chat Completions adapter (base url overridable for a proxy).

Credentials come from `NEXUS_LLM_BASE_URL` / `NEXUS_LLM_API_KEY` only.
"""

from __future__ import annotations

import time
from typing import Any

from nexus_ai.models.base import (
    HttpLLMAdapter,
    LLMError,
    LLMRequest,
    LLMResponse,
    TASK_MODEL_DEFAULTS,
    cost_usd,
    maybe_json,
)


class OpenAIAdapter(HttpLLMAdapter):
    name = "openai"
    default_base_url = "https://api.openai.com/v1"
    default_models = {"cheap": "gpt-4o-mini", "mid": "gpt-4o", "reason": "o3-mini"}

    async def complete(self, req: LLMRequest) -> LLMResponse:  # pragma: no cover - network
        import httpx

        meta = TASK_MODEL_DEFAULTS[req.task_class]
        body: dict[str, Any] = {
            "model": self._model_for(meta["tier"]),
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "messages": [
                {"role": "system", "content": req.system or
                    "You are the NEXUS assistant. Answer only from the data you are given."},
                {"role": "user", "content": self._user_text(req)},
            ],
        }
        if req.json_hint:
            body["response_format"] = {"type": "json_object"}
        started = time.perf_counter()
        try:
            resp = await self._http().post(
                f"{self.base_url}/chat/completions",
                headers={"authorization": f"Bearer {self.api_key}",
                         "content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            raise LLMError(f"openai HTTP {code}: {exc.response.text[:200]}",
                           provider=self.name, retryable=code == 429 or code >= 500,
                           status=code) from exc
        except Exception as exc:
            raise LLMError(f"openai transport error: {exc}", provider=self.name,
                           retryable=True) from exc

        raw = resp.json()
        choices = raw.get("choices") or [{}]
        choice = choices[0] or {}
        text = (choice.get("message") or {}).get("content") or ""
        usage = raw.get("usage") or {}
        pt = int(usage.get("prompt_tokens") or 0)
        ct = int(usage.get("completion_tokens") or 0)
        return LLMResponse(
            text=text, data=maybe_json(text), provider=self.name,
            model=raw.get("model") or body["model"], task_class=req.task_class,
            purpose=meta["purpose"], prompt_tokens=pt, completion_tokens=ct,
            cost_usd=cost_usd(meta["tier"], pt, ct),
            latency_ms=int((time.perf_counter() - started) * 1000),
            degraded=False, finish_reason=choice.get("finish_reason") or "stop",
        )
