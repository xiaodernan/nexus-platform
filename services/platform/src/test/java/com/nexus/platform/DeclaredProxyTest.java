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
 * "Untrusted" that nobody can switch on is a broken feature rather than a policy, so this is the other half of
 * D47: the shipped strategy ({@code native}, set to {@code native} here so the class means what it says even
 * if the default moves) with localhost declared as the proxy — the position a sidecar ingress actually stands
 * in. Then, and only then, the address in {@code X-Forwarded-For} becomes the client: it gets its own bucket
 * and it is the address recorded.
 *
 * <p>The contrast with {@code ForwardedHeaderTrustTest} is the point. The same four requests answer differently
 * in the two classes, and the only thing that changed is whether the peer was declared a proxy.
 */
@TestPropertySource(properties = {
        "nexus.ratelimit.enabled=true",
        "nexus.ratelimit.auth-requests=1",
        "server.forward-headers-strategy=native",
        // Escape-free on purpose: an inlined test property loses its backslashes on the way to the valve, so
        // "127\.\d{1,3}…" would arrive as "127.d{1,3}…" and match nothing at all.
        "server.tomcat.remoteip.internal-proxies=127.*"
})
class DeclaredProxyTest extends NexusIntegrationTest {

    private ResponseEntity<String> login(Tenant tenant, String email, String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Tenant", tenant.slug());
        headers.set("X-Forwarded-For", forwardedFor);
        return http.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(Map.of("email", email, "password", "wrong"), headers), String.class);
    }

    private String recordedLoginIp(Tenant tenant) {
        return String.valueOf(row("select host(ip) as ip from audit_logs where tenant_id = :t "
                        + "and action = 'login_failed' order by id desc limit 1",
                Map.of("t", tenant.id())).get("ip"));
    }

    @Test
    @DisplayName("When the peer really is a declared proxy, the header names the client")
    void aDeclaredProxyIsWhatMakesTheHeaderCount() {
        Tenant tenant = newTenant("rl-proxy");
        String email = "behind-proxy@example.test";

        // Asked first, because it is the whole question: where does the address the application sees come from?
        assertThat(login(tenant, email, "203.0.113.77").getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(recordedLoginIp(tenant))
                .as("localhost was declared the proxy, so the address it vouched for is the one recorded")
                .isEqualTo("203.0.113.77");

        assertThat(login(tenant, email, "203.0.113.11").getStatusCode())
                .as("the first attempt for a named client")
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(login(tenant, email, "203.0.113.11").getStatusCode())
                .as("that named client has now spent its one attempt")
                .isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(login(tenant, email, "203.0.113.12").getStatusCode())
                .as("a different name is a different client — which is the point of a proxy")
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'login_failed'",
                Map.of("t", tenant.id()))).as("four attempts, three buckets, three handler visits").isEqualTo(3);
    }
}
