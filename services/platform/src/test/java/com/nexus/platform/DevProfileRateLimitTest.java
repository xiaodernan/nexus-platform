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
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

/**
 * D48 restored an operator's ability to say {@code NEXUS_RL_AUTH=3} on a dev boot, which {@code application-dev.yml}
 * had been closing with a bare {@code auth-requests: 100}. {@code ConfigDecorationTest} can read the file shape and
 * see that the placeholder is back; that is not the same as the value arriving. A property that is env-shaped in a
 * file and still resolves to something else is D46's defect wearing the comment this unit wrote, so this class asks
 * the running service — with the dev profile on and the variable set — what its own window is.
 *
 * <p>The dev defaults stay untouched (100/300/100 for a manual curl session, per that file's comment); only the
 * override is what is under test here.
 */
@ActiveProfiles("dev")
@TestPropertySource(properties = {
        "nexus.ratelimit.enabled=true",
        "NEXUS_RL_AUTH=2"
})
class DevProfileRateLimitTest extends NexusIntegrationTest {

    private ResponseEntity<String> login(Tenant tenant, String email) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Tenant", tenant.slug());
        return http.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(Map.of("email", email, "password", "not-the-password"), headers), String.class);
    }

    @Test
    @DisplayName("Under the dev profile, NEXUS_RL_AUTH is the window the filter actually enforces")
    void theOperatorsNumberReachesTheFilter() {
        Tenant tenant = newTenant("rl-dev");
        String email = "dev-window@example.test";

        // The filter prints the number it is enforcing, so this is the service's answer, not the file's.
        ResponseEntity<String> first = login(tenant, email);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(first.getHeaders().getFirst("X-RateLimit-Limit"))
                .as("dev advertises 100 per address and NEXUS_RL_AUTH=2 was set for this context")
                .isEqualTo("2");
        assertThat(login(tenant, email).getHeaders().getFirst("X-RateLimit-Remaining")).isEqualTo("0");

        assertThat(login(tenant, email).getStatusCode())
                .as("the third attempt is the one the operator's number says must be refused")
                .isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'login_failed'",
                Map.of("t", tenant.id()))).as("three attempts, two handler visits").isEqualTo(2);
    }
}
