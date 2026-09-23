package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

/**
 * {@code invalid_id_token} is raised by {@code AuthService.oauth} when a *registered* verifier declines a token,
 * and {@code OAuthVerifierRegistry} registers the dev verifier only under the dev or test profiles — so under
 * the default test profile the code is unreachable, and {@code AuthRefusalCodesTest} can only assert the 422
 * that names the supported providers. This class turns the profile on to produce the code itself.
 *
 * <p>Worth stating plainly, because it is the same finding §42 made about the limiter from the other side: a
 * refusal that depends on a configuration the shared harness never sets is a refusal no test has ever seen.
 * Reading the registry was enough to know it; this class is what stops that being a claim.
 */
@ActiveProfiles("test")
class DevOauthRefusalTest extends NexusIntegrationTest {

    @Test
    @DisplayName("With the dev verifier registered, a token it cannot vouch for answers invalid_id_token")
    void devVerifierDeclinesGarbage() {
        Tenant tenant = newTenant("oauth-dev");

        ResponseEntity<String> res = post(tenant, null, "/api/v1/auth/oauth/dev",
                Json.map("id_token", "obviously-not-a-token"));

        assertThat(res.getStatusCode())
                .as("body: %s", res.getBody())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).isEqualTo("invalid_id_token");
        assertThat(Json.tree(res.getBody()).path("error").path("message").asText())
                .as("the provider is named back, so a client can tell which of its buttons failed")
                .contains("dev");
    }
}
