package com.nexus.platform;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Limiter over {@link KeyValueStore}. Contract §1: {@code 429} + {@code Retry-After} +
 * {@code X-RateLimit-Remaining}.
 *
 * <p><b>D937 — sliding window is OPT-IN, default OFF.</b> The shipped behaviour is still D932's
 * fixed-window counter ({@code nexus.ratelimit.sliding-enabled=false}). Turning the flag on routes
 * {@link #check} through the Redis-ZSET sliding window added in {@link KeyValueStore#slidingWindow}, which
 * closes fixed-window's boundary burst: with limit N per W, fixed admits 2N across a boundary while sliding
 * never admits more than N in ANY W-wide interval. Both paths share the same key namespace and the same
 * {@link Outcome} contract, and both fall back to the bounded in-memory tier when Redis is absent.
 */
@Component
public class RateLimiter {

    public record Outcome(boolean allowed, long remaining, long retryAfterSeconds, long limit) {
    }

    private final KeyValueStore store;
    private final boolean enabled;
    private final boolean slidingEnabled;

    public RateLimiter(KeyValueStore store,
                       @Value("${nexus.ratelimit.enabled:true}") boolean enabled,
                       @Value("${nexus.ratelimit.sliding-enabled:false}") boolean slidingEnabled) {
        this.store = store;
        this.enabled = enabled;
        this.slidingEnabled = slidingEnabled;
    }

    public Outcome check(String scope, String principal, int limit, Duration window) {
        if (!enabled || limit <= 0) {
            return new Outcome(true, limit, 0, limit);
        }
        String key = "nexus:rl:" + scope + ":" + principal;
        long count = slidingEnabled
                ? store.slidingWindow(key, window.toMillis())
                : store.increment(key, window);
        long remaining = Math.max(0, limit - count);
        if (count > limit) {
            long ttl = store.remainingTtlSeconds(key);
            return new Outcome(false, 0, Math.max(1, ttl), limit);
        }
        return new Outcome(true, remaining, 0, limit);
    }

    public boolean usingSlidingWindow() {
        return slidingEnabled;
    }

    public void require(String scope, String principal, int limit, Duration window) {
        Outcome out = check(scope, principal, limit, window);
        if (!out.allowed()) {
            throw ApiException.rateLimited("Too many requests for " + scope, out.retryAfterSeconds());
        }
    }
}
