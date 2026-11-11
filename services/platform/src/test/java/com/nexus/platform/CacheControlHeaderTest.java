package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * D935 — the filter is registered in {@code FilterChainConfig}, and this is the check that nobody
 * quietly unwires it: an auth-filter refusal (which no controller ever touches, so no controller
 * ever sets its own freshness mark) must come back with {@code Cache-Control: no-store} and
 * {@code Pragma: no-cache}. If the registration goes missing the headers disappear end-to-end, and
 * this test reddens — the unit-test pair in {@code CacheControlFilterTest} cannot see that case.
 */
class CacheControlHeaderTest extends NexusIntegrationTest {

    @Test
    @DisplayName("an auth-filter refusal carries the freshness mark end to end")
    void aRefusalBodyIsMarkedNoStore() {
        ResponseEntity<String> res = get(newTenant("headers"), "definitely-not-a-token", "/api/v1/me");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(res.getHeaders().getFirst("Cache-Control"))
                .as("an uncacheable personalised refusal out of the auth filter must be marked by the filter")
                .isEqualTo("no-store");
        assertThat(res.getHeaders().getFirst("Pragma")).isEqualTo("no-cache");
    }
}
