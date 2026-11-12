"""D972 — the AI tool-result cache's expiry heap stayed bounded by the cap, not by write count.

D903 bounded `_Cache._store` to an LRU of `max_entries`; D913 added an expiry min-heap for
amortized O(log n) sweeping. But `set` pushed one heap tuple per write while LRU eviction
(`popitem`) and overwrites left those tuples in the heap — heapq has no O(log n) arbitrary
delete — so stale tuples only left when their TTL popped them, which never happens while the
clock is frozen. Measured: cap=8, 2000 distinct-arg writes -> store=8 but heap=2000 (250x);
overwrite one key 500x -> heap=500. This contradicts D903's own promise that "both memory and
the sweep cost are bounded by the cap rather than by the number of distinct args seen", and the
shipped D903 door only asserted `len(cache._store) <= 8` — it never looked at the heap.

D972 bounds the heap by a constant multiple of the cap while preserving D913's amortized cost:
a generation `seq` + `_heap_token` mark exactly one LIVE tuple per key, and `set` rebuilds the
heap from live tuples (compaction) once its length passes `factor * max_entries + 1`. Compaction
is O(len(heap)) once per O(cap) writes, so the amortized per-write cost stays O(log n); the heap
is now O(cap). No TTL, LRU, overwrite or expired-sweep semantics change.

The falsifier flips exactly one variable: disable `_compact_heap` (monkeypatch it to a no-op)
and the positive arm's bounded-heap assertion must REDDEN as the heap returns to write-count
growth. All clocks are fake; no Redis, DB, network or JVM is involved.
"""

from __future__ import annotations

from nexus_ai.tools.registry import _MISS, _Cache, ToolSpec

CAP = 8
WRITES = 2000
BOUND = 2 * CAP + 1  # _compact_factor (2) * max_entries + 1


def _spec(ttl: int = 300) -> ToolSpec:
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


def test_heap_stays_bounded_under_distinct_arg_churn():
    """Positive: the heap and token index are O(cap) even after far more writes than the cap."""
    clock = _Clock()
    cache = _Cache(clock, max_entries=CAP)
    spec = _spec()
    for i in range(WRITES):
        _put(cache, spec, i)
    assert len(cache._store) <= CAP
    assert len(cache._expiry_heap) <= BOUND, (
        f"the expiry heap grew to {len(cache._expiry_heap)} on {WRITES} writes with cap={CAP}; "
        "stale tuples from LRU eviction are not being compacted"
    )
    # The token index has exactly one live entry per stored key — no leaked tokens.
    assert len(cache._heap_token) == len(cache._store)
    assert set(cache._heap_token) == set(cache._store)
    # LRU semantics are intact under the churn: newest kept, eldest evicted.
    assert _get(cache, spec, WRITES - 1) == {"rows": [WRITES - 1]}
    assert _get(cache, spec, 0) is _MISS


def test_compaction_disabled_is_the_one_variable_falsifier(monkeypatch):
    """Falsifier: neutralise compaction; the bounded-heap claim must REDDEN to write-count growth."""
    monkeypatch.setattr(_Cache, "_compact_heap", lambda self: None, raising=True)
    clock = _Clock()
    cache = _Cache(clock, max_entries=CAP)
    spec = _spec()
    for i in range(WRITES):
        _put(cache, spec, i)
    # With the single compaction variable flipped back off, the heap is again unbounded.
    assert len(cache._expiry_heap) > 100, (
        "disabling compaction did not restore write-count heap growth; the positive arm "
        "is vacuous — the bounded-heap claim is not actually carried by compaction"
    )
    assert len(cache._expiry_heap) == WRITES  # one stale/live tuple per push, none reclaimed


def test_overwrite_same_key_keeps_heap_bounded_and_value_fresh():
    """Overwriting one key 500x (identical expires) must not accumulate duplicate tuples."""
    clock = _Clock()  # frozen -> every write has the SAME expires; a store-only filter cannot dedupe
    cache = _Cache(clock, max_entries=CAP)
    spec = _spec()
    for i in range(500):
        _put_same(cache, spec, i)
    assert len(cache._store) == 1
    assert len(cache._heap_token) == 1
    assert len(cache._expiry_heap) <= BOUND
    ck = ("search_merchants", '{"query":"same"}')
    assert cache._store[ck][1] == {"rows": [499]}  # last write wins
    assert _get_same(cache, spec) == {"rows": [499]}


def test_generation_guards_a_fresh_value_when_a_stale_tuple_expires():
    """An overwritten key's old heap tuple must never delete the newer value on sweep."""
    clock = _Clock()
    cache = _Cache(clock, max_entries=CAP)
    spec = _spec(ttl=60)
    _put_same(cache, spec, 1)       # expires at t=60
    clock.t = 30.0
    _put_same(cache, spec, 2)       # overwrites, expires at t=90; old tuple still in heap
    clock.t = 60.0
    _put(cache, spec, 999)          # triggers sweep: old (t=60) tuple is now due
    # The stale tuple must be discarded, not delete the fresh value that expires at t=90.
    assert _get_same(cache, spec) == {"rows": [2]}
    clock.t = 90.0
    _put(cache, spec, 1000)         # sweep again: the t=90 tuple is now legitimately due
    assert _get_same(cache, spec) is _MISS


def test_expired_read_drops_the_live_token():
    """A TTL miss on read also releases the key's token, so the index cannot leak entries."""
    clock = _Clock()
    cache = _Cache(clock, max_entries=CAP)
    spec = _spec(ttl=10)
    _put(cache, spec, 1)
    assert len(cache._heap_token) == 1
    clock.t = 10.0
    assert _get(cache, spec, 1) is _MISS
    assert len(cache._store) == 0
    assert len(cache._heap_token) == 0  # token does not outlive the store entry
    assert len(cache._expiry_heap) <= BOUND


def test_ttl_and_lru_semantics_are_unchanged():
    """D903's four semantic guarantees still hold byte-for-byte after the heap fix."""
    clock = _Clock()
    cache = _Cache(clock, max_entries=4)
    spec = _spec(ttl=60)
    for i in range(4):
        _put(cache, spec, i)
    assert _get(cache, spec, 0) == {"rows": [0]}   # LRU touch
    _put(cache, spec, 4)                           # evicts q1, not q0
    assert _get(cache, spec, 0) == {"rows": [0]}
    assert _get(cache, spec, 1) is _MISS
    clock.t = 100.0
    _put(cache, spec, 99)                          # write-side sweep of expired entries
    assert len(cache._store) == 1
    assert _get(cache, spec, 99) == {"rows": [99]}


def _put_same(cache: _Cache, spec: ToolSpec, i: int) -> None:
    cache.set(spec=spec, arguments={"query": "same"}, value={"rows": [i]})


def _get_same(cache: _Cache, spec: ToolSpec):
    return cache.get(spec=spec, arguments={"query": "same"})
