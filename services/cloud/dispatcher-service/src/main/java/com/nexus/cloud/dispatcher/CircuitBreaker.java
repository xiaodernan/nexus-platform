package com.nexus.cloud.dispatcher;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/**
 * Per-hook circuit breaker in memory. The sidecar is expected to host a small number of hooks
 * (configured explicitly, never dynamic), so a {@link ConcurrentHashMap} per hook id is the right
 * shape — a fairness-free detector/tripper.
 *
 * States (closed / open / half-open) are represented as an atomic failure counter and a
 * half-open-epoch marker. The state machine deliberately does NOT hold a timer: the sweeper
 * checks monotonic millis on every delivery, and the openness check is pure read.
 *
 *   - Closed  — all failures counted, open on {@code >= threshold} consecutive failures.
 *   - Open    — refuses to send; a half-open probe is attempted when now >= openedAt + cooldown.
 *   - HalfOpen — one attempt is allowed to land; success closes the breaker, failure opens again.
 *
 * The counter resets on ANY success — a single recovery closes the breaker.
 */
@Component
public class CircuitBreaker {

    public enum Verdict { CLOSED, OPEN, HALF_OPEN }

    private static final long DEFAULT_COOLDOWN_MS = 30_000L;

    private final ConcurrentHashMap<String, State> hooks = new ConcurrentHashMap<>();
    private final long cooldownMs;
    private final long cooldownNanos;

    public CircuitBreaker() {
        this(DEFAULT_COOLDOWN_MS);
    }

    public CircuitBreaker(long cooldownMs) {
        this.cooldownMs = Math.max(0L, cooldownMs);
        this.cooldownNanos = this.cooldownMs * 1_000_000L;
    }

    /** True iff the hook is allowed to attempt a delivery right now. */
    public Verdict allow(String hookId) {
        State state = hooks.get(hookId);
        if (state == null) return Verdict.CLOSED;
        long failures = state.failures.get();
        if (failures == 0) return Verdict.CLOSED;
        if (failures >= state.threshold) {
            // Open: stay open until cooldown elapses; the next allow() is a HALF_OPEN probe.
            // nanoTime is the monotonic clock — wall clock can drift backward and re-open stale
            // breakers on cold boots; nanoTime cannot.
            long now = System.nanoTime();
            if (now - state.openedAtNanos >= cooldownNanos) {
                return Verdict.HALF_OPEN;
            }
            return Verdict.OPEN;
        }
        return Verdict.CLOSED;
    }

    public void registerSuccess(String hookId) {
        State state = hooks.get(hookId);
        if (state == null) return;
        state.failures.set(0);
    }

    public void registerFailure(String hookId, int threshold) {
        State state = hooks.computeIfAbsent(hookId, id -> new State(threshold));
        long failures = state.failures.incrementAndGet();
        state.threshold = threshold;
        if (failures >= threshold) {
            state.openedAtNanos = System.nanoTime();
        }
    }

    /** Snapshot for admin endpoints. */
    public Map<String, Map<String, Object>> snapshot() {
        Map<String, Map<String, Object>> out = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, State> entry : hooks.entrySet()) {
            State state = entry.getValue();
            out.put(entry.getKey(), Map.of(
                "consecutiveFailures", state.failures.get(),
                "threshold", state.threshold,
                "openedAtNanos", state.openedAtNanos,
                "state", state.failures.get() >= state.threshold ? "open" : "closed"
            ));
        }
        return out;
    }

    /** Test/probe seam: remove one hook's state. */
    public void forget(String hookId) { hooks.remove(hookId); }

    private static final class State {
        final AtomicLong failures = new AtomicLong(0);
        volatile long openedAtNanos;
        volatile int threshold;

        State(int threshold) { this.threshold = Math.max(1, threshold); }
    }
}
