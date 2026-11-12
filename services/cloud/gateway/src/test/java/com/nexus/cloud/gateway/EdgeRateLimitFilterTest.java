package com.nexus.cloud.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Mono;

/** D917 — the edge's bucket map evicts the coldest entry, never everything. */
class EdgeRateLimitFilterTest {

    @Test
    void theBucketMapEvictsTheLeastRecentlyUsedEntryBeyondTheCap() {
        Map<String, TokenBucket> buckets = EdgeRateLimitFilter.newBucketMap(2);
        buckets.computeIfAbsent("a", k -> new TokenBucket(10, 0));
        buckets.computeIfAbsent("b", k -> new TokenBucket(10, 0));
        buckets.get("a");                                     // touch a — a is now most recent
        buckets.computeIfAbsent("c", k -> new TokenBucket(10, 0)); // c evicts the LRU entry (b)
        assertThat(buckets).doesNotContainKey("b");
        assertThat(buckets).containsKey("a").containsKey("c");
    }

    @Test
    void theBucketMapNeverExceedsItsCapEvenUnderAnAlternatingKeyspace() {
        Map<String, TokenBucket> buckets = EdgeRateLimitFilter.newBucketMap(3);
        for (int i = 0; i < 64; i++) {
            buckets.computeIfAbsent("client-" + i, k -> new TokenBucket(10, 0));
        }
        assertThat(buckets.size()).isLessThanOrEqualTo(3);
        assertThat(buckets).containsKey("client-63");
    }

    @Test
    void aFloodOfCoolClientsDoesNotResetAnActiveClientsBucket() {
        Map<String, TokenBucket> buckets = EdgeRateLimitFilter.newBucketMap(4);
        // the active client is touched between every cool client, so it stays hot
        TokenBucket hot = buckets.computeIfAbsent("hot", k -> new TokenBucket(1, 0));
        assertThat(hot.tryAcquire()).isTrue();                 // the only token is consumed
        for (int i = 0; i < 10; i++) {
            buckets.get("hot");                               // keep hot alive between cold inserts
            buckets.computeIfAbsent("cool-" + i, k -> new TokenBucket(1, 0));
        }
        assertThat(buckets).containsKey("hot");               // never evicted under the old clear()
        assertThat(hot.tryAcquire()).isFalse();                // capacity consumed, not reset
    }

    /**
     * D987 — an admitted answer carries the IETF RateLimit triple: the client learns its budget, its
     * remainder and seconds-until-full without having to poke the 429. The refused answer says the same
     * triple with remaining=0 — a client pacing itself never has to invent its own clock.
     */
    @Test
    void anAdmittedAnswerCarriesLimitRemainingAndReset() {
        EdgeRateLimitFilter filter = new EdgeRateLimitFilter(2, 0);
        GatewayFilterChain chain = ex -> Mono.empty();
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/api/v1/health")
                        .remoteAddress(new InetSocketAddress("203.0.113.50", 12345)).build());

        filter.filter(exchange, chain).block();

        assertThat(exchange.getResponse().getHeaders().getFirst("X-RateLimit-Limit")).isEqualTo("2");
        assertThat(exchange.getResponse().getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("1");
        assertThat(exchange.getResponse().getHeaders().getFirst("X-RateLimit-Reset")).isEqualTo("0");
    }

    @Test
    void theRefusedAnswerCarriesZeroRemainingAndSecondsUntilFull() {
        EdgeRateLimitFilter filter = new EdgeRateLimitFilter(1, 1);
        GatewayFilterChain chain = ex -> Mono.empty();
        InetSocketAddress me = new InetSocketAddress("203.0.113.51", 12345);
        // First call takes the only token; second is refused.
        filter.filter(MockServerWebExchange.from(
                MockServerHttpRequest.get("/api/v1/lookup").remoteAddress(me).build()), chain).block();
        MockServerWebExchange refused = MockServerWebExchange.from(
                MockServerHttpRequest.get("/api/v1/lookup").remoteAddress(me).build());
        filter.filter(refused, chain).block();

        assertThat(refused.getResponse().getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(refused.getResponse().getHeaders().getFirst("Retry-After")).isEqualTo("1");
        assertThat(refused.getResponse().getHeaders().getFirst("X-RateLimit-Limit")).isEqualTo("1");
        assertThat(refused.getResponse().getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("0");
        assertThat(refused.getResponse().getHeaders().getFirst("X-RateLimit-Reset")).isEqualTo("1");
    }

    @Test
    void theActuatorExemptionSetsNoRateLimitHeadersAndPassesThrough() {
        EdgeRateLimitFilter filter = new EdgeRateLimitFilter(1, 0);
        AtomicBoolean called = new AtomicBoolean(false);
        GatewayFilterChain chain = ex -> { called.set(true); return Mono.empty(); };
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/actuator/health")
                        .remoteAddress(new InetSocketAddress("203.0.113.52", 12345)).build());

        filter.filter(exchange, chain).block();

        assertThat(called).isTrue();
        assertThat(exchange.getResponse().getHeaders().get("X-RateLimit-Limit")).isNull();
        assertThat(exchange.getResponse().getHeaders().get("X-RateLimit-Remaining")).isNull();
        assertThat(exchange.getResponse().getHeaders().get("X-RateLimit-Reset")).isNull();
    }
}
