package com.nexus.cloud.insight;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Collection;
import java.util.Map;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import feign.RequestInterceptor;
import feign.RequestTemplate;
import jakarta.servlet.Filter;

/** D900 — the fifth service is a trace PARTICIPANT: parse, continue, propagate, never mint. */
class InsightTraceConfigTest {

    private static final String VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    private static final String TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
    private static final String PARENT_SPAN = "00f067aa0ba902b7";

    @BeforeEach
    @AfterEach
    void reset() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void aValidContextIsContinuedNotRestarted() {
        String child = InsightTraceConfig.childOf(VALID);
        assertThat(child).matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$");
        assertThat(InsightTraceConfig.traceOf(child)).isEqualTo(TRACE);
        assertThat(InsightTraceConfig.spanOf(child)).isNotEqualTo(PARENT_SPAN);
        assertThat(child).isNotEqualTo(VALID);
    }

    @Test
    void malformedOrAllZeroContextsAreRefusedNotLaundered() {
        assertThat(InsightTraceConfig.strict(null)).isNull();
        assertThat(InsightTraceConfig.childOf(null)).isNull();
        assertThat(InsightTraceConfig.childOf(VALID.toUpperCase())).isNull();
        assertThat(InsightTraceConfig.childOf("00-" + "0".repeat(32) + "-" + PARENT_SPAN + "-01")).isNull();
        assertThat(InsightTraceConfig.childOf("00-" + TRACE + "-" + "0".repeat(16) + "-01")).isNull();
        assertThat(InsightTraceConfig.childOf("00-short-span-01")).isNull();
        assertThat(InsightTraceConfig.childOf("01-" + TRACE + "-" + PARENT_SPAN + "-01")).isNull();
    }

    @Test
    void noValidContextMeansNoInventedHeaders() throws Exception {
        Filter filter = new InsightTraceConfig(true).insightTraceFilter().getFilter();
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/insight/plane");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getHeader(InsightTraceConfig.TRACE_ID_HEADER)).isNull();
        assertThat(response.getHeader(InsightTraceConfig.SPAN_ID_HEADER)).isNull();
        assertThat(request.getAttribute(InsightTraceConfig.TRACE_ATTRIBUTE)).isNull();
    }

    @Test
    void aValidContextIsEchoedAndClearedAfterTheChain() throws Exception {
        Filter filter = new InsightTraceConfig(true).insightTraceFilter().getFilter();
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/insight/plane");
        request.addHeader(InsightTraceConfig.TRACEPARENT, VALID);
        MockHttpServletResponse response = new MockHttpServletResponse();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getHeader(InsightTraceConfig.TRACE_ID_HEADER)).isEqualTo(TRACE);
        assertThat(response.getHeader(InsightTraceConfig.SPAN_ID_HEADER)).matches("[0-9a-f]{16}");
        assertThat(response.getHeader(InsightTraceConfig.SPAN_ID_HEADER)).isNotEqualTo(PARENT_SPAN);
        assertThat(request.getAttribute(InsightTraceConfig.TRACE_ATTRIBUTE)).isNull();
    }

    @Test
    void theDisabledConfigNeitherEchoesNorPropagates() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/insight/plane");
        request.addHeader(InsightTraceConfig.TRACEPARENT, VALID);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));

        new InsightTraceConfig(false).insightTraceFilter().getFilter()
                .doFilter(request, response, new MockFilterChain());
        assertThat(response.getHeader(InsightTraceConfig.TRACE_ID_HEADER)).isNull();
        assertThat(request.getAttribute(InsightTraceConfig.TRACE_ATTRIBUTE)).isNull();

        InsightTraceConfig.setRequestAttribute(
                RequestContextHolder.currentRequestAttributes(), VALID);
        RequestTemplate template = new RequestTemplate();
        new InsightTraceConfig(false).insightTraceInterceptor().apply(template);
        assertThat(header(template, InsightTraceConfig.TRACEPARENT)).isNull();
    }

    @Test
    void theFeignInterceptorCopiesTheChildContextToTheUpstream() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/insight/plane");
        String child = InsightTraceConfig.childOf(VALID);
        request.setAttribute(InsightTraceConfig.TRACE_ATTRIBUTE, child);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));

        RequestTemplate template = new RequestTemplate();
        new InsightTraceConfig(true).insightTraceInterceptor().apply(template);

        String propagated = header(template, InsightTraceConfig.TRACEPARENT);
        assertThat(propagated).isNotNull();
        assertThat(InsightTraceConfig.traceOf(propagated)).isEqualTo(TRACE);
        assertThat(InsightTraceConfig.spanOf(propagated)).isNotEqualTo(PARENT_SPAN);
        assertThat(header(template, InsightTraceConfig.TRACE_ID_HEADER)).isEqualTo(TRACE);
    }

    @Test
    void theFeignInterceptorAddsNothingWithoutACurrentContext() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/insight/plane");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        RequestTemplate template = new RequestTemplate();
        new InsightTraceConfig(true).insightTraceInterceptor().apply(template);
        assertThat(header(template, InsightTraceConfig.TRACEPARENT)).isNull();
    }

    private static String header(RequestTemplate template, String name) {
        Map<String, Collection<String>> headers = template.headers();
        Collection<String> values = headers.get(name);
        return values == null || values.isEmpty() ? null : values.iterator().next();
    }
}
