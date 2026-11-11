"""D922 — an OPTIONAL shared tool-result cache in front of Postgres.

The local `_Cache` is right for a single process. This unit asks whether a SECOND, shared tier
(NEXUS_AI_SHARED_CACHE=redis) can serve the identical tools without changing any default behaviour.
These tests pin the behaviours the mandate needs CI to keep honest:

* two SEPARATE registries that share one Redis instance see one call reach the handler,
  not two;
* with the env variable unset, nothing is shared and every registry executes its own handler;
* the offline-default posture: with the env set but Redis unreachable, dispatch still works —
  the tier degrades to absent instead of taking the tool path down;
* the shared key carries a TTL — nothing outlives its spec.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

from nexus_ai.api.demo_data import demo_backend
from nexus_ai.tools.builtin import build_get_business_hours
from nexus_ai.tools.registry import PERMISSION_READ, Registry

_REDIS_URL = os.getenv("NEXUS_REDIS_URL", "redis://127.0.0.1:6380/0")
_REDIS_UP = False
try:                             # the live CI seeds redis in both planes; local demo also has one
    import redis as redis_lib    # noqa: E402
    _REDIS_UP = bool(redis_lib.Redis.from_url(_REDIS_URL, socket_connect_timeout=0.5).ping())
except Exception:
    _REDIS_UP = False

needs_redis = pytest.mark.skipif(not _REDIS_UP, reason=f"redis not reachable at {_REDIS_URL}")


def _backend_with_counter(counter: dict):
    backend = demo_backend()
    merchant_id = next(r["merchant_id"] for r in backend.merchants)
    original = backend.hours

    async def counted(merchant_ids):
        counter["n"] += 1
        return await original(merchant_ids)

    backend.hours = counted
    return backend, merchant_id


@needs_redis
def test_shared_cache_serves_a_second_registry(monkeypatch):
    monkeypatch.setenv("NEXUS_AI_SHARED_CACHE", "redis")
    monkeypatch.setenv("NEXUS_REDIS_URL", _REDIS_URL)

    counter_a, counter_b = {"n": 0}, {"n": 0}
    backend_a, _ = _backend_with_counter(counter_a)
    backend_b, _ = _backend_with_counter(counter_b)
    # The demo fixture's merchant uuids are stable across runs, so stale residues live in redis;
    # a per-run random argument is the only honest way to know which registry truly ran the handler.
    merchant = f"probe-{uuid.uuid4()}"

    registry_a = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_get_business_hours(registry_a, backend_a)
    registry_b = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_get_business_hours(registry_b, backend_b)

    asyncio.run(registry_a.dispatch(subject="u1", tool="get_business_hours",
                                    arguments={"merchant_id": merchant}))
    asyncio.run(registry_b.dispatch(subject="u2", tool="get_business_hours",
                                    arguments={"merchant_id": merchant}))
    assert counter_a["n"] == 1   # registry A reaches the real handler
    assert counter_b["n"] == 0   # registry B answers from the shared tier, handler never called


@needs_redis
def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("NEXUS_AI_SHARED_CACHE", raising=False)

    counter_a, counter_b = {"n": 0}, {"n": 0}
    backend_a, _ = _backend_with_counter(counter_a)
    backend_b, _ = _backend_with_counter(counter_b)
    merchant = f"probe-{uuid.uuid4()}"   # fresh, so stale redis rows cannot fake the 1s

    registry_a = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_get_business_hours(registry_a, backend_a)
    registry_b = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_get_business_hours(registry_b, backend_b)

    asyncio.run(registry_a.dispatch(subject="u1", tool="get_business_hours",
                                    arguments={"merchant_id": merchant}))
    asyncio.run(registry_b.dispatch(subject="u2", tool="get_business_hours",
                                    arguments={"merchant_id": merchant}))
    assert counter_a["n"] == 1
    assert counter_b["n"] == 1   # no shared tier by default: every registry pays its own handler


@needs_redis
def test_shared_key_is_present_with_a_positive_ttl(monkeypatch):
    monkeypatch.setenv("NEXUS_AI_SHARED_CACHE", "redis")
    monkeypatch.setenv("NEXUS_REDIS_URL", _REDIS_URL)

    probe_merchant = f"probe-{uuid.uuid4()}"
    backend = demo_backend()
    counter = {"n": 0}
    original = backend.hours

    async def shaped(merchant_ids):
        # Return a stable, deterministic row for the probe merchant id
        return [{"merchant_id": mid, "weekday": 1, "opens_at": "09:00", "closes_at": "18:00"}
                for mid in merchant_ids]

    backend.hours = shaped
    registry = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_get_business_hours(registry, backend)
    out = asyncio.run(registry.dispatch(subject="u1", tool="get_business_hours",
                                        arguments={"merchant_id": probe_merchant}))
    assert out["merchant_id"] == probe_merchant

    import redis as redis_lib
    client = redis_lib.Redis.from_url(_REDIS_URL, socket_connect_timeout=0.5, decode_responses=True)
    keys = [k for k in client.scan_iter("nexus:tool-cache:get_business_hours:*")]
    assert keys, "the shared tier wrote no key under the canonical prefix"
    ttl = client.ttl(keys[0])
    assert ttl and ttl > 0, "the shared key carries no TTL — nothing may outlive its spec"


def test_shared_cache_degrades_to_absent_when_redis_is_unreachable(monkeypatch):
    monkeypatch.setenv("NEXUS_AI_SHARED_CACHE", "redis")
    monkeypatch.setenv("NEXUS_REDIS_URL", "redis://127.0.0.1:1/0")   # nothing listens there

    counter = {"n": 0}
    backend, _ = _backend_with_counter(counter)
    merchant = f"probe-{uuid.uuid4()}"   # fresh, so no stale row can fake the handler's absence
    registry = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_get_business_hours(registry, backend)
    out = asyncio.run(registry.dispatch(subject="u1", tool="get_business_hours",
                                        arguments={"merchant_id": merchant}))
    assert out["merchant_id"] == merchant
    assert counter["n"] == 1   # handler answered despite the requested-but-down Redis
