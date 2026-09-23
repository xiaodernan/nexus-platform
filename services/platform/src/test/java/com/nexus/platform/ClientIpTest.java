package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * §51 makes every byte that arrives from outside untrusted, and {@code X-Forwarded-For} is such a byte. Until
 * D47 {@link Req#clientIp} answered with its first entry whenever the header was present, which turned the
 * login brute-force bucket into a bucket the caller names (one header per attempt bought a fresh one) and let
 * the same string into {@code audit_logs.ip}, whose {@code inet} cast drops the row when the caller typed
 * something that is not an address.
 *
 * <p>This reads the method directly rather than the router because the promise is about one expression: the
 * address is a fact about the connection, and no header may replace it here. A deployment that really sits
 * behind a proxy declares that proxy to the container ({@code server.forward-headers-strategy} plus
 * {@code server.tomcat.remoteip.internal-proxies}), and the valve then rewrites what {@code getRemoteAddr()}
 * answers — once, for every reader, and only for a request that actually came from the declared address.
 * {@code ForwardedHeaderTrustTest} witnesses both sides of that seam over HTTP.
 */
class ClientIpTest {

    private static MockHttpServletRequest arriving(String peer) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/v1/auth/login");
        request.setRemoteAddr(peer);
        return request;
    }

    @Test
    @DisplayName("clientIp answers with the peer address, whatever the caller claims")
    void aHeaderNeverReplacesThePeer() {
        MockHttpServletRequest forged = arriving("203.0.113.7");
        forged.addHeader("X-Forwarded-For", "8.8.8.8, 1.2.3.4");
        assertThat(Req.clientIp(forged))
                .as("the left-most forwarded address is the caller's invention")
                .isEqualTo("203.0.113.7");

        MockHttpServletRequest blank = arriving("198.51.100.9");
        blank.addHeader("X-Forwarded-For", "   ");
        assertThat(Req.clientIp(blank)).isEqualTo("198.51.100.9");

        assertThat(Req.clientIp(arriving("198.51.100.22")))
                .as("and a plain request still gets its peer")
                .isEqualTo("198.51.100.22");
    }
}
