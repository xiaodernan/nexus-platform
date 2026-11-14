package com.nexus.cloud.gateway;

import java.net.InetSocketAddress;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

import com.fasterxml.jackson.databind.ObjectMapper;

import reactor.core.publisher.Mono;

/**
 * The edge's per-client rate limit. Token bucket per remote address, env-tunable:
 * {@code NEXUS_GATEWAY_RATE_BURST} (default 10) is the bucket capacity, {@code NEXUS_GATEWAY_RATE_REPLENISH}
 * (default 5) is the sustained tokens/second with which it refills. Exceeding either gets a 429 with a
 * {@code Retry-After: 1} header and the same error shape the rest of the API contract uses; the
 * {@code X-Request-Id} minted by {@link EdgeRequestIdFilter} is already on the response by then, so a
 * rate-limited caller can still be correlated in the logs.
 *
 * Store selection (D1140): the bucket lives in the per-process map below by default, exactly as it
 * ever has. With {@code NEXUS_GATEWAY_RATE_STORE=redis} the decision is one atomic Redis EVAL against
 * {@code NEXUS_GATEWAY_RATE_PREFIX}{clientKey} instead — one budget shared by every gateway instance,
 * the same capacity/refill envs, and the same X-RateLimit triple on the wire plus an honest
 * {@code X-RateLimit-Store: redis}. If Redis errors or stalls past the 500ms timeout, the decision for
 * that request falls back to the LOCAL bucket (the edge is never unlimited and never hangs) and says
 * so with {@code X-RateLimit-Store: redis-fallback-local}. See {@link RedisTokenBucketLimiter} for the
 * honest boundaries; the per-process default remains the out-of-the-box behaviour.
 *
 * The bucket map is bounded: at {@code MAX_BUCKETS} distinct clients the oldest entries are dropped rather
 * than letting the map grow without limit.
 */
@Component
public class EdgeRateLimitFilter implements GlobalFilter, Ordered {

    private static final Logger LOG = LoggerFactory.getLogger(EdgeRateLimitFilter.class);

    /**
     * After {@link EdgeRequestIdFilter} (HIGHEST_PRECEDENCE) so even a 429 carries the correlation id. */
    public static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 10;

    private static final int MAX_BUCKETS = 10_000;

    /**
     * The token-bucket map. Access-order LRU bounded at {@code maxBuckets} — D917 closed the
     * "drop everything at the ceiling" defect the previous code had: a flood from 10 001+ distinct
     * client keys wiped EVERY legitimate client's bucket instead of evicting the least-recently-used
     * one, resetting the rate-limit for all real traffic to favour an attacker with a big keyspace.
     * Eviction keeps every client's bucket unless that client is the actual coldest entry.
     */
    private final Map<String, TokenBucket> buckets = newBucketMap(MAX_BUCKETS);

    static Map<String, TokenBucket> newBucketMap(int maxBuckets) {
        return Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, TokenBucket> eldest) {
                return size() > Math.max(1, maxBuckets);
            }
        });
    }
    private final long burst;
    private final long replenish;
    private final RedisTokenBucketLimiter redisLimiter;
    private final ObjectMapper mapper = new ObjectMapper();

    /**
     * The ONE wiring constructor. D1140: there is deliberately no two-arg twin — Spring 6 counts
     * parameter-annotated constructors as candidates, and a second candidate once decided the
     * election the wrong way (the Armed redis path never ran; the edge silently served its
     * per-process bucket). Unit tests pass {@code RedisTokenBucketLimiter.disabled()} explicitly.
     */
    @Autowired
    public EdgeRateLimitFilter(
            @Value("${nexus.edge.rate-limit-burst:${NEXUS_GATEWAY_RATE_BURST:10}}") long burst,
            @Value("${nexus.edge.rate-limit-replenish:${NEXUS_GATEWAY_RATE_REPLENISH:5}}") long replenish,
            RedisTokenBucketLimiter redisLimiter) {
        if (burst < 1 || replenish < 0) {
            throw new IllegalArgumentException("NEXUS_GATEWAY_RATE_BURST must be >= 1 and NEXUS_GATEWAY_RATE_REPLENISH >= 0");
        }
        this.burst = burst;
        this.replenish = replenish;
        this.redisLimiter = redisLimiter == null ? RedisTokenBucketLimiter.disabled() : redisLimiter;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        // Management surfaces stay exempt: a liveness/readiness probe must never be refused
        // by our own limiter (the smoke's health waits depend on it, and so do real
        // orchestrators under load).
        if (exchange.getRequest().getPath().value().startsWith("/actuator")) {
            return chain.filter(exchange);
        }
        String key = clientKey(exchange);
        if (redisLimiter.isEnabled()) {
            return redisLimiter.admit(key)
                    .timeout(redisLimiter.timeout())
                    .flatMap(adm -> adm.allowed()
                            ? admitted(exchange, chain, adm.remaining(), adm.resetSeconds(), "redis")
                            : tooManyRequests(exchange, adm.remaining(), adm.resetSeconds(), "redis"))
                    .onErrorResume(err -> {
                        // A broken Redis must never hang the edge or blanket-allow it: fall back to the
                        // per-process budget (fail-degraded, never fail-open), and say so on the wire.
                        LOG.warn("D1140 redis rate store failed for one client decision; falling back to the local bucket ({})", err.toString());
                        return applyLocal(exchange, chain, key, "redis-fallback-local");
                    });
        }
        return applyLocal(exchange, chain, key, "inmemory");
    }

    private Mono<Void> applyLocal(ServerWebExchange exchange, GatewayFilterChain chain, String key, String store) {
        TokenBucket bucket = buckets.computeIfAbsent(key, k -> new TokenBucket(burst, replenish));
        if (bucket.tryAcquire()) {
            // IETF RateLimit: limit, remaining and reset-seconds travel on EVERY allowed answer,
            // so a client can pace itself without probing the 429 — the refused answer says the same
            // thing with remaining=0. Not information disclosure: everything here is public policy, and
            // an orchestrator that wants to throttle this client needs it.
            return admitted(exchange, chain, bucket.remainingTokens(), bucket.secondsUntilFull(), store);
        }
        return tooManyRequests(exchange, 0, bucket.secondsUntilFull(), store);
    }

    private Mono<Void> admitted(ServerWebExchange exchange, GatewayFilterChain chain,
                                int remaining, int resetSeconds, String store) {
        exchange.getResponse().getHeaders().set("X-RateLimit-Limit", String.valueOf(burst));
        exchange.getResponse().getHeaders()
                .set("X-RateLimit-Remaining", String.valueOf(remaining));
        exchange.getResponse().getHeaders()
                .set("X-RateLimit-Reset", String.valueOf(resetSeconds));
        exchange.getResponse().getHeaders().set("X-RateLimit-Store", store);
        return chain.filter(exchange);
    }

    private static String clientKey(ServerWebExchange exchange) {
        InetSocketAddress remote = exchange.getRequest().getRemoteAddress();
        return remote != null && remote.getAddress() != null ? remote.getAddress().getHostAddress() : "unknown";
    }

    private Mono<Void> tooManyRequests(ServerWebExchange exchange, int remaining, int resetSeconds, String store) {
        exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        exchange.getResponse().getHeaders().set("Retry-After", "1");
        exchange.getResponse().getHeaders().set("X-RateLimit-Limit", String.valueOf(burst));
        exchange.getResponse().getHeaders().set("X-RateLimit-Remaining", String.valueOf(Math.max(0, remaining)));
        exchange.getResponse().getHeaders()
                .set("X-RateLimit-Reset", String.valueOf(resetSeconds));
        exchange.getResponse().getHeaders().set("X-RateLimit-Store", store);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        String requestId = exchange.getResponse().getHeaders().getFirst(EdgeRequestIdFilter.HEADER);
        Map<String, Object> error = Map.of(
                "error", Map.of(
                        "code", "edge_rate_limited",
                        "message", "Too many requests through the edge; slow down and retry in a second",
                        "request_id", requestId == null ? "unknown" : requestId));
        try {
            byte[] body = mapper.writeValueAsBytes(error);
            DataBuffer buffer = exchange.getResponse().bufferFactory().wrap(body);
            return exchange.getResponse().writeWith(Mono.just(buffer));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            // Unwritable body is not a reason to hang the client: an empty 429 is still a 429.
            return exchange.getResponse().setComplete();
        }
    }

    @Override
    public int getOrder() {
        return ORDER;
    }
}
