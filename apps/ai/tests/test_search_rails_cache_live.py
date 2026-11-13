"""Live arm: when `NEXUS_SEARCH_CACHE=redis` is set against a reachable :6380, the rails cache
serves the same body twice and a fresh search sees the same cards. Opt-in only — CI never runs it.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
REDIS_URL = os.environ.get("NEXUS_REDIS_URL", "").strip()

pytestmark_skip = pytest.mark.skipif(
    os.environ.get("NEXUS_SEARCH_CACHE", "").strip().lower() != "redis"
    or not REDIS_URL
    or not DB_URL,
    reason="NEXUS_SEARCH_CACHE=redis + NEXUS_REDIS_URL + NEXUS_TEST_DATABASE_URL must all be set",
)


def _payload(sort: str) -> dict:
    return {
        "intent": {"raw_query": "", "sort_preference": sort, "language": "zh-HK"},
        "geo": {"lat": 22.37, "lng": 114.17},
        "filters": {},
        "limit": 4,
        "locale": "zh-HK",
    }


@pytestmark_skip
class TestRailsCacheLive:
    def test_a_repeated_sort_only_call_returns_the_same_body(self):
        from nexus_ai.api.app import app
        from nexus_ai.api import search_cache

        search_cache._CLIENT_TRIED = False
        search_cache._CLIENT = None
        client = TestClient(app)
        first = client.post("/ai/v1/search", json=_payload("trending")).json()
        second = client.post("/ai/v1/search", json=_payload("trending")).json()
        assert first["items"] == second["items"]
        assert first["total_estimate"] == second["total_estimate"]
        assert first["strategy"] == second["strategy"]
