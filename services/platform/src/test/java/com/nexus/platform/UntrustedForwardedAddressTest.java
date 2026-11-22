package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

/**
 * D1545 — the audit half of D47's forwarded-header story, kept apart from
 * {@link ForwardedHeaderTrustTest} because it needs no rate-limit budget.
 *
 * <p>The limiter's auth buckets are keyed by IP ({@code RateLimiter.check("auth-ip", …)}) and live for
 * the whole JVM, so the parent class spends the socket-peer bucket for {@code 127.0.0.1} through its
 * {@code auth-requests=1} override. An untrusted non-IP header lands on that same shared bucket, which
 * earlier auth tests have already spent: measured in the full suite, this assertion answered 429 where it
 * expected 401. Disabling the limiter here tests the audit consequence itself (the {@code inet} cast and
 * the swallowed write), not the queue in front of it.
 */
@TestPropertySource(properties = {
        "nexus.ratelimit.enabled=false",
        "server.forward-headers-strategy=framework"
})
class UntrustedForwardedAddressTest extends NexusIntegrationTest {

    private ResponseEntity<String> login(Tenant tenant, String email, String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Tenant", tenant.slug());
        headers.set("X-Forwarded-For", forwardedFor);
        return http.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(Map.of("email", email, "password", "wrong"), headers), String.class);
    }

    @Test
    @DisplayName("The same string also decided whether the audit trail existed at all")
    void anUntrustedAddressTakesItsOwnRowWithIt() {
        Tenant tenant = newTenant("rl-fw-garbage");

        // Not an address, so `cast(:ip as inet)` fails inside AuditService.record — which catches everything by
        // design, because a broken audit write must not turn a successful action into a 500. The caller still
        // gets its 401; the row that was supposed to record the refused login is simply not there, and the only
        // trace of it is a log line. Under the fixed configuration the same request writes the row (see
        // RateLimitEnforcementTest, whose first attempt carries this very value).
        assertThat(login(tenant, "garbage@example.test", "not-an-ip").getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(count("select count(*) from audit_logs where tenant_id = :t", Map.of("t", tenant.id())))
                .as("framework put `not-an-ip` into an inet column and the catch swallowed the loss")
                .isZero();
    }
}
