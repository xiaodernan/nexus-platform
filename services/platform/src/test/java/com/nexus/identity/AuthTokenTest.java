package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.platform.JwtService;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The session itself (§3): what a token is allowed to say, and for how long. Nothing else in the suite
 * touched {@code /api/v1/auth/*} before this class, which is a strange gap for the one surface every
 * other test depends on.
 *
 * <p>The load-bearing case is the refresh. A workspace claim that exists at login and disappears at
 * the 15-minute rotation is invisible to a login-only test, and the client that reads it — the merchant
 * console deciding which business to open — breaks in the middle of a session rather than at the start.
 */
class AuthTokenTest extends NexusIntegrationTest {

    private static final String PASSWORD = "correct-horse-battery";

    @Test
    @DisplayName("A session keeps its workspace across rotation, and a used refresh token is refused")
    void workspaceSurvivesRefresh() {
        Tenant tenant = newTenant("auth");
        String email = "owner-" + System.nanoTime() + "@example.test";
        ResponseEntity<String> registered = post(tenant, null, "/api/v1/auth/register",
                Map.of("email", email, "password", PASSWORD, "display_name", "Workspace Owner",
                        "locale", "zh-HK", "accept_terms", true));
        assertThat(registered.getStatusCode()).isEqualTo(HttpStatus.OK)
                .withFailMessage("register said: " + registered.getBody());
        JsonNode session = Json.tree(registered.getBody());
        String userId = session.path("user").path("id").asText();
        String firstRefresh = session.path("refresh_token").asText();
        assertThat(firstRefresh).isNotBlank();

        // Nothing has granted this account a workspace yet, so the token must not invent one: `mer` is
        // where the console reads its default business from.
        assertThat(JwtService.stringClaim(jwt.verify(session.path("access_token").asText()), "mer")).isNull();

        List<String> cookies = registered.getHeaders().get(HttpHeaders.SET_COOKIE);
        assertThat(cookies).isNotNull();
        assertThat(cookies).anyMatch(c -> c.startsWith("nexus_session=") && c.contains("HttpOnly"));
        assertThat(cookies).noneMatch(c -> c.startsWith("nexus_refresh"));
        assertThat(registered.getHeaders().getCacheControl()).contains("no-store");

        // Membership, added after login — which is precisely the situation a rotation has to cope with.
        UUID merchant = newMerchant(tenant, "rotated-" + System.nanoTime(), "published");
        staff(tenant, merchant, UUID.fromString(userId));

        ResponseEntity<String> rotated = post(tenant, null, "/api/v1/auth/refresh",
                Map.of("refresh_token", firstRefresh));
        assertThat(rotated.getStatusCode()).isEqualTo(HttpStatus.OK)
                .withFailMessage("refresh said: " + rotated.getBody());
        JsonNode next = Json.tree(rotated.getBody());
        Map<String, Object> claims = jwt.verify(next.path("access_token").asText());
        assertThat(JwtService.stringClaim(claims, "sub")).isEqualTo(userId);
        assertThat(JwtService.stringClaim(claims, "mer")).isEqualTo(merchant.toString());
        assertThat(JwtService.stringClaim(claims, "typ")).isEqualTo("access");

        // The rotated token has to be a real session, not just a well-shaped string.
        assertThat(get(tenant, next.path("access_token").asText(), "/api/v1/me/reservations").getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // Rotating twice with the same token is reuse, and reuse kills the family (§3, §50).
        ResponseEntity<String> replay = post(tenant, null, "/api/v1/auth/refresh",
                Map.of("refresh_token", firstRefresh));
        assertThat(replay.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(replay.getBody()).path("error").path("code").asText())
                .isEqualTo("refresh_reuse_detected");
        assertThat(post(tenant, null, "/api/v1/auth/refresh",
                Map.of("refresh_token", next.path("refresh_token").asText())).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("Registration refuses a weak password and silent terms, and says which")
    void registerValidatesItsInput() {
        Tenant tenant = newTenant("auth-b");
        assertThat(post(tenant, null, "/api/v1/auth/register",
                Map.of("email", "shorty-" + System.nanoTime() + "@example.test", "password", "short",
                        "display_name", "S", "accept_terms", true)).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, null, "/api/v1/auth/register",
                Map.of("email", "quiet-" + System.nanoTime() + "@example.test", "password", PASSWORD,
                        "display_name", "Q", "accept_terms", false)).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        String email = "same-" + System.nanoTime() + "@example.test";
        Map<String, Object> body = Map.of("email", email.toUpperCase(), "password", PASSWORD,
                "display_name", "Twice", "accept_terms", true);
        assertThat(post(tenant, null, "/api/v1/auth/register", body).getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> second = post(tenant, null, "/api/v1/auth/register", body);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        // The 409 names the field but repeats no stored profile: registration must not confirm which
        // addresses this tenant holds.
        assertThat(Json.tree(second.getBody()).path("error").path("message").asText()).doesNotContain("Twice");
    }

    @Test
    @DisplayName("Demo sessions are marked, role-validated, and cannot reach another tenant")
    void demoSessionsAreLabelled() {
        Tenant tenant = newTenant("auth-c");
        assertThat(post(tenant, null, "/api/v1/auth/demo", Map.of("role", "root")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        ResponseEntity<String> res = post(tenant, null, "/api/v1/auth/demo", Map.of("role", "consumer"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK)
                .withFailMessage("demo login said: " + res.getBody());
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("demo_notice").isMissingNode()).isFalse();
        String token = body.path("access_token").asText();
        assertThat(JwtService.stringClaim(jwt.verify(token), "tid")).isEqualTo(tenant.id().toString());
        assertThat(get(tenant, token, "/api/v1/referrals/me").getStatusCode()).isEqualTo(HttpStatus.OK);
        // The same token against another tenant's header is not a session there (§2).
        assertThat(get(newTenant("auth-d"), token, "/api/v1/referrals/me").getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /**
     * V4 moved email and provider-identity uniqueness from the globe to the tenant. Before it, the
     * database contradicted the code that reads it: every lookup filters by {@code tenant_id}, and the
     * register 409 even says "in this tenant" — so a second tenant claiming an address the first one has
     * was answered with an unhandled {@code DuplicateKeyException}. The demo login reached this first,
     * because it inserts one synthetic account per tenant.
     */
    @Test
    @DisplayName("One address is two accounts in two tenants, and neither can log into the other")
    void emailIsScopedToItsTenant() {
        String email = "shared-" + System.nanoTime() + "@example.test";
        Tenant first = newTenant("id-a");
        Tenant second = newTenant("id-b");
        Map<String, Object> body = Map.of("email", email, "password", PASSWORD,
                "display_name", "Same Person", "accept_terms", true);

        ResponseEntity<String> a = post(first, null, "/api/v1/auth/register", body);
        assertThat(a.getStatusCode()).isEqualTo(HttpStatus.OK)
                .withFailMessage("tenant A said: " + a.getBody());
        ResponseEntity<String> b = post(second, null, "/api/v1/auth/register", body);
        assertThat(b.getStatusCode()).isEqualTo(HttpStatus.OK)
                .withFailMessage("tenant B said: " + b.getBody());
        String idA = Json.tree(a.getBody()).path("user").path("id").asText();
        String idB = Json.tree(b.getBody()).path("user").path("id").asText();
        assertThat(idB).isNotEqualTo(idA);

        // Same credentials, two different people — which is what the tenant-scoped login lookup promises.
        assertThat(Json.tree(post(first, null, "/api/v1/auth/login",
                Map.of("email", email, "password", PASSWORD)).getBody())
                .path("user").path("id").asText()).isEqualTo(idA);
        assertThat(Json.tree(post(second, null, "/api/v1/auth/login",
                Map.of("email", email, "password", PASSWORD)).getBody())
                .path("user").path("id").asText()).isEqualTo(idB);

        // Within one tenant the 409 still holds, and it is the *identity* row that must not collide either.
        assertThat(post(first, null, "/api/v1/auth/register", body).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(count("select count(*) from user_identities where provider = 'password' and provider_id = :e",
                Map.of("e", email))).isEqualTo(2);

        // Two demo sessions, two tenants: §87 must not be a once-per-world button.
        Tenant third = newTenant("id-c");
        assertThat(post(third, null, "/api/v1/auth/demo", Map.of("role", "consumer")).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(post(newTenant("id-d"), null, "/api/v1/auth/demo", Map.of("role", "consumer")).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }
}
