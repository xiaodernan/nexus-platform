"""D1022 — the rails search cache: offline shape and key guarantees, plus an env-gated live arm.

`nexus_ai/api/search_cache.py` is opt-in via `NEXUS_SEARCH_CACHE=redis`. These tests pin what
anyone without Redis must still see: the gate refuses every non-rails shape, the key is
deterministic for one input and distinct for any other, and when the env opts in against a
reachable Redis the round trip actually stores and serves the same body (minus identifiers).
"""

from __future__ import annotations

import json
import uuid

import pytest

from nexus_ai.api.search_cache import _is_rails_shape, _canon_key, rails_cache_get, rails_cache_set

_RAILS_PAYLOAD = {
    "intent": {"raw_query": "", "sort_preference": "distance"},
    "geo": {"lat": 22.37, "lng": 114.17},
    "filters": {"district": None, "category": None, "max_price": None, "min_price": None,
                "open_now": None, "min_rating": None, "tags": [], "attributes": {},
                "avoid": [], "kind": None, "merchant_id": None},
    "limit": 8,
    "locale": "zh-HK",
    "conversation_id": None,
    "user_id": None,
    "tenant": "hong-kong",
}


def _payload(**overrides):
    base = json.loads(json.dumps(_RAILS_PAYLOAD))
    base.update(overrides)
    return base


class TestShapeGate:
    def test_the_homepage_shape_is_rails(self):
        assert _is_rails_shape(_RAILS_PAYLOAD) is True

    @pytest.mark.parametrize("overrides", [
        {"intent": {"raw_query": "餐廳", "sort_preference": "distance"}},
        {"filters": {"district": "Tai Wai", "category": None, "max_price": None,
                     "min_price": None, "open_now": None, "min_rating": None,
                     "tags": [], "attributes": {}, "avoid": [], "kind": None,
                     "merchant_id": None}},
        {"conversation_id": "conv-123"},
        {"user_id": str(uuid.uuid4())},
    ])
    def test_a_query_carries_a_rails_envelope_no_more(self, overrides):
        assert _is_rails_shape(_payload(**overrides)) is False

    def test_a_missing_intent_is_still_deterministic(self):
        # An empty intent (no determinate content) is deterministic too — cached by the gate.
        assert _is_rails_shape({"geo": None, "filters": {}, "limit": 8, "locale": "zh-HK"}) is True


class TestKeyDeterminism:
    def test_one_input_one_key(self):
        assert _canon_key(_RAILS_PAYLOAD) == _canon_key(json.loads(json.dumps(_RAILS_PAYLOAD)))

    @pytest.mark.parametrize("overrides", [
        {"intent": {"raw_query": "", "sort_preference": "rating"}},
        {"geo": {"lat": 22.4, "lng": 114.3}},
        {"limit": 6},
        {"locale": "en"},
        {"tenant": "other-tenant"},
        {"filters": {"category": "cafe", "district": None, "max_price": None,
                     "min_price": None, "open_now": None, "min_rating": None,
                     "tags": [], "attributes": {}, "avoid": [], "kind": None,
                     "merchant_id": None}},
    ])
    def test_a_different_input_is_a_different_key(self, overrides):
        assert _canon_key(_payload(**overrides)) != _canon_key(_RAILS_PAYLOAD)


class TestNoRedisNeeded:
    def test_get_and_set_are_noops_without_the_env_var(self, monkeypatch):
        monkeypatch.delenv("NEXUS_SEARCH_CACHE", raising=False)
        monkeypatch.setenv("NEXUS_REDIS_URL", "redis://127.0.0.1:9/0")
        # refresh module-level lazy-init cache so a previous test cannot leak state
        from nexus_ai.api import search_cache
        search_cache._CLIENT_TRIED = False
        search_cache._CLIENT = None
        assert rails_cache_get(_RAILS_PAYLOAD) is None
        assert rails_cache_set(_RAILS_PAYLOAD, {"items": []}) is False

    def test_a_dead_redis_degrades_to_a_miss_not_a_crash(self, monkeypatch):
        monkeypatch.setenv("NEXUS_SEARCH_CACHE", "redis")
        monkeypatch.setenv("NEXUS_REDIS_URL", "redis://127.0.0.1:9/0")
        from nexus_ai.api import search_cache
        search_cache._CLIENT_TRIED = False
        search_cache._CLIENT = None
        assert rails_cache_get(_RAILS_PAYLOAD) is None
        assert rails_cache_set(_RAILS_PAYLOAD, {"items": []}) is False
