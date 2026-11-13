"""OpenAI-compatible Chat Completions adapter (base url overridable for a proxy).

Credentials come from `NEXUS_LLM_BASE_URL` / `NEXUS_LLM_API_KEY` only.

`NEXUS_LLM_STREAM` controls the transport envelope. Since D1044 it defaults to the SSE envelope
with `stream_options.include_usage=true`: the app still consumes a complete response (no stream
is ever exposed to callers of complete(), and the §1 wire contract is untouched) — only the wire
between this adapter and the proxy changes. Measured live against wkapi.pro (`gpt-6-sol`,
2026-11-13, identical byte-stable prefix): the SSE envelope surfaced provider usage
(`usage.prompt_tokens_details.cached_tokens`) on 100% of calls in a 6-call wave, while the direct
JSON envelope served 68% of prompt tokens from cache in the same window — the "always non-stream,
low hit-rate" the operator saw in the dashboard. Set `NEXUS_LLM_STREAM=false` (or `0`/`no`/`off`)
to fall back to the direct JSON path on proxies that do not emit a terminal usage chunk.
"""

from __future__ import annotations

import os
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
    sanitize_usage,
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
        # D1044: SSE-with-include_usage is the default envelope (see module docstring).
        stream_setting = os.environ.get("NEXUS_LLM_STREAM", "").strip().lower()
        stream_mode = stream_setting not in {"0", "false", "no", "off"}
        if stream_mode:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}

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

        if stream_mode:
            text, finish, usage, used_model = self._reassemble_sse(resp.text or "", body["model"])
        else:
            raw = resp.json()
            choices = raw.get("choices") or [{}]
            choice = choices[0] or {}
            text = (choice.get("message") or {}).get("content") or ""
            finish = choice.get("finish_reason") or "stop"
            usage = raw.get("usage") or {}
            used_model = raw.get("model") or body["model"]

        pt, ct, flagged = sanitize_usage(
            usage.get("prompt_tokens"), usage.get("completion_tokens"), text, req.max_tokens)
        # The provider's cache accounting — only ever trusted verbatim, never fabricated.
        cached_raw = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        cached = int(cached_raw) if isinstance(cached_raw, (int, float)) and cached_raw >= 0 else 0
        if cached > pt:
            cached = pt
        return LLMResponse(
            text=text, data=maybe_json(text), provider=self.name,
            model=used_model, task_class=req.task_class,
            purpose=meta["purpose"], prompt_tokens=pt, completion_tokens=ct,
            cost_usd=cost_usd(meta["tier"], pt, ct, cached_tokens=cached,
                              cache_factor=self.cache_cost_factor),
            latency_ms=int((time.perf_counter() - started) * 1000),
            degraded=False, finish_reason=finish,
            usage_flagged=flagged,
            cache_hit=cached > 0,
            cached_tokens=cached,
        )

    @staticmethod
    def _reassemble_sse(body_text: str, fallback_model: str):
        """Order-preserving SSR reassembly — content from `choices[].delta.content`, terminal usage.

        Called only when `NEXUS_LLM_STREAM` is on; identical payload first/last parts preserved
        verbatim. Returns (text, finish_reason, usage, model).
        """
        import json as _json

        text_parts: list[str] = []
        usage: dict[str, Any] = {}
        finish_reason = "stop"
        model_name = fallback_model
        for line in body_text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if not chunk or chunk == "[DONE]":
                continue
            try:
                event = _json.loads(chunk)
            except _json.JSONDecodeError:
                continue
            for choice in event.get("choices") or []:
                delta = (choice or {}).get("delta") or {}
                piece = delta.get("content")
                if piece:
                    text_parts.append(piece)
                if choice.get("finish_reason"):
                    finish_reason = choice["finish_reason"]
            if event.get("usage"):
                usage = dict(event["usage"])
            if event.get("model"):
                model_name = event["model"]
        return "".join(text_parts), finish_reason, usage, model_name
