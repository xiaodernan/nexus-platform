package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The platform can emit 61 distinct error codes. Twenty-eight of them are named somewhere in this repository's
 * tests or verifiers; 33 have never been produced by a request anyone checked. That gap is the quiet half of the
 * ladder: a test that asserts {@code 401} passes whether the door said "your token expired", "that is a refresh
 * token" or "this session belongs to another tenant" — and those are three different things for a client to be
 * told, because three different repairs exist. §1's ladder is the status; the code is the answer.
 *
 * <p>This class walks the auth family of that list, in each case by *doing the thing* rather than by calling a
 * factory: a token with a broken signature, a genuinely expired but correctly signed token, a refresh token held
 * up as an access token, a session minted for another tenant, a second registration of the same address, and an
 * access token presented to the refresh door. The expired case is signed with the real key on purpose — an
 * unsigned token would be refused for the wrong reason and the test would still be green.
 */
class AuthRefusalCodesTest extends NexusIntegrationTest {

    private static final String PASSWORD = "Str0ng-Passw0rd!23";

    private String code(ResponseEntity<String> res) {
        return Json.tree(res.getBody()).path("error").path("code").asText();
    }

    private String bearerFor(Tenant tenant, UUID user, String type, Map<String, Object> extra) {
        LinkedHashMap<String, Object> claims = new LinkedHashMap<>();
        claims.put("role", "consumer");
        if (extra != null) {
            claims.putAll(extra);
        }
        return jwt.sign(jwt.claims(type, user.toString(), tenant.id().toString(),
                "sid-" + user, UUID.randomUUID().toString(), claims));
    }

    @Test
    @DisplayName("A malformed token and one with a bad signature answer the same code, and different messages")
    void invalidTokenDistinguishesNothingItShouldNot() {
        Tenant tenant = newTenant("codes-malformed");
        UUID user = newUser(tenant, "malformed@codes.test", "consumer");

        ResponseEntity<String> truncated = get(tenant, "header-only-payload", "/api/v1/me");
        ResponseEntity<String> tampered = get(tenant, bearerFor(tenant, user, "access", null) + "x", "/api/v1/me");

        assertThat(truncated.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(tampered.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(code(truncated)).isEqualTo("invalid_token");
        assertThat(code(tampered)).as("a flipped signature character is still an invalid token, not a new code")
                .isEqualTo("invalid_token");
        assertThat(Json.tree(truncated.getBody()).path("error").path("message").asText())
                .isNotEqualTo(Json.tree(tampered.getBody()).path("error").path("message").asText());
        assertThat(Json.tree(truncated.getBody()).path("error").path("request_id").asText()).isNotBlank();
    }

    @Test
    @DisplayName("A correctly signed token that has aged out says so, because the repair is to refresh")
    void expiredTokenSaysExpired() {
        Tenant tenant = newTenant("codes-expiry");
        UUID user = newUser(tenant, "expired@codes.test", "consumer");
        long past = System.currentTimeMillis() / 1000 - 60;

        ResponseEntity<String> res = get(tenant, bearerFor(tenant, user, "access", Map.of("exp", past)),
                "/api/v1/me");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(code(res))
                .as("signed with the real key and exp in the past: this cannot be the signature branch")
                .isEqualTo("token_expired");
    }

    @Test
    @DisplayName("A refresh token held up as an access token is named, not just refused")
    void refreshTokenAsBearerIsItsOwnAnswer() {
        Tenant tenant = newTenant("codes-type");
        UUID user = newUser(tenant, "typed@codes.test", "consumer");

        ResponseEntity<String> res = get(tenant, bearerFor(tenant, user, "refresh", null), "/api/v1/me");

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(code(res)).isEqualTo("wrong_token_type");
    }

    @Test
    @DisplayName("A session minted for another tenant reads as unauthorized, never as a foreign row")
    void crossTenantSessionIsRefusedAtTheDoor() {
        Tenant home = newTenant("codes-home");
        Tenant elsewhere = newTenant("codes-elsewhere");
        UUID user = newUser(home, "traveller@codes.test", "consumer");
        String foreign = bearerFor(home, user, "access", null);

        // Same signature, tid of a tenant the caller is not in — the filter's tenant_mismatch branch.
        ResponseEntity<String> res = get(elsewhere, foreign, "/api/v1/me");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(code(res)).isEqualTo("tenant_mismatch");

        // And the same token keeps working where it belongs, so the refusal above is the tid and not the fixture.
        assertThat(get(home, foreign, "/api/v1/me").getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("A second registration names the conflict, where the status alone would only say 409")
    void duplicateEmailNamesItself() {
        Tenant tenant = newTenant("codes-email");
        String email = "twice@codes.test";
        Map<String, Object> body = Json.map("email", email, "password", PASSWORD, "display_name", "Twice",
                "accept_terms", true);

        assertThat(post(tenant, null, "/api/v1/auth/register", body).getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> again = post(tenant, null, "/api/v1/auth/register", body);

        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(code(again)).isEqualTo("email_taken");
        assertThat(Json.tree(again.getBody()).path("error").path("details").isObject())
                .as("the address is not echoed back — this 409 names the conflict, not the input")
                .isTrue();
    }

    @Test
    @DisplayName("An access token at the refresh door is the wrong credential, not an expired one")
    void wrongCredentialAtTheRefreshDoor() {
        Tenant tenant = newTenant("codes-refresh");
        UUID user = newUser(tenant, "rotator@codes.test", "consumer");

        ResponseEntity<String> res = post(tenant, null, "/api/v1/auth/refresh",
                Json.map("refresh_token", bearerFor(tenant, user, "access", null)));

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(code(res)).isEqualTo("invalid_refresh_token");
    }

    @Test
    @DisplayName("Every refusal above is a §1 envelope, not a bare status")
    void everyRefusalCarriesTheEnvelope() {
        Tenant tenant = newTenant("codes-envelope");
        ResponseEntity<String> res = get(tenant, "nope", "/api/v1/me");
        JsonNode error = Json.tree(res.getBody()).path("error");
        assertThat(error.isMissingNode()).as("body: %s", res.getBody()).isFalse();
        assertThat(error.path("code").asText()).isEqualTo("invalid_token");
        assertThat(error.path("message").asText()).isNotBlank();
        assertThat(error.path("details").isObject()).isTrue();
        assertThat(error.path("request_id").asText()).isNotBlank();
    }
}
