"""An OPTIONAL shared tier for the tool-result cache.

The in-process cache (`tools/registry.py::_Cache`) is the right default: it is bounded, LRU,
TTL-disciplined, and process-local. When this project deploys more than one AI replica or runs
sidecars that serve the same tool calls, that local-only shape repeats the same query against
Postgres once per replica. This module adds a shared tier behind an *opt-in* env variable —
`NEXUS_AI_SHARED_CACHE=redis` (default is **off**, no shared state is read or written, and no
Redis client is constructed) — writing the same canonical key and the same TTL discipline as
the local tier.

Design choices, each pinned to a defect seen earlier on this plane:

* **Offline-tolerant, not Redis-required.** A Redis failure degrades to "this tier is absent":
  every exception path falls back to the local tier and logs a warning; the tool path NEVER
  fails because Redis is down. Behaviour with `NEXUS_AI_SHARED_CACHE` unset is byte-identical to
  before this lane existed.
* **TTL-expiring, like the local tier.** `SETEX key ttl` — no stale reads outliving the spec's
  `cache_ttl_s`. No key outlives its spec's own TTL once admitted.
* **The _MISS semantics stay: identity comparisons only.** This module's callers compare `is
  _MISS`; use None-vs-Sentinel as the return contract — never a falsy value, never a sentinel
  leak.
* **JSON-serialisable values only.** The canonical cache key is the same JSONable dict; values
  pass through `json.dumps(..., default=str)` and `json.loads`. Non-JSONable values silently skip
  the shared tier (the local tier still holds them) — tools that produce dataclasses and models are
  unchanged.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

log = logging.getLogger("nexus_ai.tools.redis_shared")


class RedisTier:
    """Opt-in shared tool-result cache backed by Redis. Enabled only when configured."""

    def __init__(self, url: str, *, socket_connect_timeout_s: float = 0.5) -> None:
        import redis

        self._client = redis.Redis.from_url(
            url,
            socket_connect_timeout=socket_connect_timeout_s,
            socket_timeout=1.0,
            decode_responses=True,
        )
        self._client.ping()  # fail FAST at construction, not on first tool call

    @classmethod
    def maybe_create(cls) -> "Optional[RedisTier]":
        """The one supported construction path: absent unless `NEXUS_AI_SHARED_CACHE=redis`."""
        import os

        if os.getenv("NEXUS_AI_SHARED_CACHE") != "redis":
            return None
        url = os.getenv("NEXUS_REDIS_URL", "redis://127.0.0.1:6380/0")
        try:
            return cls(url)
        except Exception as exc:  # pragma: no cover — infra down is a normal state, not a crash
            log.warning("nexus_ai.shared_cache=redis requested but Redis is unreachable (%s); "
                        "the shared tier stays disabled and the local cache is used", exc)
            return None

    @staticmethod
    def _key(spec_name: str, canonical_args: str) -> str:
        return f"nexus:tool-cache:{spec_name}:{canonical_args}"

    def get(self, spec_name: str, canonical_args: str) -> Any:
        try:
            raw = self._client.get(self._key(spec_name, canonical_args))
        except Exception as exc:  # pragma: no cover — infra must never break a tool call
            log.warning("shared Redis GET failed (%s); falling back to the local cache", exc)
            return None
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None  # a value written under a different schema is a miss, not a crash

    def set(self, spec_name: str, canonical_args: str, value: Any, ttl_s: int) -> None:
        if ttl_s <= 0:
            return
        try:
            raw = json.dumps(value, default=str)
        except (TypeError, ValueError):
            return  # non-JSONable values stay local-only, by contract
        try:
            self._client.setex(self._key(spec_name, canonical_args), int(ttl_s), raw)
        except Exception as exc:  # pragma: no cover — infra must never break a tool call
            log.warning("shared Redis SETEX failed (%s); the local cache holds the row", exc)


def redis_enabled() -> bool:
    import os

    return os.getenv("NEXUS_AI_SHARED_CACHE") == "redis"
