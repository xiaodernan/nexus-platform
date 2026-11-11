package com.nexus.cloud.insight;

import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;

import feign.RequestInterceptor;
import feign.RequestTemplate;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * D900 (Phase H / H1) — the fifth service joins D884's W3C trace plane as a PARTICIPANT.
 *
 * <p>D884 made the gateway the plane's only trace-id ORIGIN and the FastAPI service a participant.
 * `nexus-insight` was still trace-blind, which is the more surprising gap: it is the one component
 * that actually CALLS two other services through `lb://`. This class closes that seam with two
 * small pieces: a servlet filter that parses a STRICT version-00 `traceparent`, mints a NEW
 * child span-id, echoes `X-Trace-Id` / `X-Trace-Span-Id` on the response; and a Feign
 * {@link RequestInterceptor} that copies the same context onto every declarative call.
 *
 * <p><strong>The context travels as a request attribute</strong> ({@link RequestAttributes.SCOPE_REQUEST}),
 * not a ThreadLocal. This service is servlet/blocking and Spring's Feign boundary already
 * propagates `RequestAttributes` across the invocation-handler executor — a fact measured on this
 * machine (invocation stack showed the supplier captured and restored them on the outbound path).
 * So the filter can store the child hop in the attribute, the Feign interceptor — invoked on a
 * DIFFERENT thread than the servlet dispatcher — reads the same attribute with no explicit
 * propagation code here. A missing or malformed context yields no trace headers at all; the
 * same mint-nothing rule D884 applies applies here.
 *
 * <p><strong>Note on configuration.</strong> Spring Cloud's Feign requires the interceptor beans
 * registered through the client's `@EnableFeignClients(defaultConfiguration = ...)` default; the
 * loosely-registered bean is kept for the unit tests' sake (Spring Cloud can't auto-adopt it).
 * The default participates in every client declared here.
 *
 * <p>{@code nexus.insight.trace.enabled=false} turns participation off for one process. Its only
 * purpose is to make the smoke falsifiable; it is not a production tuning knob.
 */
@Configuration
public class InsightTraceConfig {

    public static final String TRACEPARENT = "traceparent";
    public static final String TRACE_ID_HEADER = "X-Trace-Id";
    public static final String SPAN_ID_HEADER = "X-Trace-Span-Id";
    /** The attribute key carrying the child-span context across the Feign/servlet boundary. */
    public static final String TRACE_ATTRIBUTE = "nexus.insight.trace.child";

    private static final Pattern W3C = Pattern.compile(
            "^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$");
    private static final String ZERO_TRACE = "0".repeat(32);
    private static final String ZERO_SPAN = "0".repeat(16);

    private final boolean enabled;
    static volatile boolean ENABLED = true;

    public InsightTraceConfig(@Value("${nexus.insight.trace.enabled:true}") boolean enabled) {
        this.enabled = enabled;
        ENABLED = enabled;
    }

    /** Strict parse. Returns null for anything the W3C grammar or the all-zero rule rejects. */
    static Matcher strict(String header) {
        if (header == null) return null;
        Matcher m = W3C.matcher(header.trim());
        if (!m.matches()) return null;
        if (ZERO_TRACE.equals(m.group(1)) || ZERO_SPAN.equals(m.group(2))) return null;
        return m;
    }

    /** A CHILD hop: same trace id and flags, new span id. Never invents a root context. */
    static String childOf(String header) {
        Matcher m = strict(header);
        return m == null ? null : "00-" + m.group(1) + "-" + hex(16) + "-" + m.group(3);
    }

    static String traceOf(String traceparent) {
        String[] parts = traceparent.split("-");
        return parts.length == 4 ? parts[1] : "";
    }

    static String spanOf(String traceparent) {
        String[] parts = traceparent.split("-");
        return parts.length == 4 ? parts[2] : "";
    }

    private static String hex(int length) {
        StringBuilder sb = new StringBuilder(length);
        while (sb.length() < length) {
            sb.append(UUID.randomUUID().toString().replace("-", ""));
        }
        return sb.substring(0, length).toLowerCase(Locale.ROOT);
    }

    /* Package-visible for the unit tests. */
    static void setRequestAttribute(RequestAttributes attrs, String child) {
        attrs.setAttribute(TRACE_ATTRIBUTE, child, RequestAttributes.SCOPE_REQUEST);
    }

    static String requestChild() {
        RequestAttributes attrs = RequestContextHolder.getRequestAttributes();
        if (attrs == null) return null;
        Object v = attrs.getAttribute(TRACE_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
        return v instanceof String ? (String) v : null;
    }

    @Bean
    FilterRegistrationBean<Filter> insightTraceFilter() {
        Filter participant = (ServletRequest req, ServletResponse res, FilterChain chain) -> {
            if (!enabled) {
                chain.doFilter(req, res);
                return;
            }
            HttpServletRequest request = (HttpServletRequest) req;
            HttpServletResponse response = (HttpServletResponse) res;
            String inbound = request.getHeader(TRACEPARENT);
            Matcher parent = strict(inbound);
            String child = parent == null ? null : childOf(inbound);
            if (child != null) {
                request.setAttribute(TRACE_ATTRIBUTE, child);
                response.setHeader(TRACE_ID_HEADER, parent.group(1));
                response.setHeader(SPAN_ID_HEADER, spanOf(child));
            }
            try {
                chain.doFilter(req, res);
            } finally {
                if (child != null) {
                    request.removeAttribute(TRACE_ATTRIBUTE);
                }
            }
        };
        FilterRegistrationBean<Filter> registration = new FilterRegistrationBean<>(participant);
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return registration;
    }

    /**
     * Intercepts every Feign outbound and copies the child context onto the upstreams. In this
     * module's Spring Cloud version the loosely-registered bean is silently unbound from every
     * client in scope; the {@code Defaults} inner class is what the application wires as the
     * default configuration for every Feign client it declares.
     */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class Defaults {
        @Bean
        RequestInterceptor requestInterceptor() {
            return template -> {
                if (!InsightTraceConfig.ENABLED) return;
                String child = requestChild();
                if (child == null) return;
                template.header(TRACEPARENT, child);
                template.header(TRACE_ID_HEADER, traceOf(child));
            };
        }
    }

    /** Loosely-registered, kept for the unit tests (Spring Cloud does not adopt it for clients). */
    @Bean
    RequestInterceptor insightTraceInterceptor() {
        return template -> {
            if (!enabled) return;
            String child = requestChild();
            if (child == null) return;
            template.header(TRACEPARENT, child);
            template.header(TRACE_ID_HEADER, traceOf(child));
        };
    }
}
