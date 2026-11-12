package com.nexus.cloud.gateway;

/**
 * The token bucket the edge rate limiter counts from. Deliberately a plain class with no framework
 * dependency: the arithmetic is the part worth testing, and a unit test should not need a WebFlux
 * context to reach it.
 *
 * One bucket per client key, refilled continuously at {@code refillPerSecond} tokens up to
 * {@code capacity}. {@link #tryAcquire()} costs exactly one token.
 */
public final class TokenBucket {

    private final double capacity;
    private final double refillPerSecond;
    private double tokens;
    private long lastRefillNanos;

    public TokenBucket(double capacity, double refillPerSecond) {
        if (capacity < 1 || refillPerSecond < 0) {
            throw new IllegalArgumentException("capacity must be >= 1 and refillPerSecond >= 0");
        }
        this.capacity = capacity;
        this.refillPerSecond = refillPerSecond;
        this.tokens = capacity;
        this.lastRefillNanos = System.nanoTime();
    }

    /** Tokens left after the last refill, floored. Never negative. */
    public synchronized int remainingTokens() {
        refill();
        return Math.max(0, (int) tokens);
    }

    /** Seconds until the bucket is full again; 0 when already full, or when refill is zero. */
    public synchronized int secondsUntilFull() {
        refill();
        double missing = capacity - tokens;
        if (missing <= 0 || refillPerSecond <= 0) {
            return 0;
        }
        return (int) Math.ceil(missing / refillPerSecond);
    }

    /** Refills for the elapsed time, then admits (and charges) one token if any remain. */
    public synchronized boolean tryAcquire() {
        refill();
        if (tokens >= 1.0) {
            tokens -= 1.0;
            return true;
        }
        return false;
    }

    private void refill() {
        long now = System.nanoTime();
        double elapsedSeconds = (now - lastRefillNanos) / 1_000_000_000.0;
        if (elapsedSeconds <= 0) {
            return;
        }
        tokens = Math.min(capacity, tokens + elapsedSeconds * refillPerSecond);
        lastRefillNanos = now;
    }
}
