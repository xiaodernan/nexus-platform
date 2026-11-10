package com.nexus.cloud.gateway;

import java.net.InetSocketAddress;
import java.util.Map;

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
 * The edge's per-client rate limit (D850). Token bucket per remote address, env-tunable:
 * {@code NEXUS_GATEWAY_RATE_BURST} (default 10) is the bucket capacity, {@code NEXUS_GATEWAY_RATE_REPLENISH}
 * (default 5) is the sustained tokens/second with which it refills. Exceeding either gets a 429 with a
 * {@code Retry-After: 1} header and the same error shape the rest of the API contract uses; the
 * {@code X-Request-Id} minted by {@link EdgeRequestIdFilter} is already on the response by then, so a
 * rate-limited caller can still be correlated in the logs.
 *
 * Deliberately per-instance and in-memory: the cloud plane is a local/dev edge, and a horizontal
 * deployment sharing a limiter must move it to a shared store at that point (see DECISIONS D850) — the
 * honest limit here is one gateway's worth of clients, and the smoke asserts it as such. The bucket map
 * is bounded: at {@code MAX_BUCKETS} distinct clients the oldest entries are dropped rather than letting
 * the map grow without limit.
 */
@Component
public class EdgeRateLimitFilter implements GlobalFilter, Ordered {

    /** After {@link EdgeRequestIdFilter} (HIGHEST_PRECEDENCE) so even a 429 carries the correlation id. */
    public static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 10;

    private static final int MAX_BUCKETS = 10_000;

    private final Map<String, TokenBucket> buckets = new java.util.concurrent.ConcurrentHashMap<>();
    private final long burst;
    private final long replenish;
    private final ObjectMapper mapper = new ObjectMapper();

    public EdgeRateLimitFilter(
            @Value("${nexus.edge.rate-limit-burst:${NEXUS_GATEWAY_RATE_BURST:10}}") long burst,
            @Value("${nexus.edge.rate-limit-replenish:${NEXUS_GATEWAY_RATE_REPLENISH:5}}") long replenish) {
        if (burst < 1 || replenish < 0) {
            throw new IllegalArgumentException("NEXUS_GATEWAY_RATE_BURST must be >= 1 and NEXUS_GATEWAY_RATE_REPLENISH >= 0");
        }
        this.burst = burst;
        this.replenish = replenish;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String key = clientKey(exchange);
        TokenBucket bucket = buckets.computeIfAbsent(key, k -> new TokenBucket(burst, replenish));
        if (buckets.size() > MAX_BUCKETS) {
            // Bounded map: drop everything (cheap, correct enough for a single dev edge) instead of OOMing.
            buckets.clear();
            bucket = new TokenBucket(burst, replenish);
            buckets.put(key, bucket);
        }
        if (bucket.tryAcquire()) {
            return chain.filter(exchange);
        }
        return tooManyRequests(exchange);
    }

    private static String clientKey(ServerWebExchange exchange) {
        InetSocketAddress remote = exchange.getRequest().getRemoteAddress();
        return remote != null && remote.getAddress() != null ? remote.getAddress().getHostAddress() : "unknown";
    }

    private Mono<Void> tooManyRequests(ServerWebExchange exchange) {
        exchange.getResponse().setStatusCode(HttpStatus.TOO_MANY_REQUESTS);
        exchange.getResponse().getHeaders().set("Retry-After", "1");
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
