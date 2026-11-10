package com.nexus.cloud.gateway;

import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

import reactor.core.publisher.Mono;

/**
 * D884 — W3C trace-context propagation at the edge, in front of every route.
 *
 * <p>Before this filter the plane had only {@code X-Request-Id}: one opaque correlation string that
 * the edge mints and the platform echoes. That is enough to join two log lines but says nothing about
 * a trace/span tree, and a FastAPI service has no Spring instrumentation to inherit. This filter
 * makes the edge the one place that MINTS trace ids, and gives every downstream — Java or Python —
 * the same standard header to read:
 *
 * <pre>traceparent: 00-&lt;32 hex trace-id&gt;-&lt;16 hex span-id&gt;-&lt;2 hex flags&gt;</pre>
 *
 * <p>A valid incoming context keeps its trace-id and flags and gets a NEW span-id (this hop is a
 * child, not the caller's span). A missing, malformed, uppercase or all-zero context is replaced by a
 * fresh one rather than propagated as a lie. The response echoes {@code X-Trace-Id} and
 * {@code X-Trace-Span-Id} for a human debugging the plane; it deliberately does NOT echo
 * {@code traceparent}, because W3C propagates that header on REQUESTS only.
 *
 * <p>This is propagation, not export: there is no collector, no sampling decision beyond carrying
 * the caller's flags, and no claim that a span tree is stored anywhere. It runs at
 * {@code HIGHEST_PRECEDENCE + 1}, immediately after {@link EdgeRequestIdFilter}, so a gateway-local
 * answer (a 429 or a breaker fallback) still carries both ids.
 */
@Component
public class EdgeTracingFilter implements GlobalFilter, Ordered {

    public static final String TRACEPARENT = "traceparent";
    public static final String TRACE_ID_HEADER = "X-Trace-Id";
    public static final String SPAN_ID_HEADER = "X-Trace-Span-Id";

    /** W3C version 00 only; lowercase hex is REQUIRED by the specification. */
    private static final Pattern W3C = Pattern.compile(
            "^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$");
    private static final String ZERO_TRACE = "0".repeat(32);
    private static final String ZERO_SPAN = "0".repeat(16);

    /** An immutable, validated W3C context for one hop. */
    public static final class TraceContext {
        private final String traceId;
        private final String spanId;
        private final String flags;

        private TraceContext(String traceId, String spanId, String flags) {
            this.traceId = traceId;
            this.spanId = spanId;
            this.flags = flags;
        }

        /** Strict parse. Returns null for anything the W3C grammar or the all-zero rule rejects. */
        public static TraceContext parse(String header) {
            if (header == null) return null;
            Matcher m = W3C.matcher(header.trim());
            if (!m.matches()) return null;
            String trace = m.group(1);
            String span = m.group(2);
            if (ZERO_TRACE.equals(trace) || ZERO_SPAN.equals(span)) return null;
            return new TraceContext(trace, span, m.group(3));
        }

        /** A root context. The edge is the only component on this plane allowed to mint one. */
        public static TraceContext fresh() {
            return new TraceContext(hex(32), hex(16), "01");
        }

        /** A child hop: same trace and flags, new span id. */
        public TraceContext child() {
            return new TraceContext(traceId, hex(16), flags);
        }

        public String traceId() { return traceId; }
        public String spanId() { return spanId; }
        public String flags() { return flags; }

        public String toHeader() {
            return "00-" + traceId + "-" + spanId + "-" + flags;
        }
    }

    private static String hex(int length) {
        StringBuilder sb = new StringBuilder(length);
        while (sb.length() < length) {
            sb.append(UUID.randomUUID().toString().replace("-", ""));
        }
        return sb.substring(0, length).toLowerCase(Locale.ROOT);
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        TraceContext parent = TraceContext.parse(exchange.getRequest().getHeaders().getFirst(TRACEPARENT));
        TraceContext current = parent == null ? TraceContext.fresh() : parent.child();

        ServerHttpRequest request = exchange.getRequest().mutate()
                .header(TRACEPARENT, current.toHeader())
                .header(TRACE_ID_HEADER, current.traceId())
                .build();
        ServerWebExchange next = exchange.mutate().request(request).build();

        // Set before delegating: a limiter's 429, a breaker's 503 and a route miss all carry the id.
        next.getResponse().getHeaders().set(TRACE_ID_HEADER, current.traceId());
        next.getResponse().getHeaders().set(SPAN_ID_HEADER, current.spanId());
        return chain.filter(next);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 1;
    }
}
