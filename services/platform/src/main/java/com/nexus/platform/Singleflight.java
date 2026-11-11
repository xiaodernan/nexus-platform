package com.nexus.platform;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * D944 — a singleflight / request-coalescing primitive: collapse N concurrent misses for the SAME key
 * into ONE load, so a cold key cannot stampede the backing store (cache penetration / thundering herd).
 *
 * <p>The defect it closes is the "check-then-load" window. A typical bounded cache does
 * {@code synchronized(cache) { hit? }} then RELEASES the lock, calls the loader (a DB query), and only
 * afterwards re-locks to put the result. That lock protects the cache MAP, not the LOAD: N concurrent
 * callers all miss, all leave the lock, and all N run the same query against the same cold key before any
 * of them can populate the entry. D933's {@code ApiKeyService.verify} LRU has exactly this shape on the
 * pre-auth hot path — the LRU remembers a finished answer, but does nothing about the N in-flight misses.
 *
 * <p>This primitive is a pure, reusable, in-process coalescer — no Spring, no Redis, no clock. It is NOT a
 * cache: it stores nothing after the call returns. Its single job is to make concurrent callers for one key
 * share a single {@link Supplier} execution while it is in flight. Callers layer it over whatever cache they
 * already have. It is opt-in; a deployment that never calls it is unaffected.
 *
 * <p><b>Why not {@code ConcurrentHashMap.computeIfAbsent(key, k -> loader.get())}?</b> Two reasons, both
 * correctness: (1) if the loader throws, computeIfAbsent stores nothing and the exception propagates to only
 * the calling thread — there is no shared future for peers to join, so peers are not woken and do not see the
 * failure; (2) the mapping function runs INSIDE the map's per-bin lock, so a slow DB query blocks every other
 * key that hashes into the same bin (head-of-line blocking). Here the loader runs OUTSIDE any map lock, on the
 * owning caller's thread; peers wait on a {@link CompletableFuture}, not on a CHM bin.
 *
 * <p><b>Algorithm (no TOCTOU).</b> For each call, create a fresh future and atomically {@code putIfAbsent} it
 * under the key. If our future was installed, WE own the load: run the supplier, then {@code complete} or
 * {@code completeExceptionally} the future, and ALWAYS remove it in a {@code finally} using the
 * {@code remove(key, future)} overload so a late owner cannot delete a newer in-flight future for the same
 * key. If someone else's future was already there, we are a follower: {@code join()} it and share its result
 * or its exception. {@code putIfAbsent} is atomic, so exactly one owner is elected — there is no interval in
 * which two callers both believe they own the load.
 *
 * <p><b>Failure semantics (load-bearing).</b> If the supplier throws, the owner completes the shared future
 * exceptionally; every follower's {@code join()} throws, so ALL concurrent callers observe the failure (none
 * silently receives a value from a half-finished load). The {@code finally} removal happens on the failure
 * path too, so the NEXT request after a failed load starts a fresh attempt instead of joining a dead future
 * forever. The exception is surfaced as an unchecked {@link CompletionException} whose cause is the original
 * throwable; the original type/message are preserved. This is the property the wire falsifier attacks by
 * removing the in-flight coalescing: N threads then each run the loader N times.
 *
 * <p><b>Not claimed:</b> cross-process / cross-node coalescing (the in-flight table is per-JVM — a distributed
 * lock is a different mechanism); that callers' values are cached (this is not a cache); any latency or
 * throughput number (no benchmark); and no guarantee about WHICH of the N callers becomes the owner (only
 * that exactly one does). A loader that blocks forever blocks its followers too — that is inherent to
 * coalescing and is why callers may wrap the returned call in their own timeout.
 */
public final class Singleflight<K, V> {

    private final Map<K, CompletableFuture<V>> inflight = new ConcurrentHashMap<>();

    /**
     * Return the value for {@code key}, running {@code loader} at most once across all concurrent callers
     * for that key. Null keys are rejected (the in-flight map cannot hold them; callers wanting a null-like
     * key should use a sentinel). A null loader result is a valid value and is shared with all followers.
     *
     * @throws CompletionException wrapping the loader's throwable, thrown on this and every joined caller's
     *                              thread when the single load fails
     */
    public V run(K key, Supplier<? extends V> loader) {
        if (key == null) {
            throw new IllegalArgumentException("singleflight key must not be null");
        }
        CompletableFuture<V> fresh = new CompletableFuture<>();
        CompletableFuture<V> mine = inflight.putIfAbsent(key, fresh);
        if (mine == null) {
            // I won the atomic race — I am the sole owner of this load.
            mine = fresh;
            try {
                mine.complete(loader.get());
            } catch (Throwable t) {
                mine.completeExceptionally(t);
            } finally {
                // remove(key, value) is conditional: a slow owner cannot delete a NEWER future that a later
                // request installed after this one already completed. This closes the clear-vs-reuse race.
                inflight.remove(key, mine);
            }
        }
        // Owner or follower, everyone joins the SAME future. join() rethrows the loader's failure (wrapped)
        // on every caller, so "one load failed" is never mistaken for "one caller's value is ready".
        return mine.join();
    }

    /** Number of keys currently being loaded — exposed for observability and the concurrency test. */
    int inFlightCount() {
        return inflight.size();
    }
}
