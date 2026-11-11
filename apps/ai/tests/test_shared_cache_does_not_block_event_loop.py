"""D962 — the opt-in shared tool-result cache must never block the asyncio event loop.

`RedisTier` (tools/redis_tier.py) deliberately uses the SYNCHRONOUS redis-py client: `get()`
and `set()` are blocking socket reads/writes bounded by `socket_timeout=1.0s`. That is a fine
choice for a library that degrades to "no shared tier" — but `Registry.dispatch` is `async def`
and runs on the uvicorn event loop, so calling those blocking methods inline starves EVERY
concurrent request on that worker and freezes the per-tool `asyncio.wait_for` timeout.

D962 offloads BOTH shared-cache calls with `await asyncio.to_thread(self._shared.get/set, ...)`.
This test proves the property on the REAL dispatch pipeline with a controlled blocking stub —
no live Redis, no network, no wall-clock timing assertions:

* positive: with the shipped offload, a heartbeat task keeps ticking WHILE a slow shared cache
  read/write is in flight — the event loop stays responsive.
* falsifier: replace `asyncio.to_thread` with an awaitable that runs the blocking fn INLINE on
  the loop thread (exactly the pre-D962 bare-call behavior) and require the heartbeat to
  collapse — proving the green is caused by the offload, not by a stub that never blocks.

The heartbeat is stopped by an Event the instant dispatch returns, so it counts loop turnarounds
STRICTLY during the in-flight window: an offloaded loop yields many, a starved loop yields ~0.

The two ``_shared.get``/``set`` call sites are the load-bearing surface; `scripts/check_shared_
cache_async.mjs` holds the matching structural + wiring claims. Nothing here claims a live Redis
round trip was measured, that a real FastAPI worker was scheduled, or any latency number.
"""

from __future__ import annotations

import asyncio
import time

from nexus_ai.tools.registry import PERMISSION_READ, Registry, ToolSpec

BLOCK_S = 0.06          # stand-in for a slow Redis RTT (well under socket_timeout=1.0s)
_HEARTBEAT_PERIOD = 0.002  # fine on Linux CI; Windows' ~15ms tick cap still clears the threshold


def _registry_with_slow_shared():
    """A real Registry whose shared tier blocks for BLOCK_S on each get/set, inline."""
    reg = Registry(permissions=lambda _s: {PERMISSION_READ})

    class BlockingShared:
        def get(self, spec_name, canonical_args):
            time.sleep(BLOCK_S)              # the exact shape of sync redis-py .get()
            return None                      # a miss: force the handler + the SET path too

        def set(self, spec_name, canonical_args, value, ttl_s):
            time.sleep(BLOCK_S)              # the exact shape of sync redis-py .setex()

    reg._shared = BlockingShared()
    spec = ToolSpec(name="get_price", version="1", permission=PERMISSION_READ,
                    input_schema={"type": "object"}, output_schema={"type": "object"},
                    cache_ttl_s=60, timeout_ms=4000, retries=0)

    async def handler(args, *, subject):
        return {"ok": subject}

    reg.register(spec, handler=handler)
    return reg


async def _run_dispatch_with_heartbeat() -> int:
    """Count event-loop turnarounds strictly while one dispatch is in flight."""
    reg = _registry_with_slow_shared()
    ticks: list[int] = [0]
    stop = asyncio.Event()

    async def heartbeat():
        while not stop.is_set():
            ticks[0] += 1
            await asyncio.sleep(_HEARTBEAT_PERIOD)

    hb = asyncio.create_task(heartbeat())
    try:
        # The shared GET blocks BLOCK_S on its worker thread, the handler runs, then the shared
        # SET blocks another BLOCK_S. Offloaded, the loop stays free and the heartbeat runs;
        # inline, the loop is frozen for both windows and the heartbeat cannot get scheduled.
        await reg.dispatch(subject="u1", tool="get_price", arguments={"q": "probe"})
    finally:
        stop.set()
        await hb
    return ticks[0]


def test_shared_cache_offload_keeps_event_loop_responsive():
    """Positive: with asyncio.to_thread in place, a slow shared GET/SET does not starve the loop."""
    ticks = asyncio.run(_run_dispatch_with_heartbeat())
    # An offloaded loop yields many heartbeat turns across the two ~0.06s windows; a starved
    # loop yields ~0 (it cannot be scheduled while the loop is frozen). The threshold is far
    # above the starved count and below even the coarse Windows-tick responsive count.
    assert ticks >= 4, f"event loop was starved by the shared-cache I/O (heartbeat ticks={ticks})"


def test_without_offload_the_loop_is_starved(monkeypatch):
    """Falsifier: inline the blocking calls (the pre-D962 behavior) and require the green to REDDEN.

    One flipped variable: `await asyncio.to_thread(fn, *a)` -> `await inline(fn, *a)` where
    `inline` runs `fn` synchronously on the loop thread. If the positive test were green for a
    reason OTHER than the offload (e.g. the stub never really blocks), this arm stays green too
    and fails the unit — the same no-op discipline the census gates use.
    """
    async def inline(fn, /, *args, **kwargs):
        # awaitable so the product's `await asyncio.to_thread(...)` stays valid, but the
        # blocking fn runs INLINE on the loop thread — exactly the pre-D962 bare-call shape.
        return fn(*args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", inline, raising=True)
    ticks = asyncio.run(_run_dispatch_with_heartbeat())
    assert ticks <= 2, f"removing the offload did not starve the loop (ticks={ticks}); the positive arm is vacuous"
