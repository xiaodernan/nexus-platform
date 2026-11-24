"""D1548 - the AI's internal hop to the platform must not inherit the ambient proxy.

`HttpPlatformClient._http()` built a `httpx.AsyncClient` with httpx's default `trust_env=True`, so
the environment decides two things about a call that never leaves the host or the docker network:

  * WHETHER THE CALL CAN BE MADE AT ALL. httpx 0.28.1 parses every `NO_PROXY` entry as a URL and
    recognises only the BARE IPv6 form (`_utils.py:65-74`), so the bracketed `[::1]` - the form curl
    accepts, and the form this very host exports - becomes the mount key `all://*[::1]` and dies in
    `normalize_port` with `InvalidURL: Invalid port: ':1]'`. That happens inside the CONSTRUCTOR: no
    URL, no request, no socket exists yet. Five D969 tests have been red on this host for it.
  * WHERE THE RELAY GOES. With an ambient `HTTP_PROXY` and a `NO_PROXY` that names only
    `localhost,127.0.0.1` - the usual operator shape - a platform addressed by SERVICE NAME
    (`http://platform:8080`, the compose plane) is served by an `AsyncHTTPProxy` pool. Every internal
    relay is then a proxied round trip, which is the most likely cause of the 7-19 s per live call
    PLAN OWED (d) records.

`trust_env=False` fixes both. D1577 later extended the same rule to the LLM and embedding
clients: an ambient proxy on this host was a Clash Verge :7897 dependency, and with Clash off
every lane using it died with ECONNREFUSED. A proxy is now opt-in via `NEXUS_LLM_PROXY` only;
R4 pins that the LLM lane also ignores the environment, while a new R5 keeps the explicit seam.

Offline throughout: no socket is opened, only the mounted transport is inspected.
"""
from __future__ import annotations

import httpx

from nexus_ai.adapters.platform import HttpPlatformClient
from nexus_ai.models.base import HttpLLMAdapter

PLATFORM = "http://platform:8080"
PROXY_URL = "http://proxy.invalid:3128"


def _set_proxy_env(monkeypatch, *, no_proxy: str | None, proxy: str | None = PROXY_URL) -> None:
    """Pin the four variables httpx reads, so the host's own sandbox cannot decide the verdict."""
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    if proxy is not None:
        monkeypatch.setenv("HTTP_PROXY", proxy)
        monkeypatch.setenv("HTTPS_PROXY", proxy)
    if no_proxy is not None:
        monkeypatch.setenv("NO_PROXY", no_proxy)


def _pool_for(client: httpx.AsyncClient, url: str) -> str:
    """The class that will carry this URL: AsyncConnectionPool = direct, AsyncHTTPProxy = proxied."""
    return type(client._transport_for_url(httpx.URL(url))._pool).__name__


class TestInternalHopIgnoresAmbientProxy:
    async def test_r1_bracketed_ipv6_no_proxy_does_not_strand_the_adapter(self, monkeypatch):
        _set_proxy_env(monkeypatch, no_proxy="localhost,127.0.0.1,[::1],::1")
        client = HttpPlatformClient(PLATFORM)
        try:
            http = client._http()          # shipped: raises InvalidURL before any request exists
            assert isinstance(http, httpx.AsyncClient)
        finally:
            await client.aclose()

    async def test_r2_internal_relay_is_not_sent_to_the_ambient_proxy(self, monkeypatch):
        _set_proxy_env(monkeypatch, no_proxy="localhost,127.0.0.1")
        client = HttpPlatformClient(PLATFORM)
        try:
            http = client._http()
            assert _pool_for(http, f"{PLATFORM}/api/v1/merchants/m1") == "AsyncConnectionPool"
        finally:
            await client.aclose()

    async def test_r3_direct_still_holds_with_no_proxy_env_at_all(self, monkeypatch):
        _set_proxy_env(monkeypatch, no_proxy=None, proxy=None)
        client = HttpPlatformClient(PLATFORM)
        try:
            assert _pool_for(client._http(), f"{PLATFORM}/api/v1/merchants/m1") == "AsyncConnectionPool"
        finally:
            await client.aclose()

    async def test_r4_the_llm_lane_ignores_the_ambient_proxy_too(self, monkeypatch):
        """D1577: no outbound lane silently inherits a local proxy (Clash :7897)."""
        _set_proxy_env(monkeypatch, no_proxy="localhost,127.0.0.1")
        adapter = HttpLLMAdapter(base_url="https://api.test/v1", api_key="k")
        try:
            assert _pool_for(adapter._http(), "https://api.test/v1/chat/completions") == "AsyncConnectionPool"
        finally:
            await adapter._http().aclose()

    async def test_r5_an_explicit_proxy_is_still_honoured(self, monkeypatch):
        """Unbinding from the ambient proxy must not remove the deliberate opt-in seam."""
        _set_proxy_env(monkeypatch, no_proxy=None, proxy=None)
        adapter = HttpLLMAdapter(base_url="https://api.test/v1", api_key="k", proxy=PROXY_URL)
        try:
            assert _pool_for(adapter._http(), "https://api.test/v1/chat/completions") == "AsyncHTTPProxy"
        finally:
            await adapter._http().aclose()
