"""Anthropic Messages adapter. Credentials from env only (DECISIONS D4, §131)."""

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


class AnthropicAdapter(HttpLLMAdapter):
    name = "anthropic"
    default_base_url = "https://api.anthropic.com"
    default_models = {
        "cheap": "claude-haiku-latest",
        "mid": "claude-sonnet-latest",
        "reason": "claude-opus-latest",
    }

    async def complete(self, req: LLMRequest) -> LLMResponse:  # pragma: no cover - network
        import httpx

        meta = TASK_MODEL_DEFAULTS[req.task_class]
        body: dict[str, Any] = {
            "model": self._model_for(meta["tier"]),
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "system": req.system,
            "messages": [{"role": "user", "content": self._user_text(req)}],
        }
        started = time.perf_counter()
        try:
            resp = await self._http().post(
                f"{self.base_url}/v1/messages",
                headers={"x-api-key": self.api_key,
                         "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            raise LLMError(f"anthropic HTTP {code}: {exc.response.text[:200]}",
                           provider=self.name, retryable=code == 429 or code >= 500,
                           status=code) from exc
        except Exception as exc:
            raise LLMError(f"anthropic transport error: {exc}", provider=self.name,
                           retryable=True) from exc

        raw = resp.json()
        text = "".join(b.get("text", "") for b in raw.get("content", [])
                       if b.get("type") == "text")
        usage = raw.get("usage") or {}
        pt = int(usage.get("input_tokens") or 0)
        ct = int(usage.get("output_tokens") or 0)
        return LLMResponse(
            text=text, data=maybe_json(text), provider=self.name,
            model=raw.get("model") or body["model"], task_class=req.task_class,
            purpose=meta["purpose"], prompt_tokens=pt, completion_tokens=ct,
            cost_usd=cost_usd(meta["tier"], pt, ct),
            latency_ms=int((time.perf_counter() - started) * 1000),
            degraded=False, finish_reason=raw.get("stop_reason") or "stop",
        )


