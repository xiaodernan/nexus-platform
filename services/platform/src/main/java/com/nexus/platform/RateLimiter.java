package com.nexus.platform;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Fixed-window limiter over {@link KeyValueStore}. Contract §1: {@code 429} + {@code Retry-After} +
 * {@code X-RateLimit-Remaining}.
 */
@Component
public class RateLimiter {

    public record Outcome(boolean allowed, long remaining, long retryAfterSeconds, long limit) {
    }

    private final KeyValueStore store;
    private final boolean enabled;

    public RateLimiter(KeyValueStore store, @Value("${nexus.ratelimit.enabled:true}") boolean enabled) {
        this.store = store;
        this.enabled = enabled;
    }

    public Outcome check(String scope, String principal, int limit, Duration window) {
        if (!enabled || limit <= 0) {
            return new Outcome(true, limit, 0, limit);
        }
        String key = "nexus:rl:" + scope + ":" + principal;
        long count = store.increment(key, window);
        long remaining = Math.max(0, limit - count);
        if (count > limit) {
            long ttl = store.remainingTtlSeconds(key);
            return new Outcome(false, 0, Math.max(1, ttl), limit);
        }
        return new Outcome(true, remaining, 0, limit);
    }

    public void require(String scope, String principal, int limit, Duration window) {
        Outcome out = check(scope, principal, limit, window);
        if (!out.allowed()) {
            throw ApiException.rateLimited("Too many requests for " + scope, out.retryAfterSeconds());
        }
    }
}
