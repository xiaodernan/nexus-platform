package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;

/**
 * D902: the negative tier is a performance fix, not a behavior change — what a client receives
 * must be byte-for-byte the same contract: an unknown slug is an enumeration-safe 404
 * {@code tenant_not_found} (twice in a row, so the cached answer is exercised), and a known
 * tenant still resolves to a 200 health body. The SQL-count claim lives in
 * {@link TenantCachePenetrationTest}; this class proves the wire.
 */
class TenantNegativeCacheHttpTest extends NexusIntegrationTest {

    @Test
    @DisplayName("an unknown slug is still an enumeration-safe 404, twice in a row")
    void unknownSlugStill404() {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Tenant", "no-such-tenant-d902");
        for (int i = 0; i < 2; i++) {
            ResponseEntity<String> res = http.exchange(url("/api/v1/health"), HttpMethod.GET,
                    new HttpEntity<>(headers), String.class);
            assertThat(res.getStatusCode().value()).isEqualTo(404);
            assertThat(res.getBody()).contains("tenant_not_found");
        }
    }

    @Test
    @DisplayName("a known tenant still resolves to a 200 health body")
    void knownTenantStill200() {
        Tenant tenant = newTenant("d902");
        ResponseEntity<String> res = http.exchange(url("/api/v1/health"), HttpMethod.GET,
                new HttpEntity<>(json(tenant, null)), String.class);
        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).contains("nexus-platform");
    }
}