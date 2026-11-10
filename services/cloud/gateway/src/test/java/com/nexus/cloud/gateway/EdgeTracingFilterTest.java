package com.nexus.cloud.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;

import reactor.core.publisher.Mono;

import com.nexus.cloud.gateway.EdgeTracingFilter.TraceContext;

/**
 * D884 — the trace context is the part that must never lie, so it is the part that gets the test,
 * without booting WebFlux (the same decision D850 made for TokenBucket).
 */
class EdgeTracingFilterTest {

    private static final String VALID =
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    private static final String TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

    @Test
    void validParentKeepsItsTraceButGetsANewSpan() {
        TraceContext parent = TraceContext.parse(VALID);
        assertThat(parent).isNotNull();
        assertThat(parent.traceId()).isEqualTo(TRACE);
        assertThat(parent.flags()).isEqualTo("01");

        TraceContext child = parent.child();
        assertThat(child.traceId()).isEqualTo(TRACE);
        assertThat(child.flags()).isEqualTo("01");
        assertThat(child.spanId()).isNotEqualTo(parent.spanId());
        assertThat(child.toHeader()).matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$");
    }

    @Test
    void malformedOrAllZeroContextsAreReplacedNotPropagated() {
        assertThat(TraceContext.parse(null)).isNull();
        assertThat(TraceContext.parse("")).isNull();
        assertThat(TraceContext.parse("not-a-traceparent")).isNull();
        assertThat(TraceContext.parse(VALID.toUpperCase())).isNull();       // W3C requires lowercase
        assertThat(TraceContext.parse(VALID + "-extra")).isNull();
        assertThat(TraceContext.parse("00-" + "0".repeat(32) + "-00f067aa0ba902b7-01")).isNull();
        assertThat(TraceContext.parse("00-" + TRACE + "-" + "0".repeat(16) + "-01")).isNull();
        assertThat(TraceContext.parse("01-" + TRACE + "-00f067aa0ba902b7-01")).isNull(); // version 01 unknown
    }

    @Test
    void freshContextIsSpecShapedAndNeverAllZero() {
        TraceContext fresh = TraceContext.fresh();
        assertThat(fresh.toHeader()).matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$");
        assertThat(fresh.traceId()).isNotEqualTo("0".repeat(32));
        assertThat(fresh.spanId()).isNotEqualTo("0".repeat(16));
        assertThat(TraceContext.parse(fresh.toHeader())).isNotNull();
    }

    @Test
    void theFilterInjectsATraceparentDownstreamAndEchoesBothIds() {
        AtomicReference<ServerWebExchange> seen = new AtomicReference<>();
        GatewayFilterChain chain = ex -> { seen.set(ex); return Mono.empty(); };
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/api/v1/health").build());

        new EdgeTracingFilter().filter(exchange, chain).block();

        ServerWebExchange delivered = seen.get();
        assertThat(delivered).isNotNull();
        String injected = delivered.getRequest().getHeaders().getFirst(EdgeTracingFilter.TRACEPARENT);
        assertThat(injected).matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$");
        TraceContext ctx = TraceContext.parse(injected);
        assertThat(delivered.getRequest().getHeaders().getFirst(EdgeTracingFilter.TRACE_ID_HEADER))
                .isEqualTo(ctx.traceId());
        assertThat(delivered.getResponse().getHeaders().getFirst(EdgeTracingFilter.TRACE_ID_HEADER))
                .isEqualTo(ctx.traceId());
        assertThat(delivered.getResponse().getHeaders().getFirst(EdgeTracingFilter.SPAN_ID_HEADER))
                .isEqualTo(ctx.spanId());
        // W3C propagates on requests only; the response must not pretend otherwise.
        assertThat(delivered.getResponse().getHeaders().containsKey(EdgeTracingFilter.TRACEPARENT)).isFalse();
    }

    @Test
    void anInboundContextIsContinuedNotRestarted() {
        AtomicReference<ServerWebExchange> seen = new AtomicReference<>();
        GatewayFilterChain chain = ex -> { seen.set(ex); return Mono.empty(); };
        MockServerWebExchange exchange = MockServerWebExchange.from(
                MockServerHttpRequest.get("/ai/v1/health")
                        .header(EdgeTracingFilter.TRACEPARENT, VALID).build());

        new EdgeTracingFilter().filter(exchange, chain).block();

        String injected = seen.get().getRequest().getHeaders().getFirst(EdgeTracingFilter.TRACEPARENT);
        TraceContext ctx = TraceContext.parse(injected);
        assertThat(ctx.traceId()).isEqualTo(TRACE);
        assertThat(ctx.spanId()).isNotEqualTo("00f067aa0ba902b7");
        assertThat(ctx.flags()).isEqualTo("01");
        assertThat(seen.get().getResponse().getHeaders().getFirst(EdgeTracingFilter.TRACE_ID_HEADER))
                .isEqualTo(TRACE);
    }

    @Test
    void itRunsImmediatelyAfterTheRequestIdFilter() {
        assertThat(new EdgeTracingFilter().getOrder())
                .isEqualTo(org.springframework.core.Ordered.HIGHEST_PRECEDENCE + 1);
    }
}
