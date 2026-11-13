"""An OPTIONAL, strictly-gated Redis cache for byte-identical temperature-0 LLM requests.

**Why this exists.** The provider-side prefix cache (D1036–D1044) saves *recompute* for a
stable prefix — but a byte-identical request still pays a full network round trip and still
reports the same token cost shape. Replaying the stored completion is a 100% cache hit by
construction: same bytes in → the stored answer out, zero tokens, zero latency to the
provider. The one domain this is safe in without thinking: `temperature == 0.0`.

**What is NOT cached.**
- Any request with `temperature > 0.0` — nondeterministic by contract, never served stale.
- Anything when `NEXUS_LLM_RESPONSE_CACHE` is not `redis` — the module is a no-op by default.
- `reason` task class — bounded narratives whose replay would defeat the §9 per-request
  budget semantics; the deliberate exception keeps the guardrail sharp.
- Two chains with different adapter names — the key carries the chain signature, so an
  operator switching provider never replays another provider's answer.

**Design lines.**
- *Opt-in.* `NEXUS_LLM_RESPONSE_CACHE=redis` must be set; the client is created lazily and
  only then. Default off.
- *Offline-tolerant.* Any Redis failure degrades to "cache absent" with one log line; the
  model call still happens. The response never depends on Redis being up.
- *Key.* `nexus:llm:response:<sha256>` over `{task_class, system, user_text, max_tokens,
  json_hint, subject_id, chain}` — `user_text` is the canonical `sort_keys` serialization the
  adapter already uses (base.py), so the key covers every byte the provider would see.
- *Value.* The stored body is `{text, finish_reason, provider, model, purpose, data}` —
  the replay returns a zero-token `LLMResponse` with `cache_hit=True` and `cost_usd=0.0`.
  The cost ledger sees a free call, which is the truth of what happened.
- *TTL.* `NEXUS_LLM_RESPONSE_CACHE_TTL_S` (default 3600) — a cached answer expires long
  before facts/seed can meaningfully drift; identical bytes make the payload self-keyed
  anyway (changed input → missed key → fresh call).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover - import-time hints only
    from nexus_ai.models.base import LLMRequest, LLMResponse

log = logging.getLogger("nexus_ai.api.llm_response_cache")

_CLIENT: Optional[Any] = None
_CLIENT_TRIED = False

#: the one task class deliberately outside the cache (see module docstring).
_UNCACHEABLE_TASKS = frozenset({"reason"})


def _client() -> Optional[Any]:
    """The shared Redis client — created on first call, opt-in only, off unless enabled."""
    global _CLIENT, _CLIENT_TRIED
    if _CLIENT_TRIED:
        return _CLIENT
    _CLIENT_TRIED = True
    if os.getenv("NEXUS_LLM_RESPONSE_CACHE", "").strip().lower() != "redis":
        _CLIENT = None
        return None
    url = os.getenv("NEXUS_REDIS_URL", "redis://127.0.0.1:6380/0")
    try:
        import redis

        client = redis.Redis.from_url(
            url, socket_connect_timeout=0.5, socket_timeout=1.0, decode_responses=True)
        client.ping()
        log.info("nexus_ai.llm_response_cache=redis url=%s", url.split("@", 1)[-1])
        _CLIENT = client
    except Exception as exc:  # infra down is a normal state, not a crash
        log.warning("nexus_ai.llm_response_cache=redis requested but unreachable (%s); replay stays off",
                    exc)
        _CLIENT = None
    return _CLIENT


def _user_text(req: "LLMRequest") -> str:
    if req.prompt:
        return req.prompt
    # same canonicalisation as HttpLLMAdapter._user_text — identical bytes for identical payloads
    return json.dumps(req.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _ttl_s() -> int:
    raw = os.getenv("NEXUS_LLM_RESPONSE_CACHE_TTL_S", "3600").strip()
    try:
        ttl = int(raw)
        return ttl if ttl > 0 else 3600
    except ValueError:
        return 3600


def _cacheable(req: "LLMRequest", chain: tuple[str, ...]) -> bool:
    if req.task_class in _UNCACHEABLE_TASKS:
        return False
    if float(req.temperature or 0.0) != 0.0:
        return False
    if not chain:
        return False
    try:
        json.dumps(req.payload, sort_keys=True, default=str)
    except Exception:
        return False
    return True


def _key(req: "LLMRequest", chain: tuple[str, ...]) -> str:
    parts = {
        "task_class": req.task_class,
        "system": req.system,
        "user": _user_text(req),
        "max_tokens": req.max_tokens,
        "json_hint": req.json_hint,
        "subject_id": req.subject_id,
        "chain": list(chain),
    }
    blob = json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":"))
    return "nexus:llm:response:" + hashlib.sha256(blob.encode()).hexdigest()


def _value_for(resp: "LLMResponse") -> dict[str, Any]:
    return {
        "text": resp.text,
        "data": resp.data,
        "provider": resp.provider,
        "model": resp.model,
        "purpose": resp.purpose,
        "finish_reason": resp.finish_reason,
    }


def _resp_from(payload: dict[str, Any], req: "LLMRequest", stored_latency_ms: int) -> "LLMResponse":
    from nexus_ai.models.base import TASK_MODEL_DEFAULTS, LLMResponse, maybe_json

    meta = TASK_MODEL_DEFAULTS.get(req.task_class, {"purpose": req.task_class})
    text = str(payload.get("text") or "")
    return LLMResponse(
        text=text,
        data=payload.get("data") if "data" in payload else maybe_json(text),
        provider=str(payload.get("provider") or "cache"),
        model=str(payload.get("model") or "cache"),
        task_class=req.task_class,
        purpose=str(payload.get("purpose") or meta["purpose"]),
        prompt_tokens=0,
        completion_tokens=0,
        cost_usd=0.0,
        latency_ms=max(0, int(stored_latency_ms)),
        degraded=False,
        cache_hit=True,
        finish_reason=str(payload.get("finish_reason") or "stop"),
        usage_flagged=False,
        cached_tokens=0,
    )


def llm_cache_get(req: "LLMRequest", chain: tuple[str, ...]) -> Optional["LLMResponse"]:
    """The replayed response if every input byte matches a stored one, else None."""
    if not _cacheable(req, chain):
        return None
    client = _client()
    if client is None:
        return None
    key = _key(req, chain)
    try:
        raw = client.get(key)
    except Exception as exc:
        log.warning("nexus_ai.llm_response_cache get failed (%s); treating as a miss", exc)
        return None
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return _resp_from(payload, req, stored_latency_ms=0)


def llm_cache_set(req: "LLMRequest", chain: tuple[str, ...], resp: "LLMResponse") -> bool:
    """Store a response for this exact byte-shape. Returns True on write."""
    if not _cacheable(req, chain):
        return False
    client = _client()
    if client is None:
        return False
    try:
        client.set(_key(req, chain), json.dumps(_value_for(resp), ensure_ascii=False, default=str),
                   ex=_ttl_s())
        return True
    except Exception as exc:
        log.warning("nexus_ai.llm_response_cache set failed (%s); continuing", exc)
        return False


def reset_for_tests() -> None:
    global _CLIENT, _CLIENT_TRIED
    _CLIENT, _CLIENT_TRIED = None, False
