package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * {@code POST /api/v1/auth/logout} is the one auth handler D50's door audit found with no test naming it
 * ({@code grep -rn "logout" services/platform/src/test/java} → nothing), and §3's whole row for it read
 * "clears session" — three words covering a mechanism with three distinct parts, each of which had to be asked
 * separately what it does.
 *
 * <p>What the walk establishes, in the order the answers matter to a caller:
 * <ul>
 *   <li>the refresh family dies. {@code TokenRegistry.revoke(sid)} removes the row that says which jti may be
 *       exchanged, and {@code accept} refuses an unknown family rather than adopting it, so a token that was
 *       valid a second ago cannot mint another — the fail-closed trade the class javadoc already claimed, now
 *       witnessed rather than promised.</li>
 *   <li>both cookies are cleared: {@code nexus_session} and {@code nexus_csrf} come back with empty values and
 *       {@code Max-Age=0}, and the response names them in {@code cleared}.</li>
 *   <li><b>the access token does not die.</b> It authenticates until its own {@code exp} — 900 seconds by
 *       default — because nothing on the request path consults revocation state: {@code AuthFilter} checks the
 *       signature and the API-key case, and that is all. §3 now says so, since "clears session" was read by
 *       everyone (including the author of this file) as "the credentials are worthless now", and a logout on a
 *       shared machine is exactly the moment the difference is worth money.</li>
 * </ul>
 *
 * <p>No server-side token denylist was added to close that window, deliberately: the store behind it is Redis
 * when reachable and in-process when not, so a denylist would be per-process on a deployment with more than one
 * JVM — an offer that reads as security and behaves as luck. That is D46's defect wearing a better costume.
 */
class LogoutDoorTest extends NexusIntegrationTest {

    private static final String PASSWORD = "Str0ng-Passw0rd!23";

    private JsonNode register(Tenant tenant, String email) {
        ResponseEntity<String> out = post(tenant, null, "/api/v1/auth/register",
                Json.map("email", email, "password", PASSWORD, "display_name", "Leaver",
                        "accept_terms", true));
        assertThat(out.getStatusCode()).as("register said: %s", out.getBody()).isEqualTo(HttpStatus.OK);
        return Json.tree(out.getBody());
    }

    @Test
    @DisplayName("Logout clears both cookies, revokes the refresh family, and audits the subject")
    void logoutEndsTheSessionItWasGiven() {
        Tenant tenant = newTenant("logout-family");
        JsonNode session = register(tenant, "leave1@logout.test");
        String access = session.path("access_token").asText();
        String refresh = session.path("refresh_token").asText();
        assertThat(get(tenant, access, "/api/v1/me").getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<String> out = post(tenant, access, "/api/v1/auth/logout", Map.of());
        assertThat(out.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(out.getBody()).path("status").asText()).isEqualTo("logged_out");
        assertThat(Json.tree(out.getBody()).path("cleared")).hasSize(2);
        assertThat(Json.tree(out.getBody()).path("cleared").toString())
                .contains("nexus_session").contains("nexus_csrf");

        // What a clearing cookie actually looks like off the wire: an empty value with no quotes, and both
        // expiry signals at once (Max-Age=0 and the epoch in Expires).
        List<String> cookies = out.getHeaders().get(HttpHeaders.SET_COOKIE);
        assertThat(cookies).as("the two clearing headers the response promises").hasSize(2);
        assertThat(cookies).anySatisfy(h -> assertThat(h)
                .startsWith("nexus_session=;").contains("Max-Age=0").contains("Expires=Thu, 01 Jan 1970"));
        assertThat(cookies).anySatisfy(h -> assertThat(h)
                .startsWith("nexus_csrf=;").contains("Max-Age=0").contains("Expires=Thu, 01 Jan 1970"));

        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'logout'",
                Map.of("t", tenant.id()))).isEqualTo(1);

        ResponseEntity<String> replay = post(tenant, null, "/api/v1/auth/refresh",
                Map.of("refresh_token", refresh));
        assertThat(replay.getStatusCode())
                .as("a revoked family must not mint again: %s", replay.getBody())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("The access token outlives its own logout until exp — the window §3 now states")
    void bearerSurvivesLogoutUntilItExpires() {
        Tenant tenant = newTenant("logout-window");
        JsonNode session = register(tenant, "leave2@logout.test");
        String access = session.path("access_token").asText();
        String userId = session.path("user").path("id").asText();

        assertThat(post(tenant, access, "/api/v1/auth/logout", Map.of()).getStatusCode()).isEqualTo(HttpStatus.OK);

        // Not a 401, and the walk says so out loud rather than letting the word "logout" carry it.
        ResponseEntity<String> after = get(tenant, access, "/api/v1/me");
        assertThat(after.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(after.getBody()).path("id").asText())
                .as("/me spreads the user view at the top level")
                .isEqualTo(userId);
    }

    @Test
    @DisplayName("An anonymous logout is accepted, and audits nothing, because there is no subject")
    void anonymousLogoutIsQuietlyAccepted() {
        Tenant tenant = newTenant("logout-anon");

        ResponseEntity<String> out = post(tenant, null, "/api/v1/auth/logout", Map.of());
        assertThat(out.getStatusCode()).as("no principal is not an error to log out of").isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(out.getBody()).path("status").asText()).isEqualTo("logged_out");
        assertThat(count("select count(*) from audit_logs where tenant_id = :t and action = 'logout'",
                Map.of("t", tenant.id()))).as("nothing to attribute the logout to").isZero();
    }
}
