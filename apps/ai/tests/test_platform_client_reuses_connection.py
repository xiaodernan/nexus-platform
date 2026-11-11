"""D969 — the AI→platform adapter must REUSE one HTTP connection across relays.

`HttpPlatformClient._request` used to do `async with httpx.AsyncClient(...) as client:` per
call, so every relay (get_merchant / create_cart / ... / the per-turn dialogue write in
routes_stream._persist_turn) paid a fresh TCP (and TLS) handshake with no keep-alive, inflating
RTT and TIME_WAIT/fd pressure. This is the D904 candidate the PLAN already registered: the
door is a counting transport proving one connection serves N relays.

The proof is offline — httpx.MockTransport, no live platform, DB or network. The positive arm
injects ONE counting client and asserts N relays go through that single instance and that
aclose releases it once. The falsifier flips exactly one variable: it monkeypatches `_http`
back to a per-call "new AsyncClient" (the pre-D969 shape) and requires the construction count
to become N, reddening the positive arm's ``== 1``. A lifecycle arm pins the shutdown hook.
"""

from __future__ import annotations

import httpx

from nexus_ai.adapters.platform import (
    HttpPlatformClient,
    StubPlatformClient,
    aclose_platform_client,
    get_platform_client,
    reset_platform_client,
    set_platform_client,
)

RELAYS = 5


class _CountingClient:
    """Minimal client double: counts request calls and aclose, returns a fixed envelope."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str]] = []
        self.closes = 0

    async def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        self.requests.append((method, url))
        return httpx.Response(200, json={"ok": True})

    async def aclose(self) -> None:
        self.closes += 1


async def test_one_client_serves_n_relays():
    """Positive: N relays flow through ONE injected client; aclose releases it exactly once."""
    counting = _CountingClient()
    client = HttpPlatformClient("http://platform.test", client=counting)
    for _ in range(RELAYS):
        env = await client.get_merchant("m1")
        assert env == {"ok": True}
    # One instance served every relay — that is what keeps the keep-alive connection alive.
    assert len(counting.requests) == RELAYS
    assert all(u.startswith("http://platform.test/api/v1/merchants/") for _, u in counting.requests)
    await client.aclose()
    assert counting.closes == 1
    # aclose is idempotent: a second call must not double-close.
    await client.aclose()
    assert counting.closes == 1


async def test_per_call_client_falsifier(monkeypatch):
    """Falsifier: flip `_http` back to per-call construction; the count must become N.

    This is the one variable that separates D969 from its absence. With the shipped `_http`
    the construction count is 1 (positive arm); recreating the pre-D969 per-call shape makes
    it RELAYS, which reddens the positive arm's `== 1` and proves the arm is load-bearing.
    """
    constructed: list[httpx.AsyncClient] = []

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    def per_call(self: HttpPlatformClient):
        # The pre-D969 behaviour: a brand-new AsyncClient on every single request.
        c = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        constructed.append(c)
        return c

    monkeypatch.setattr(HttpPlatformClient, "_http", per_call, raising=True)
    client = HttpPlatformClient("http://platform.test")
    try:
        for _ in range(RELAYS):
            await client.get_merchant("m1")
    finally:
        for c in constructed:
            await c.aclose()
    assert len(constructed) == RELAYS, (
        "the per-call falsifier must construct one client per relay; if this is 1 the "
        "monkeypatch did not restore the pre-D969 shape and the positive arm is vacuous"
    )


async def test_http_adapter_pools_under_concurrency():
    """N concurrent relays still go through the single injected client (no per-call churn)."""
    import asyncio

    counting = _CountingClient()
    client = HttpPlatformClient("http://platform.test", client=counting)
    await asyncio.gather(*(client.get_merchant(f"m{i}") for i in range(RELAYS)))
    assert len(counting.requests) == RELAYS
    await client.aclose()
    assert counting.closes == 1


async def test_lazy_http_builds_one_client_with_the_timeout_contract():
    """With no injection, `_http` lazily builds a real client once, carrying timeout_s.

    We do not open a socket (no request is issued); we only assert the object identity and
    the timeout contract, then close it to avoid leaking a transport.
    """
    client = HttpPlatformClient("http://platform.test", timeout_s=7.5)
    first = client._http()
    assert isinstance(first, httpx.AsyncClient)
    assert first.timeout.read == 7.5
    assert client._http() is first  # same instance on the second call
    await client.aclose()


async def test_shutdown_hook_closes_http_client_and_is_a_stub_noop():
    """The lifespan hook releases a real pooled adapter; stub / unset factory is a no-op."""
    counting = _CountingClient()
    try:
        reset_platform_client()
        set_platform_client(HttpPlatformClient("http://platform.test", client=counting))
        await aclose_platform_client()
        assert counting.closes == 1
        # the factory returns to the uninitialised state after closing
        from nexus_ai.adapters.platform import _CLIENT

        assert _CLIENT is None

        # stub mode with no aclose: the hook must not raise
        set_platform_client(StubPlatformClient())
        await aclose_platform_client()
    finally:
        reset_platform_client()


def test_shutdown_bound_and_header_contract_survive():
    """The fix must not alter the documented timeout default or the internal-token header."""
    client = HttpPlatformClient("http://platform.test")
    assert client.timeout_s == 5.0
    headers = client._headers(None, "t1", "idem-key-123456", "internal-xyz")
    assert headers["Idempotency-Key"] == "idem-key-123456"
    assert headers["X-Internal-Token"] == "internal-xyz"
    assert headers["X-Tenant"] == "t1"


def test_get_platform_client_is_still_a_factory_singleton():
    """Regression: the adapter stays a singleton behind the factory, so one pool per process."""
    reset_platform_client()
    try:
        a = get_platform_client()
        b = get_platform_client()
        assert a is b
        assert a.mode == "stub"
    finally:
        reset_platform_client()
