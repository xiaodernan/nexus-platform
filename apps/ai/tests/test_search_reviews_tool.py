"""D921 — the seventh tool dispatches: `search_reviews`.

AGENT_CONTRACT §3: `search_reviews` is now implemented the way the six before it were —
against the live backend seam, behind the §3 registry's permission + schema + cache pipeline.
These tests pin the registration shape, the passthrough contract, and the input contract.
"""

from __future__ import annotations

import asyncio

import pytest
from nexus_ai.tools.builtin import build_search_reviews, register_read_tools
from nexus_ai.tools.registry import InvalidArguments, PERMISSION_READ, Registry

ROWS = [
    {
        "review_id": "r-001",
        "merchant_id": "m-001",
        "rating": 5.0,
        "title": "Best fish ball shop in Sha Tin",
        "body": "Queue is long but everything is fresh.",
        "helpful_count": 42,
        "verified_purchase": True,
    },
    {
        "review_id": "r-002",
        "merchant_id": "m-001",
        "rating": 4.0,
        "title": "Reliable lunch spot",
        "body": "Solid value, nothing flashy.",
        "helpful_count": 7,
        "verified_purchase": True,
    },
]


class _FakeBackend:
    name = "fake"

    def __init__(self, reviews):
        self._reviews = reviews
        self.calls = 0

    async def reviews(self, merchant_ids, per_merchant=5):
        self.calls += 1
        return list(self._reviews)[:per_merchant]


def _dispatch(backend):
    registry = Registry(permissions=lambda _s: {PERMISSION_READ})
    build_search_reviews(registry, backend, None)
    return registry


def test_search_reviews_returns_exactly_the_backend_rows():
    backend = _FakeBackend(ROWS)
    registry = _dispatch(backend)
    out = asyncio.run(registry.dispatch(subject="u1", tool="search_reviews",
                                        arguments={"merchant_id": "m-001"}))
    assert out["merchant_id"] == "m-001"
    assert out["total"] == 2
    assert [r["review_id"] for r in out["reviews"]] == ["r-001", "r-002"]
    assert out["reviews"][0]["helpful_count"] == 42


def test_search_reviews_passthrough_order_and_limit_are_honored():
    backend = _FakeBackend(ROWS + ROWS)  # 4 rows, limit 2
    registry = _dispatch(backend)
    out = asyncio.run(registry.dispatch(subject="u1", tool="search_reviews",
                                        arguments={"merchant_id": "m-001", "limit": 2}))
    assert len(out["reviews"]) == 2
    assert out["total"] == 2
    assert backend.calls == 1  # the dispatch read the backend once, by contract


def test_search_reviews_requires_merchant_id():
    backend = _FakeBackend(ROWS)
    registry = _dispatch(backend)
    with pytest.raises(InvalidArguments):
        asyncio.run(registry.dispatch(subject="u1", tool="search_reviews",
                                      arguments={}))
    with pytest.raises(InvalidArguments):
        asyncio.run(registry.dispatch(subject="u1", tool="search_reviews",
                                      arguments={"merchant_id": ""}))


def test_search_reviews_rejects_unknown_arguments():
    backend = _FakeBackend(ROWS)
    registry = _dispatch(backend)
    with pytest.raises(InvalidArguments):
        asyncio.run(registry.dispatch(subject="u1", tool="search_reviews",
                                      arguments={"merchant_id": "m-001", "bogus": "x"}))


def test_register_read_tools_now_registers_seven():
    from nexus_ai.api.demo_data import demo_backend
    from nexus_ai.tools.names import CANONICAL_TOOL_NAMES

    backend = demo_backend()
    registry = register_read_tools(Registry(permissions=lambda _s: {PERMISSION_READ}), backend)
    live = {name for name in CANONICAL_TOOL_NAMES if registry.spec(name) is not None}
    assert live == {"get_business_hours", "get_price", "get_user_preferences",
                    "search_merchants", "search_services", "search_products",
                    "search_reviews"}
    assert registry.spec("search_reviews").cache_ttl_s == 300


def test_no_invented_merchant_error_when_none_match():
    backend = _FakeBackend([])
    registry = _dispatch(backend)
    out = asyncio.run(registry.dispatch(subject="u1", tool="search_reviews",
                                        arguments={"merchant_id": "ghost-merchant"}))
    assert out == {"merchant_id": "ghost-merchant", "reviews": [], "total": 0}
