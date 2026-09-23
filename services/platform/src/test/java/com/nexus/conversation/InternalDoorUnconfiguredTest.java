package com.nexus.conversation;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

/**
 * The internal conversation door answers {@code 501 not_implemented} when the AI service has no shared secret
 * configured — D7's rule that an unimplemented path says so loudly rather than answering as if it worked. No
 * test had ever produced that 501, because {@code NexusIntegrationTest} sets {@code NEXUS_AI_INTERNAL_TOKEN} for
 * every class that extends it: the refusal is real in the code and unobservable in the suite, which is the same
 * shape as §42's rate-limit finding from the other side (a branch the harness switches off cannot be seen).
 *
 * <p>So this class overrides the one property, with an empty value — the guard's own rule is "fewer than 16
 * characters means unconfigured", so blank is the honest way to reach it rather than a short token that would
 * take the 401 path instead.
 */
@TestPropertySource(properties = "NEXUS_AI_INTERNAL_TOKEN=")
class InternalDoorUnconfiguredTest extends NexusIntegrationTest {

    @Test
    @DisplayName("With no internal token configured, the agent door answers 501 and names the setting")
    void unconfiguredInternalDoorSaysNotImplemented() {
        Tenant tenant = newTenant("internal-501");
        newMerchant(tenant, "internal-" + System.nanoTime(), "published");

        ResponseEntity<String> res = post(tenant, null,
                "/api/v1/internal/conversations/" + UUID.randomUUID() + "/agent-message",
                Map.of("conversation_id", UUID.randomUUID().toString(), "content", "would the agent send this?"));

        assertThat(res.getStatusCode())
                .as("body: %s", res.getBody())
                .isEqualTo(HttpStatus.NOT_IMPLEMENTED);
        assertThat(Json.tree(res.getBody()).path("error").path("code").asText()).isEqualTo("not_implemented");
        assertThat(Json.tree(res.getBody()).path("error").path("message").asText())
                .as("the refusal says what to set, because a 501 with no instruction is not actionable")
                .contains("NEXUS_AI_INTERNAL_TOKEN");
    }
}
