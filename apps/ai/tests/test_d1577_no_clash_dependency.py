"""D1577 — the product has NO Clash Verge dependency.

The host used to carry `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7897` and the gitignored
`.env` files carried `NEXUS_LLM_PROXY=http://127.0.0.1:7897`. With Clash off, every outbound
lane that read those variables died with ECONNREFUSED. Egress is now DIRECT by default;
a proxy is an explicit, opt-in knob (`NEXUS_LLM_PROXY` / `NEXUS_WEB_PROXY`) and never inherited
from the ambient environment. These pins are pure and offline: no network is opened.
"""
from __future__ import annotations

import asyncio
import importlib
from pathlib import Path

import httpx

from nexus_ai.models.base import HttpLLMAdapter


def _pool_for(client, url: str) -> str:
    return type(client._transport_for_url(httpx.URL(url))._pool).__name__


class TestNoClashDependency:
    def test_llm_lane_ignores_a_hostile_ambient_proxy(self, monkeypatch):
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:7897")
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
        adapter = HttpLLMAdapter(base_url="https://api.test/v1", api_key="k")
        try:
            assert _pool_for(adapter._http(), "https://api.test/v1/chat/completions") == "AsyncConnectionPool"
        finally:
            asyncio.run(adapter._http().aclose())

    def test_explicit_proxy_still_works(self, monkeypatch):
        monkeypatch.delenv("HTTPS_PROXY", raising=False)
        adapter = HttpLLMAdapter(base_url="https://api.test/v1", api_key="k",
                                 proxy="http://proxy.invalid:3128")
        try:
            assert _pool_for(adapter._http(), "https://api.test/v1/chat/completions") == "AsyncHTTPProxy"
        finally:
            asyncio.run(adapter._http().aclose())

    def test_web_facts_builds_a_direct_opener_and_ignores_ambient_proxy(self, monkeypatch):
        sw = importlib.import_module("nexus_ai.tools.search_web")
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:7897")
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
        monkeypatch.delenv("NEXUS_WEB_PROXY", raising=False)
        captured: dict = {}

        class FakeOpener:
            def open(self, req, timeout=None):
                raise RuntimeError("no network in this pin")

        def fake_build(*handlers):
            captured["handlers"] = handlers
            return FakeOpener()

        monkeypatch.setattr(sw.urllib.request, "build_opener", fake_build)
        assert sw._fetch_json("https://zh.wikipedia.org/w/api.php?format=json") == {}
        handlers = captured["handlers"]
        assert len(handlers) == 1
        proxy_map = handlers[0].proxies
        assert proxy_map == {}, f"ambient proxy leaked into the web-facts opener: {proxy_map}"

    def test_web_facts_opt_in_proxy_is_explicit(self, monkeypatch):
        sw = importlib.import_module("nexus_ai.tools.search_web")
        monkeypatch.setenv("NEXUS_WEB_PROXY", "http://proxy.invalid:3128")
        captured: dict = {}

        class FakeOpener:
            def open(self, req, timeout=None):
                raise RuntimeError("no network in this pin")

        monkeypatch.setattr(sw.urllib.request, "build_opener",
                            lambda *handlers: (captured.update(handlers=handlers) or FakeOpener()))
        assert sw._fetch_json("https://zh.wikipedia.org/w/api.php?format=json") == {}
        assert captured["handlers"][0].proxies == {
            "http": "http://proxy.invalid:3128",
            "https": "http://proxy.invalid:3128",
        }

    def test_every_outbound_client_disables_ambient_proxy(self):
        root = Path(importlib.import_module("nexus_ai").__file__).resolve().parent
        for rel in ["models/base.py", "models/embeddings.py", "adapters/platform.py"]:
            text = (root / rel).read_text(encoding="utf-8")
            assert "trust_env=False" in text, f"{rel} can still inherit HTTP(S)_PROXY"
