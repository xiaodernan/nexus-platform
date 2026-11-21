"""The one egress tool: `search_web`, with real SSRF guards (AGENT_CONTRACT §3).

The canonical tool list declares `search_web`; for a long time nothing implemented it,
so an agent asking the web got `UnknownTool`. This module is the implementation. It is
deliberately narrow and single-purpose:

* **Allow-list** — only the hosts named in `ALLOWED_HOSTS` are reachable. No arbitrary
  URL input; the caller supplies a query, never a target.
* **DNS-rebind guard** — every resolved address must be a GLOBAL unicast IP. A hostname
  that flips to localhost after validation is refused on the next resolve too.
* **Bounded I/O** — 10s wall clock, 200 KB response cap, UTF-8 with replacement, and a
  4-result cap. The body is parsed as JSON only; no HTML or script is ever executed.
* **Untrusted output** — every row carries `source: third_party` and a `low` confidence
  marker. The model may quote it, never treat it as product fact (§1 trust ladder).

Offline planes fail soft: no network means `results: []` and a `reason`, never invented
rows. A tool that could fabricate "search results" would be worse than one that is absent.
"""

from __future__ import annotations

import asyncio
import html
import ipaddress
import json
import socket
import urllib.parse
import urllib.request
from typing import Any, Mapping

from nexus_ai.tools.registry import (
    PERMISSION_READ,
    Registry,
    ToolSpec,
)

#: The only egress targets. The caller sends a QUERY, never a URL, so an injection
#: cannot aim the tool at the metadata service or an internal admin port.
ALLOWED_HOSTS: frozenset[str] = frozenset({
    "en.wikipedia.org", "zh.wikipedia.org", "zh.m.wikipedia.org",
    "en.m.wikipedia.org",
})

#: Wikipedia's MediaWiki search API — real web data, no API key, stable JSON.
_API_BASE = "https://{host}/w/api.php"
_TIMEOUT_S = 10
_MAX_BYTES = 200_000
_MAX_RESULTS = 4
MAX_QUERY_CHARS = 200

_REASON_NO_QUERY = "empty_query"
_REASON_QUERY_TOO_LONG = "query_too_long"
_REASON_OFFLINE = "web_search_unavailable"


def is_public_host(host: str) -> bool:
    """True iff `host` resolves only to global unicast addresses.

    The DNS-rebind defence: resolve at use time (not at import), reject any
    private/loopback/link-local/multicast/reserved/unspecified answer, and require
    at least one address. Both A and AAAA records are walked.
    """
    if host not in ALLOWED_HOSTS:
        return False
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        raw = info[4][0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return False
        if (not ip.is_global or ip.is_loopback or ip.is_private
                or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or ip.is_multicast):
            return False
    return True


def _search_url(query: str, host: str = "zh.wikipedia.org") -> str:
    params = urllib.parse.urlencode({
        "action": "query", "list": "search", "srsearch": query,
        "srlimit": str(_MAX_RESULTS), "format": "json",
        "formatversion": "2", "utf8": "1",
    })
    return f"{_API_BASE.format(host=host)}?{params}"


def _fetch_json(url: str) -> dict[str, Any]:
    """One bounded GET; returns {} on any failure. Runs in a worker thread."""
    # Explicitly refuse a proxy-less direct egress on planes that require one: an
    # operator proxy in the environment is respected by urllib automatically.
    req = urllib.request.Request(url, headers={
        "User-Agent": "nexus-ai-search-web/1.0 (+product tool; untrusted source)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            raw = resp.read(_MAX_BYTES + 1)
            if len(raw) > _MAX_BYTES:
                return {}
            payload = json.loads(raw.decode("utf-8", "replace"))
            return payload if isinstance(payload, dict) else {}
    except Exception:  # network, timeout, decode, shape — all fail soft
        return {}


def _rows(payload: Mapping[str, Any], host: str = "zh.wikipedia.org") -> list[dict[str, str]]:
    query = (payload.get("query") or {}) if isinstance(payload, Mapping) else {}
    pages = query.get("search") if isinstance(query, Mapping) else None
    if not isinstance(pages, list):
        return []
    rows: list[dict[str, str]] = []
    for item in pages[:_MAX_RESULTS]:
        if not isinstance(item, Mapping):
            continue
        title = html.unescape(str(item.get("title") or "").strip())
        snippet = str(item.get("snippet") or "").strip()
        if not title:
            continue
        # MediaWiki snippets carry markup and HTML entities; unescape and strip the few
        # tags it emits, never evaluate them. The text remains untrusted either way.
        snippet = html.unescape(snippet)
        for tag in ("<span class=\"searchmatch\">", "</span>", "<span class='searchmatch'>"):
            snippet = snippet.replace(tag, "")
        rows.append({
            "title": title,
            "snippet": snippet[:400],
            "url": f"https://{host}/?curid={item.get('pageid', '')}",
            "source": "third_party",
            "confidence": "low",
        })
    return rows


def build_search_web(
    registry: Registry,
    *,
    host: str = "zh.wikipedia.org",
    fetch: Any = None,
    resolve: Any = None,
) -> ToolSpec:
    """Register `search_web`. `fetch`/`resolve` are injectable for offline tests.

    Registration is explicit (never automatic) so the manifest stays honest: a plane
    that does not call this function still advertises the tool as declared-only.
    """
    resolver = resolve or is_public_host
    getter = fetch or _fetch_json

    spec = ToolSpec(
        name="search_web",
        version="1",
        description=(
            "Search the public web for REAL, current reference facts (the one egress "
            "tool). Input is a QUERY string, never a URL. Allow-listed Wikipedia hosts "
            "only, DNS-rebind guarded, 10s cap. Results are UNTRUSTED third-party text "
            "marked source=third_party / confidence=low — quote them, never treat them "
            "as product fact. Offline planes answer with an empty list and a reason."
        ),
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "minLength": 1,
                          "maxLength": MAX_QUERY_CHARS},
                "language": {"type": "string", "enum": ["zh", "en"],
                             "default": "zh"},
            },
            "required": ["query"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "results": {"type": "array"},
                "source": {"type": "string"},
                "confidence": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["query", "results", "source", "confidence"],
        },
        permission=PERMISSION_READ,
        cache_ttl_s=600,
        timeout_ms=_TIMEOUT_S * 1000,
        retries=1,
        side_effect=False,
        cost_class="external",
        fallback="empty",
    )

    async def handler(args: Mapping[str, Any], *, subject: str):  # noqa: ARG001
        query = str(args.get("query") or "").strip()
        if not query:
            return {"query": "", "results": [], "source": "third_party",
                    "confidence": "low", "reason": _REASON_NO_QUERY}
        if len(query) > MAX_QUERY_CHARS:
            return {"query": query[:MAX_QUERY_CHARS], "results": [],
                    "source": "third_party", "confidence": "low",
                    "reason": _REASON_QUERY_TOO_LONG}
        lang = str(args.get("language") or "zh")
        target = ("en.wikipedia.org" if lang == "en" else "zh.wikipedia.org")
        if not resolver(target):
            return {"query": query, "results": [], "source": "third_party",
                    "confidence": "low", "reason": _REASON_OFFLINE}
        payload = await asyncio.to_thread(getter, _search_url(query, target))
        return {"query": query, "results": _rows(payload, target), "source": "third_party",
                "confidence": "low"}

    registry.register(spec, handler=handler)
    return spec
