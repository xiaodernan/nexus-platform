"""An OPTIONAL, strictly-gated Redis cache for temperature-0 LLM requests.

**Why this exists.** The provider-side prefix cache (D1036–D1044) saves *recompute* for a
stable prefix on providers that actually prefix-cache — measured on wkapi.pro it does not
(D1160: only exact-request wholesale caching happens there). Replaying the stored completion
is a 100% cache hit by construction: same bytes in → the stored answer out, zero tokens,
zero latency to the provider. The one domain this is safe in without thinking:
`temperature == 0.0`.

Two requests whose payload bytes are identical — or identical after the D1160 whitespace
fold — are served the stored answer.

**What is NOT cached.**
- Any request with `temperature > 0.0` — nondeterministic by contract, never served stale.
- Anything when `NEXUS_LLM_RESPONSE_CACHE` is not `redis` — the module is a no-op by default.
- `reason` task class — bounded narratives whose replay would defeat the §9 per-request
  budget semantics; the deliberate exception keeps the guardrail sharp.
- Two chains with different adapter names — the key carries the chain signature, so an
  operator switching provider never replays another provider's answer.

**Design lines.**
- *Redis arm opt-in.* `NEXUS_LLM_RESPONSE_CACHE=redis` creates the cross-process client
  lazily. Without it (the default) the bounded PROCESS-LOCAL replay arm (D1499) answers:
  a byte-identical temperature-0 request is replayed with zero tokens. This is not a new
  provider promise — it is a local memo of a response the provider already returned.
  Measured on the operator proxy: 95.3% prefix hits on 5 of 6 identical calls, 0% on one;
  the local arm removes that flicker (call 0 provider, calls 1–5 zero-token replay).
- *Offline-tolerant.* Any Redis failure degrades to "cache absent" with one log line; the
  model call still happens. The response never depends on Redis being up.
- *Key.* `nexus:llm:response:<sha256>` over `{task_class, system, user_text, max_tokens,
  json_hint, subject_id, chain}` — `user_text` is the canonical `sort_keys` serialization the
  adapter already uses (base.py) with a D1160 whitespace fold (query strings / nested payload
  strings have every whitespace run collapsed to one ASCII space and ends trimmed; the request
  itself is never modified), so near-identical intents typed with copy-paste whitespace share
  one replay key.
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
import re
import threading
import time
from collections import OrderedDict
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


_WS = re.compile(r"\s+")


def _fold_ws_str(text: str) -> str:
    """Collapse every whitespace run (including U+3000) to a single ASCII space; trim ends.

    Two requests that differ only in whitespace are the same intent for a
    temperature-0 call — replaying the stored completion is honest. The fold is
    key-material only: the request the provider sees is untouched.
    """
    return _WS.sub(" ", text).strip()


def _fold_ws(value):  # noqa: ANN001 - recursive helper over JSON-ish structures
    if isinstance(value, str):
        return _fold_ws_str(value)
    if isinstance(value, dict):
        return {k: _fold_ws(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_fold_ws(v) for v in value]
    return value


#: D1499 — bounded PROCESS-LOCAL replay cache, on by default. Redis stays the opt-in
#: cross-process arm. Measured on this proxy: 95.3% prefix hits on 5 of 6 identical calls,
#: 0% on one — the "中途突然掉缓存" the owner reported. A byte-identical temperature-0
#: response replayed in-process removes the flicker entirely.
_LOCAL_MAX = 256
_LOCAL: "OrderedDict[str, tuple[float, str]]" = OrderedDict()
_LOCAL_LOCK = threading.Lock()


def _local_get(key: str) -> str | None:
    now = time.monotonic()
    with _LOCAL_LOCK:
        hit = _LOCAL.get(key)
        if hit is None:
            return None
        stored_at, blob = hit
        if now - stored_at > _ttl_s():
            _LOCAL.pop(key, None)
            return None
        _LOCAL.move_to_end(key)
        return blob


def _local_set(key: str, blob: str) -> None:
    with _LOCAL_LOCK:
        _LOCAL[key] = (time.monotonic(), blob)
        _LOCAL.move_to_end(key)
        while len(_LOCAL) > _LOCAL_MAX:
            _LOCAL.popitem(last=False)


def local_stats() -> dict[str, int]:
    """Honest telemetry: entries currently held and the ceiling."""
    with _LOCAL_LOCK:
        return {"entries": len(_LOCAL), "max": _LOCAL_MAX}


def _user_text(req: "LLMRequest") -> str:
    if req.prompt:
        return _fold_ws_str(req.prompt)
    # same canonicalisation as HttpLLMAdapter._user_text (sort_keys, compact separators),
    # with the D1160 whitespace fold so near-identical intents share one replay key
    return json.dumps(_fold_ws(req.payload), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


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
    """The replayed response if every input byte matches a stored one, else None.

    Redis (opt-in) is checked first; with no Redis client the bounded process-local store
    answers. Both paths use the SAME key and the SAME stored body, so a hit on either arm
    is byte-identical to the provider answer it replaced.
    """
    if not _cacheable(req, chain):
        return None
    key = _key(req, chain)
    client = _client()
    if client is None:
        raw = _local_get(key)
    else:
        try:
            raw = client.get(key)
        except Exception as exc:
            log.warning("nexus_ai.llm_response_cache get failed (%s); treating as a miss", exc)
            return None
    if not raw:
        return None
    try:
        payload = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return _resp_from(payload, req, stored_latency_ms=0)


def llm_cache_set(req: "LLMRequest", chain: tuple[str, ...], resp: "LLMResponse") -> bool:
    """Store a response for this exact byte-shape. Returns True on write."""
    if not _cacheable(req, chain):
        return False
    blob = json.dumps(_value_for(resp), ensure_ascii=False, default=str)
    key = _key(req, chain)
    client = _client()
    if client is None:
        _local_set(key, blob)
        return True
    try:
        client.set(key, blob, ex=_ttl_s())
        return True
    except Exception as exc:
        log.warning("nexus_ai.llm_response_cache set failed (%s); falling back to local", exc)
        _local_set(key, blob)
        return True


def reset_client() -> None:
    """Drop the memoised client so the next call re-reads the environment.

    D1055: this was `reset_for_tests`, and nothing in the product called it - which is the
    defect it was renamed for: `_CLIENT_TRIED` is a process-lifetime latch, so flipping
    `NEXUS_LLM_RESPONSE_CACHE` or `NEXUS_REDIS_URL` and re-reading the settings left the OLD
    client serving the NEW configuration. `config.reset_settings_cache()` is the moment the
    environment is declared changed, so it calls this (`test_llm_response_cache.py` and the
    conftest still call it directly between cases).
    """
    global _CLIENT, _CLIENT_TRIED
    _CLIENT, _CLIENT_TRIED = None, False
    with _LOCAL_LOCK:  # D1499: a config change invalidates local replays too
        _LOCAL.clear()
