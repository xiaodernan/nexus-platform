package com.nexus.ucp;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The UCP seam has four unit tests and none of them has ever sent a request. {@code UcpProfileServiceTest}
 * stubs {@code jdbc.firstForTenant(…)} with hand-built rows — including the row that makes the 200 document —
 * while no code path, migration or seed in this repository writes {@code agent_profiles} at all. So the door
 * that §1 and docs/UCP.md describe had never been answered by the running service, which is how a reserved seam
 * can look covered by tests and be covered by mocks.
 *
 * <p>What the walk establishes is the reserved-ness itself, as behaviour rather than as a comment: the origin
 * profile advertises no capabilities and says {@code not_integrated}; the per-merchant door answers the
 * explaining 404 the service promises; and the pointer the origin document prints
 * ({@code merchant_profiles}) resolves against a route this build really serves, which is the part a mock can
 * never check (D42: a printed field is a promise).
 *
 * <p>The third test is a deliberate absence gate. It asserts the table is empty in a migrated database, so the
 * day a publisher lands, the assertion that breaks is this one — pointing whoever added it at the HTTP case the
 * seam still does not have.
 */
class UcpDoorsTest extends NexusIntegrationTest {

    private ResponseEntity<String> getRaw(String path) {
        return http.exchange(java.net.URI.create(url(path)), org.springframework.http.HttpMethod.GET,
                new org.springframework.http.HttpEntity<>(new org.springframework.http.HttpHeaders()), String.class);
    }

    @Test
    @DisplayName("The origin profile advertises nothing it does not serve, and its pointer resolves")
    void originProfileStaysHonest() {
        ResponseEntity<String> out = getRaw("/.well-known/ucp");
        assertThat(out.getStatusCode()).as("body: %s", out.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode profile = Json.tree(out.getBody());

        assertThat(profile.path("protocol").asText()).isEqualTo("ucp");
        assertThat(profile.path("status").asText())
                .as("phase 1 reserves the seam and says so in the payload, not only in the docs")
                .isEqualTo("not_integrated");
        assertThat(profile.path("capabilities")).isEmpty();
        assertThat(profile.path("payment_handlers")).isEmpty();
        assertThat(out.getHeaders().getCacheControl()).contains("public").contains("max-age=3600");

        // The document's own pointer, followed. A path printed here that nothing served would be the D44
        // failure in machine-readable form — an agent would integrate against a URL that answers nothing.
        String template = profile.path("merchant_profiles").asText();
        assertThat(template).isEqualTo("/api/v1/merchants/{slug}/ucp.json");
        Tenant tenant = newTenant("ucp-origin");
        String slug = "ucp-probe-" + System.nanoTime();
        newMerchant(tenant, slug, "published");
        ResponseEntity<String> pointed = getRaw("/api/v1/merchants/" + slug + "/ucp.json");
        assertThat(pointed.getStatusCode())
                .as("the route exists and answers a UCP-shaped refusal, not a routing 404: %s", pointed.getBody())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(pointed.getBody()).path("error").path("code").asText())
                .isEqualTo("ucp_profile_not_published");
    }

    @Test
    @DisplayName("An unpublished merchant is an absence that explains itself to an integrating agent")
    void merchantDoorExplainsItsAbsence() {
        Tenant tenant = newTenant("ucp-merchant");
        String slug = "ucp-quiet-" + System.nanoTime();
        newMerchant(tenant, slug, "published");

        ResponseEntity<String> out = get(tenant, null, "/api/v1/merchants/" + slug + "/ucp.json");
        assertThat(out.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        JsonNode error = Json.tree(out.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("ucp_profile_not_published");
        assertThat(error.path("details").path("merchant_slug").asText()).isEqualTo(slug);
        assertThat(error.path("details").path("expected").asText())
                .as("an agent reading this knows exactly which row would change the answer")
                .contains("agent_profiles").contains("status='published'");
        assertThat(error.path("details").path("phase").asText()).contains("Phase 4");
    }

    @Test
    @DisplayName("Nothing in this build can publish a profile, so the 200 branch has no HTTP case yet")
    void noPublisherExistsForTheSeam() {
        assertThat(count("select count(*) from agent_profiles", Map.of()))
                .as("no migration, seed file, service or endpoint inserts into agent_profiles; the four "
                        + "UcpProfileServiceTest cases fabricate the row instead. When a publisher is built, "
                        + "this is the assertion that goes red — and the door's 200 path is the case to add then")
                .isZero();
    }
}
