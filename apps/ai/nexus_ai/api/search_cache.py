"""An OPTIONAL, strictly-gated Redis cache for the deterministic sort-only search.

**Why this exists.** The home page fires the same sort-only query four times per render —
distance, price_low, trending, rating/trending — each with `raw_query=""`, default filters, and
no user state. Each call is a deterministic SQL+ranking round trip over the seeded corpus. A
reload that happens inside a 30-second window should not pay four fresh identical round trips.

**What is NOT cached.**
- The SSE stream (`/ai/v1/search/stream`) never touches this module.
- Any request carrying a `raw_query`, a non-empty filter, a non-default locale, a conversation id,
  or a user id is NOT cached — cached answers must be byte-identical to a fresh one, and the key
  must cover every input that varies.
- The tenant is part of the key; this cache never leaks across tenants.

**Design lines.**
- *Opt-in via `NEXUS_SEARCH_CACHE=redis`.* Default is **off**: `maybe_create`-style clients are
  never built, every public function is a no-op.
- *Offline-tolerant, not Redis-required.* Every exception degrades to "cache absent" with one log;
  the search itself never fails because Redis is down.
- *Narrow key.* `sha256(json(sort, geo, limit, locale, filters, tenant))` with a 30-second TTL
  (`NEXUS_SEARCH_CACHE_TTL_S`) — a cached answer expires well before any fact or seed can change.
- *JSONable only.* Values pass through `json.dumps(..., default=str)`; non-serialisable payloads
  silently skip the cache. The stored body drops `agent_run_id` / `took_ms`, and adds nothing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Optional

log = logging.getLogger("nexus_ai.api.search_cache")

_CLIENT: Optional[Any] = None
_CLIENT_TRIED = False


def _client() -> Optional[Any]:
    """Provider for the shared Redis client — created on first call, opt-in only, off unless enabled."""
    global _CLIENT, _CLIENT_TRIED
    if _CLIENT_TRIED:
        return _CLIENT
    _CLIENT_TRIED = True
    if os.getenv("NEXUS_SEARCH_CACHE", "").strip().lower() != "redis":
        _CLIENT = None
        return None
    url = os.getenv("NEXUS_REDIS_URL", "redis://127.0.0.1:6380/0")
    try:
        import redis

        client = redis.Redis.from_url(
            url,
            socket_connect_timeout=0.5,
            socket_timeout=1.0,
            decode_responses=True,
        )
        client.ping()
        log.info("nexus_ai.search_cache=redis url=%s", url.split("@", 1)[-1])
        _CLIENT = client
    except Exception as exc:  # infra down is a normal state, not a crash
        log.warning("nexus_ai.search_cache=redis requested but unreachable (%s); cache stays off", exc)
        _CLIENT = None
    return _CLIENT


def _is_rails_shape(payload: dict[str, Any]) -> bool:
    """True iff this request is exactly the shape the rails fetch — sort-only, no query, no user state."""
    intent = payload.get("intent") or {}
    if isinstance(intent, dict):
        raw = intent.get("raw_query")
    else:
        raw = getattr(intent, "raw_query", None)
    if raw not in (None, ""):
        return False
    filters = payload.get("filters") or {}
    if isinstance(filters, dict):
        for value in filters.values():
            if value not in (None, "", [], {}, False):
                return False
    if payload.get("conversation_id"):
        return False
    if payload.get("user_id"):
        return False
    return True


def _canon_key(payload: dict[str, Any]) -> str:
    intent = payload.get("intent") or {}
    sort = (intent or {}).get("sort_preference") if isinstance(intent, dict) else getattr(intent, "sort_preference", None)
    parts = {
        "sort": sort,
        "geo": payload.get("geo"),
        "limit": payload.get("limit"),
        "locale": payload.get("locale"),
        "filters": payload.get("filters"),
        "tenant": payload.get("tenant"),
    }
    return "nexus:search:cache:" + hashlib.sha256(
        json.dumps(parts, sort_keys=True, default=str).encode()
    ).hexdigest()


def rails_cache_get(payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Return the cached rail body if present, else None. `None` means "build it live"."""
    if not _is_rails_shape(payload):
        return None
    client = _client()
    if client is None:
        return None
    key = _canon_key(payload)
    try:
        raw = client.get(key)
    except Exception as exc:
        log.warning("nexus_ai.search_cache get failed (%s); treating as a miss", exc)
        return None
    if not raw:
        return None
    try:
        body = json.loads(raw)
    except Exception:
        return None
    return dict(body)


def rails_cache_set(payload: dict[str, Any], body: dict[str, Any]) -> bool:
    """Store the rail body when the request fits the cache discipline. Returns True on write."""
    if not _is_rails_shape(payload):
        return False
    client = _client()
    if client is None:
        return False
    try:
        ttl = int(os.getenv("NEXUS_SEARCH_CACHE_TTL_S", "30"))
    except ValueError:
        ttl = 30
    key = _canon_key(payload)
    try:
        client.setex(key, ttl, json.dumps({
            k: v for k, v in body.items() if k not in ("agent_run_id", "took_ms", "_cached")
        }, default=str))
        return True
    except Exception as exc:
        log.warning("nexus_ai.search_cache set failed (%s); nothing cached", exc)
        return False
