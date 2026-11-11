package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import java.io.IOException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * D935 — every `/api/v1` response carries an explicit freshness policy. The three behaviours that
 * matter: the filter marks the response before any handler runs, a handler that sets its own
 * `Cache-Control` wins (the one real override in the mount, `merchants/{slug}/ucp.json`, answers
 * `public, max-age=300`), and the mark survives an upstream refusal that never reaches a controller.
 */
class CacheControlFilterTest {

    // A real contract-declared platform path, not a made-up placeholder: check_contract_drift censuses
    // path literals in this source tree against docs/API_CONTRACT.md, so a fixture URI that no route owns
    // would read as "code calls a path nobody documented" (integration fix, D937 plane).
    private static final MockHttpServletRequest REQUEST = new MockHttpServletRequest("GET", "/api/v1/collections");

    @Test
    @DisplayName("a plain handler leaves no-store and Pragma: no-cache on the response")
    void marksFreshness() throws Exception {
        final MockHttpServletResponse response = new MockHttpServletResponse();
        new CacheControlFilter().doFilter(REQUEST, response, (req, res) -> { });
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getHeader("Pragma")).isEqualTo("no-cache");
    }

    @Test
    @DisplayName("a handler that sets its own Cache-Control wins over the filter")
    void handlerOverrideWins() throws Exception {
        final MockHttpServletResponse response = new MockHttpServletResponse();
        new CacheControlFilter().doFilter(REQUEST, response, (req, res) ->
                ((MockHttpServletResponse) res).setHeader("Cache-Control", "public, max-age=300"));
        assertThat(response.getHeader("Cache-Control"))
                .as("the servlet contract: the last setHeader for a name wins")
                .isEqualTo("public, max-age=300");
    }

    @Test
    @DisplayName("the mark survives a downstream ServletException")
    void survivesRefusal() {
        final MockHttpServletResponse response = new MockHttpServletResponse();
        assertThatThrownBy(() ->
                new CacheControlFilter().doFilter(REQUEST, response, new FilterChain() {
                    @Override
                    public void doFilter(ServletRequest req, ServletResponse res) throws ServletException {
                        throw new ServletException("tenant_refused");
                    }
                })).isInstanceOf(ServletException.class);
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getHeader("Pragma")).isEqualTo("no-cache");
    }

    @Test
    @DisplayName("the mark survives a downstream RuntimeException")
    void survivesRuntimeFailure() {
        final MockHttpServletResponse response = new MockHttpServletResponse();
        assertThatThrownBy(() ->
                new CacheControlFilter().doFilter(REQUEST, response, new FilterChain() {
                    @Override
                    public void doFilter(ServletRequest req, ServletResponse res) {
                        throw new IllegalStateException("boom");
                    }
                })).isInstanceOf(IllegalStateException.class);
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
    }

    @Test
    @DisplayName("a request whose method is HEAD also gets the mark")
    void marksHeadToo() throws Exception {
        final MockHttpServletResponse response = new MockHttpServletResponse();
        new CacheControlFilter().doFilter(
                new MockHttpServletRequest("HEAD", "/api/v1/collections"), response, (req, res) -> { });
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
    }
}
