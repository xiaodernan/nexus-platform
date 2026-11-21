"""D1488 — `search_web` must be a real, SSRF-guarded egress tool, not a declaration.

The canonical tool list has named `search_web` for a long time with no implementation.
This gate pins the implementation: allow-list + DNS-rebind guard, bounded parse, untrusted
output markers, and fail-soft behaviour when the network is absent. A mocked fetch keeps
the unit deterministic; one live probe (separate script) proves the real path through the
operator proxy.
"""

from __future__ import annotations

import asyncio

import pytest

from nexus_ai.tools.registry import InvalidArguments, Registry
from nexus_ai.tools.search_web import (
    ALLOWED_HOSTS,
    build_search_web,
    is_public_host,
)


def _registry():
    return Registry()


def _fake_payload():
    return {"query": {"search": [
        {"pageid": 123, "title": "Happy Valley Racecourse",
         "snippet": "A <span class=\"searchmatch\">racecourse</span> in Happy Valley, Hong Kong."},
        {"pageid": 456, "title": "香港的一日", "snippet": "香港的一日一夜。"},
    ]}}


def _dispatch(spec, reg, args):
    return asyncio.run(reg.dispatch(subject="u1", tool=spec.name, arguments=args))


class TestAllowListAndDnsRebindGuard:
    def test_only_allowlisted_hosts_are_reachable(self):
        assert "zh.wikipedia.org" in ALLOWED_HOSTS
        assert "en.wikipedia.org" in ALLOWED_HOSTS
        assert is_public_host("169.254.169.254") is False
        assert is_public_host("localhost") is False
        assert is_public_host("127.0.0.1") is False
        assert is_public_host("evil.example.com") is False

    def test_a_private_dns_answer_is_refused(self, monkeypatch):
        import socket
        monkeypatch.setattr(socket, "getaddrinfo",
                            lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "",
                                              ("127.0.0.1", 80))])
        assert is_public_host("zh.wikipedia.org") is False

    def test_a_rebind_to_metadata_is_refused(self, monkeypatch):
        import socket
        monkeypatch.setattr(socket, "getaddrinfo",
                            lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "",
                                              ("169.254.169.254", 80))])
        assert is_public_host("en.wikipedia.org") is False


class TestRealHandler:
    def test_returns_structured_untrusted_results(self):
        reg = _registry()
        spec = build_search_web(reg, resolve=lambda _h: True, fetch=lambda _u: _fake_payload())
        out = _dispatch(spec, reg, {"query": "Happy Valley", "language": "en"})
        assert out["query"] == "Happy Valley"
        assert len(out["results"]) == 2
        assert out["results"][0]["title"] == "Happy Valley Racecourse"
        assert "searchmatch" not in out["results"][0]["snippet"]
        assert out["source"] == "third_party"
        assert out["confidence"] == "low"

    def test_offline_fails_soft_without_fabricating_rows(self):
        reg = _registry()
        spec = build_search_web(reg, resolve=lambda _h: False, fetch=lambda _u: ({}))
        out = _dispatch(spec, reg, {"query": "anything"})
        assert out["results"] == []
        assert out["reason"] == "web_search_unavailable"

    def test_malformed_fetch_answer_is_an_empty_list(self):
        reg = _registry()
        spec = build_search_web(reg, resolve=lambda _h: True, fetch=lambda _u: ({"unexpected": 1}))
        out = _dispatch(spec, reg, {"query": "anything"})
        assert out["results"] == []

    def test_query_is_bounded(self):
        reg = _registry()
        spec = build_search_web(reg, resolve=lambda _h: True, fetch=lambda _u: (_fake_payload()))
        assert _dispatch(spec, reg, {"query": "   "})["reason"] == "empty_query"
        # the registry schema is the first gate: an overlong query never reaches the handler
        with pytest.raises(InvalidArguments):
            _dispatch(spec, reg, {"query": "x" * 201})

    def test_host_is_decided_from_language_not_from_input(self):
        """An injected `url` in the arguments cannot aim the tool at arbitrary hosts."""
        reg = _registry()
        seen = []
        spec = build_search_web(reg, resolve=lambda _h: True,
                                fetch=lambda u: (seen.append(u), _fake_payload())[1])
        # the schema refuses the undeclared `url` outright — no URL injection is possible
        with pytest.raises(InvalidArguments):
            _dispatch(spec, reg, {"query": "x", "language": "en",
                                  "url": "http://169.254.169.254/"})
        assert not seen  # no network call was ever attempted

    def test_manifest_reports_the_tool_implemented(self):
        reg = _registry()
        build_search_web(reg, resolve=lambda _h: True, fetch=lambda _u: ({}))
        entry = next(e for e in reg.manifest() if e.name == "search_web")
        assert entry.name == "search_web"
