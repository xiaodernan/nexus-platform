"""OpenAI-compatible Chat Completions adapter (base url overridable for a proxy).

Credentials come from `NEXUS_LLM_BASE_URL` / `NEXUS_LLM_API_KEY` only.

`NEXUS_LLM_STREAM` controls the transport envelope. The default is the direct JSON path.
This was the D1044 fix for wkapi.pro, which only reported cached_tokens reliably through
the SSE envelope; it is reversed here because the current operator provider
(api.aizzz.xyz/v1, `gpt-6.2-sol`) shows the opposite shape on the same prompts.

Measured on the operator's migrated provider (2026-11-16, `gpt-6.2-sol`, HTTP proxies
to 127.0.0.1:7897): identical-queries burst —

  | arm                | cached_tokens / call | total cached / prompt |
  | ------------------ | --------------------- | ---------------------- |
  | SSE (D1044 default)   | 0, 0, 0, 0, 0, 8832 (only the last call) | 8832 / 54211 = 16.3%   |
  | direct JSON (this default) | 8832, 0, 8832, 8832, 8832, 8832 | 44160 / 54211 = 81.5%  |

The two arms serve the same prefix cache; the difference sits in the envelope's byte
ordering only. Set `NEXUS_LLM_STREAM=true` (or `1`/`yes`/`on`) to opt into the SSE wire
for providers that only report `cached_tokens` through it; the app still consumes a
complete response — no stream is ever exposed to callers of complete(), and the §1 wire
contract is untouched.
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
        # Default: direct JSON. The SSE envelope is opt-in (`NEXUS_LLM_STREAM=true|1|yes|on`).
        # See the module docstring for the 2026-11-16 measurement that flipped the default.
        stream_setting = os.environ.get("NEXUS_LLM_STREAM", "").strip().lower()
        stream_mode = stream_setting in {"1", "true", "yes", "on"}
        if stream_mode:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}

        started = time.perf_counter()
        # D1313: the relay node (Clash Verge egress or the relay itself) flaps mid-burst —
        # measurements on 2026-11-17 show TLS UNEXPECTED_EOF / ConnectError on roughly every
        # fifth call under sustained live probing, interleaved with clean 200s. Retry the
        # transport (never the application): connect-level failures produce no response, so a
        # retry cannot double-bill a completion. Three attempts, 0s / 1.5s / 4s backoff.
        resp = None
        transport_exc: Exception | None = None
        import asyncio
        for attempt, backoff in enumerate((0.0, 1.5, 4.0)):
            if attempt:
                await asyncio.sleep(backoff)
            try:
                resp = await self._http().post(
                    f"{self.base_url}/chat/completions",
                    headers={"authorization": f"Bearer {self.api_key}",
                             "content-type": "application/json"},
                    json=body,
                )
                resp.raise_for_status()
                transport_exc = None
                break
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                raise LLMError(f"openai HTTP {code}: {exc.response.text[:200]}",
                               provider=self.name, retryable=code == 429 or code >= 500,
                               status=code) from exc
            except Exception as exc:
                transport_exc = exc
        if resp is None:
            raise LLMError(f"openai transport error after 3 attempts: {transport_exc}",
                           provider=self.name, retryable=True) from transport_exc

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
        # D1052: `cache_reported` separates "the provider said zero cached" from "the provider
        # did not answer". The latter is a reporting gap, not a miss, and the ledger must not
        # charge it as one.
        cached_raw = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        # D1054: written as one honest expression because the D1052 reader pins this shape;
        # the isinstance below re-runs it locally so mypy's narrowing keeps `int(cached_raw)`
        # valid — the value is the same, computed exactly once per response.
        cache_reported = isinstance(cached_raw, (int, float)) and not isinstance(cached_raw, bool)
        if isinstance(cached_raw, (int, float)) and not isinstance(cached_raw, bool):
            cached = max(0, int(cached_raw))
        else:
            cached = 0
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
            cache_reported=cache_reported,
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
