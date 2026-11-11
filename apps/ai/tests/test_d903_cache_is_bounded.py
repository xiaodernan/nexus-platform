"""D903 - the AI tool-result cache is bounded, LRU-ordered, and sweeps expired entries.

AGENT_CONTRACT §3 / the optimization lane: `_Cache._store` was a plain dict. TTL was
checked on read, but nothing capped its size and nothing reclaimed expired entries, so a
long-lived process retained one entry per distinct argument dict forever (measured:
5000 distinct args -> 5000 retained, every one expired, none swept).

This door pins the bound directly on `_Cache` with a fake clock and a small cap:
  R1 the store never exceeds max_entries; the eldest is evicted, the newest kept;
  R2 a read makes an entry most-recent (LRU), so eviction takes the least-recently-used;
  R3 a write reclaims entries whose TTL has already passed, but keeps live ones;
  R4 TTL semantics are unchanged: a hit before expiry, a miss at/after the boundary.
"""
from __future__ import annotations

from nexus_ai.tools.registry import _MISS, _Cache, ToolSpec


def _spec(ttl: int = 60) -> ToolSpec:
    return ToolSpec(name="search_merchants", cache_ttl_s=ttl)


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _put(cache: _Cache, spec: ToolSpec, i: int) -> None:
    cache.set(spec=spec, arguments={"query": f"q{i}"}, value={"rows": [i]})


def _get(cache: _Cache, spec: ToolSpec, i: int):
    return cache.get(spec=spec, arguments={"query": f"q{i}"})


class TestCacheIsBounded:
    def test_r1_store_never_exceeds_the_bound(self):
        clock = _Clock()
        cache = _Cache(clock, max_entries=8)
        spec = _spec()
        for i in range(32):
            _put(cache, spec, i)
        assert len(cache._store) <= 8
        assert _get(cache, spec, 31) == {"rows": [31]}  # newest kept
        assert _get(cache, spec, 0) is _MISS            # eldest evicted

    def test_r2_a_read_makes_an_entry_most_recent(self):
        clock = _Clock()
        cache = _Cache(clock, max_entries=4)
        spec = _spec()
        for i in range(4):                              # q0 q1 q2 q3; q0 eldest
            _put(cache, spec, i)
        assert _get(cache, spec, 0) == {"rows": [0]}    # touch q0 -> most recent
        _put(cache, spec, 4)                            # evicts LRU = q1, not q0
        assert _get(cache, spec, 0) == {"rows": [0]}    # q0 survived the eviction
        assert _get(cache, spec, 1) is _MISS            # q1 was the least-recently-used
        assert _get(cache, spec, 4) == {"rows": [4]}

    def test_r3_a_write_reclaims_expired_but_keeps_live(self):
        clock = _Clock()
        cache = _Cache(clock, max_entries=64)
        spec = _spec(ttl=60)
        for i in range(10):                             # all expire at t=60
            _put(cache, spec, i)
        assert len(cache._store) == 10
        clock.t = 100.0                                 # q0..q9 now expired
        _put(cache, spec, 99)                           # fresh at t=100, expires t=160
        assert len(cache._store) == 1                   # the 10 expired swept, live kept
        assert _get(cache, spec, 99) == {"rows": [99]}
        assert _get(cache, spec, 0) is _MISS

    def test_r4_ttl_hit_then_miss_boundary_is_unchanged(self):
        clock = _Clock()
        cache = _Cache(clock, max_entries=8)
        spec = _spec(ttl=60)
        _put(cache, spec, 1)
        assert _get(cache, spec, 1) == {"rows": [1]}    # t=0 < 60 -> hit
        clock.t = 60.0
        assert _get(cache, spec, 1) is _MISS            # t=60 >= 60 -> miss (boundary)