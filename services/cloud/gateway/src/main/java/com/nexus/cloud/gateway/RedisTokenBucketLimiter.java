package com.nexus.cloud.gateway;

import java.time.Duration;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import io.lettuce.core.RedisURI;
import reactor.core.publisher.Mono;

/**
 * D1140 — the edge's token bucket, moved into Redis when the operator asks for it.
 *
 * Why this exists: the in-memory bucket in {@link EdgeRateLimitFilter} is per gateway process. Two
 * gateways behind one load balancer each admit their own {@code NEXUS_GATEWAY_RATE_BURST}, so a
 * horizontally deployed plane quietly serves DOUBLE the declared burst per client. That was fine
 * for the dev plane (D850) and honest as long as it said so; D1140 closes the seam with an
 * opt-in shared store — {@code NEXUS_GATEWAY_RATE_STORE=redis} — OFF by default, so nothing that
 * ships today changes behaviour.
 *
 * Semantics (identical to the in-memory bucket): token bucket with continuous refill.
 *   capacity         = {@code NEXUS_GATEWAY_RATE_BURST}     (same env as the local path)
 *   refill per sec   = {@code NEXUS_GATEWAY_RATE_REPLENISH} (same env as the local path)
 *   bucket key       = {@code NEXUS_GATEWAY_RATE_PREFIX}{clientKey} (default prefix {@code gw:ratelimit:})
 *
 * Atomicity: one {@code EVAL} round trip per admitted/refused decision. Redis executes scripts
 * single-threaded, so the read-modify-write of (tokens, ts) cannot interleave with another client's
 * — the same guarantee D932/D937 use for the platform's fixed/sliding windows. Two gateways, one
 * budget, no torn state.
 *
 * Clock: the CALLER passes wall-clock milliseconds (System.currentTimeMillis) rather than Redis
 * TIME, matching the ZSET smoke discipline — the smoke injects an exact clock, and production
 * accepts at most clock-skew across the (very short) refill computation between the two gateways.
 *
 * Degradation, honest: if Redis is unreachable, slow, or answers with garbage, the Mono errors or
 * the 500ms timeout fires and the FILTER falls back to its local bucket for that decision (never
 * unlimited, never a hung edge). The fallback is signalled on every response as
 * {@code X-RateLimit-Store: redis-fallback-local} — a silent fail-open would be lying about the
 * enforcement posture that is actually in force.
 *
 * What is NOT claimed: no persistence across flushes (the key carries a bounded TTL instead), no
 * cluster support (single-node standalone), no sizing memory (the TTL bounds it, one hash per key),
 * and no throughput number — the live proof is the two-gateway smoke, not a benchmark.
 */
@Component
public class RedisTokenBucketLimiter {

    /** Public so the smoke and the census can name the exact script; never re-declared elsewhere. */
    public static final String TOKEN_BUCKET_LUA =
            "local entry  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')\n"
                    + "local capacity = tonumber(ARGV[1])\n"
                    + "local refill   = tonumber(ARGV[2])\n"
                    + "local now      = tonumber(ARGV[3])\n"
                    + "local ttl      = tonumber(ARGV[4])\n"
                    + "local tokens   = tonumber(entry[1])\n"
                    + "local ts       = tonumber(entry[2])\n"
                    + "if tokens == nil then tokens = capacity end\n"
                    + "if ts == nil then ts = now end\n"
                    + "local delta = math.max(0, (now - ts) / 1000)\n"
                    + "tokens = math.min(capacity, tokens + delta * refill)\n"
                    + "local allowed = 0\n"
                    + "if tokens >= 1 then allowed = 1 tokens = tokens - 1 end\n"
                    + "redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))\n"
                    + "redis.call('PEXPIRE', KEYS[1], tostring(math.floor(ttl)))\n"
                    + "return { allowed, math.floor(tokens) }\n";

    /** One decision, already paid for. Immutable. */
    public record Admission(boolean allowed, int remaining, int resetSeconds) { }

    private static final Logger LOG = LoggerFactory.getLogger(RedisTokenBucketLimiter.class);

    private static String safeUri(String uri) {
        if (uri == null) { return "<null>"; }
        int at = uri.indexOf('@');
        if (at < 0) { return uri; }
        int scheme = uri.indexOf("://");
        return uri.substring(0, scheme < 0 ? at : scheme + 3) + "***@" + uri.substring(at + 1);
    }

    private static final int TIMEOUT_MS = 500;

    private final boolean enabled;
    private final long burst;
    private final long replenish;
    private final String prefix;
    private final ReactiveStringRedisTemplate redis;
    private final DefaultRedisScript<List> script;

    public RedisTokenBucketLimiter(
            @Value("${nexus.edge.rate-limit-store:${NEXUS_GATEWAY_RATE_STORE:inmemory}}") String store,
            @Value("${nexus.edge.rate-limit-prefix:${NEXUS_GATEWAY_RATE_PREFIX:gw:ratelimit:}}") String prefix,
            @Value("${nexus.edge.rate-limit-burst:${NEXUS_GATEWAY_RATE_BURST:10}}") long burst,
            @Value("${nexus.edge.rate-limit-replenish:${NEXUS_GATEWAY_RATE_REPLENISH:5}}") long replenish,
            @Value("${nexus.edge.redis-uri:${NEXUS_REDIS_URI:redis://127.0.0.1:6380/0}}") String redisUri) {
        boolean wantsRedis = "redis".equalsIgnoreCase(store == null ? "" : store.trim());
        if (!wantsRedis) {
            this.enabled = false;
            this.burst = Math.max(1, burst);
            this.replenish = Math.max(0, replenish);
            this.prefix = prefix;
            this.redis = null;
            this.script = null;
            LOG.info("D1140 rate-limit store: inmemory (default) — store value seen by the bean: {}", store);
            return;
        }
        LOG.info("D1140 rate-limit store: ARMED redis (uri={}, prefix={}, burst={}, replenish={})",
                safeUri(redisUri), prefix, burst, replenish);
        if (burst < 1 || replenish < 0) {
            throw new IllegalArgumentException("NEXUS_GATEWAY_RATE_BURST must be >= 1 and NEXUS_GATEWAY_RATE_REPLENISH >= 0");
        }
        if (!StringUtils.hasText(redisUri)) {
            throw new IllegalArgumentException("NEXUS_REDIS_URI must be set when NEXUS_GATEWAY_RATE_STORE=redis");
        }
        this.enabled = true;
        this.burst = burst;
        this.replenish = replenish;
        this.prefix = prefix == null || prefix.isEmpty() ? "gw:ratelimit:" : prefix;
        RedisURI uri = RedisURI.create(redisUri.trim());
        RedisStandaloneConfiguration standalone = new RedisStandaloneConfiguration(uri.getHost(), uri.getPort());
        standalone.setDatabase(uri.getDatabase());
        LettuceConnectionFactory factory = new LettuceConnectionFactory(standalone);
        factory.afterPropertiesSet();
        this.redis = new ReactiveStringRedisTemplate(factory);
        this.script = new DefaultRedisScript<>(TOKEN_BUCKET_LUA, List.class);
        // Cold-start warm-up: one throwaway PING so the first real admit does not spend the 500ms
        // timeout budget on the Lettuce connect. Never fails the boot — if Redis is down here,
        // the per-request fallback (redis-fallback-local) carries the plane honestly instead.
        try {
            // Warm through the SAME EVAL machinery admit() uses — flags every broken piece of the
            // pipeline here instead of on the first real request (500ms budget then stays pure EVAL).
            DefaultRedisScript<List> warm = new DefaultRedisScript<>("return 1", List.class);
            this.redis.execute(warm, List.of(prefix + "d1140_warm"), List.<String>of()).next().block(Duration.ofSeconds(2));
            LOG.info("D1140 rate-limit store: redis reachable (warm-up EVAL answered)");
        } catch (Exception e) {
            LOG.warn("D1140 rate-limit store: ARMED but unreachable at boot ({}) — requests will degrade to the local bucket (redis-fallback-local) until it answers", e.toString());
        }
    }

    /** The disabled twin the unit tests use — routes through THE one constructor (store=inmemory). */
    public static RedisTokenBucketLimiter disabled() {
        return new RedisTokenBucketLimiter("inmemory", "gw:ratelimit:", 1, 0, "redis://127.0.0.1:6380/0");
    }

    public boolean isEnabled() {
        return enabled;
    }

    public long burst() {
        return burst;
    }

    public long replenishPerSecond() {
        return replenish;
    }

    public Duration timeout() {
        return Duration.ofMillis(TIMEOUT_MS);
    }

    public String prefix() {
        return prefix;
    }

    /**
     * One atomic admit against the shared bucket. The caller must apply
     * {@code timeout(timeout())} and {@code onErrorResume(...)} — this method does NOT swallow
     * Redis failures itself, because the fallback decision (budget policy vs. fail-closed) is the
     * filter's to make, and a hung edge is never acceptable.
     */
    @SuppressWarnings({"rawtypes", "unchecked"})
    public Mono<Admission> admit(String clientKey) {
        if (!enabled) {
            return Mono.error(new IllegalStateException("redis store disabled"));
        }
        String key = prefix + clientKey;
        long now = System.currentTimeMillis();
        long ttl = replenish > 0
                ? (long) Math.ceil(burst / (double) replenish * 1000.0) + 1000L
                : 86_400_000L; // leaky-bucket with no refill: remember the drain for a day
        Mono<List> decision = redis.execute(
                script,
                List.of(key),
                List.of(String.valueOf(burst), String.valueOf(replenish), String.valueOf(now), String.valueOf(ttl)))
                .next();
        return decision.map(reply -> {
            List<?> parts = reply;
            if (parts == null || parts.size() < 2) {
                throw new IllegalStateException("redis bucket returned a malformed reply");
            }
            long allowed = ((Number) parts.get(0)).longValue();
            long remaining = Math.max(0, ((Number) parts.get(1)).longValue());
            int reset = replenish > 0
                    ? (int) Math.ceil((burst - remaining) / (double) replenish)
                    : (allowed == 1 ? 0 : 1);
            return new Admission(allowed == 1, (int) remaining, Math.max(0, reset));
        });
    }

}
