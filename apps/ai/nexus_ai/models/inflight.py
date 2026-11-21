"""D1169 — singleflight coalescing for byte-identical temperature-0 model calls.

**The hole.** The opt-in Redis replay cache (D1047) collapses *sequential* duplicates:
same verified request → stored answer, zero provider cost. The *concurrent* case is untouched:
N identical calls launched in the same window each hit the provider anyway. Under real traffic
a hot intent — a shared demo tenant, a homepage opening six components deriving the same
search embedding — is this the dominant cost shape of a burst.

**The fix.** One pending cell per (chain, task_class, system, user_text, max_tokens,
json_hint, subject_id). The first caller runs the chain; every other caller in the
window awaits the same future.
The winner pays one provider call; every waiter is answered like a replay — zero tokens,
cache_hit=True — with the same `fallback_from` semantics. The winner's RoutedCall is metered
as usual; waiters bill zero tokens.

**Guarantees.**
- Temperature ≠ 0 is excluded — nondeterministic-by-contract never shares a cell (D1047's
  rule, carried over). `reason` task class is excluded like the replay.
- The coalesced waiters never see an exception the winner caught: they inherit the same
  exception instance (the §105 chain ladder is already collapsed below this level).
- If coalescing itself fails to install the cell (dict logic bug — the provider never runs),
  the helper returns None and the caller degrades to the plain serial chain.
- The cell is destroyed after the provider answers or the chain errors; a crash leaves no
  cell behind.
- Opt-out: `NEXUS_LLM_INFLIGHT_COALESCE=0` (or false/no/off) restores the pre-D1169 path exactly.

**Honesty boundaries.** Process-local — no persistence, no cross-process sharing. Two processes
each holding a cell for the same key both still hit the provider (Redis replay cache is the
cross-process arm). No ordering guarantee. The winner contributes the provider call; waiters
receive zero-metered "replay" rows (status ok, cache_hit=True, cost_usd=0, tokens=0).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

from nexus_ai.api.llm_response_cache import _user_text
from nexus_ai.models.base import LLMRequest

log = logging.getLogger("nexus_ai.models.inflight")

__all__ = ["enabled", "chain_key", "InflightCoalescer"]


def enabled() -> bool:
    return os.environ.get("NEXUS_LLM_INFLIGHT_COALESCE", "").strip().lower() not in {
        "0", "false", "no", "off",
    }


def chain_key(req: LLMRequest, chain: tuple[str, ...]) -> str:
    """The inflight cell key — kept byte-identical to the replay cache's key dimensions.

    D1496: the replay cache keys on `{task_class, system, user, max_tokens, json_hint,
    subject_id, chain}` but this coalescer used to omit `max_tokens` and `subject_id`.
    Two parallel calls with the same prompt but different completion caps (or from
    different subjects) could share one future, so the short-capped caller inherited a
    longer answer and vice versa — cache interference between parallel sessions. Both
    dimensions are now part of the cell key, so coalescing only merges byte-identical work.
    The conversation history already lives inside `system`/`user`, so sessions whose
    histories differ never collide.
    """
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
    return hashlib.sha256(blob.encode()).hexdigest()


class InflightCoalescer:
    """One pending cell per (chain, key). No timer heap — fire and forget with a gate."""

    def __init__(self) -> None:
        self._pending: dict[str, Any] = {}

    async def run(self, key: str, coro_fn):
        existing = self._pending.get(key)
        if existing is not None:
            return (await existing, True)
        try:
            import asyncio

            task = asyncio.ensure_future(coro_fn())
        except Exception:
            # can't even create the future — degrade to the plain serial call, never to a hung cell
            return (await coro_fn(), False)
        self._pending[key] = task
        try:
            return (await task, False)
        finally:
            # the cell is recreated for the NEXT request; this window is over
            self._pending.pop(key, None)
