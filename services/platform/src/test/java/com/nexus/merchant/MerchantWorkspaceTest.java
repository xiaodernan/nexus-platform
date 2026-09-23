package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * The workspace doors of API_CONTRACT §5 — and the one thing every route here has to get right: a membership
 * row is a record, while {@code permission_grants} is the access.
 *
 * <p>{@code permission_grants} has no foreign key to {@code merchant_users}, so nothing in the schema notices
 * a grant that outlives the member it was written for. These tests therefore assert on the grant rows in SQL,
 * not only on the HTTP status: a role change that returned 200 and left the old rows in place would look
 * correct on the screen and be wrong in the authoriser. Where a route can be checked against an unrelated
 * one, it is — promoting a member is only real if a call that needs the new permission starts succeeding.
 */
class MerchantWorkspaceTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID ownerId;
    private String ownerToken;
    private UUID merchant;
    private String slug;

    /**
     * `idempotency_keys` is keyed by the literal string and is not cleaned between tests, so a hard-coded key
     * is a coin toss against an earlier run's owner. Every key here carries this run's nonce; the one pair
     * that must repeat repeats within a test, not across runs.
     */
    private final String nonce = tag();

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("workspace");
        slug = "ws-" + tag();
        merchant = newMerchant(tenant, slug, "published");
        ownerId = newUser(tenant, "owner-" + tag(), "consumer");
        own(merchant, ownerId);
        ownerToken = token(tenant, ownerId, "consumer");
    }

    // ---- members ---------------------------------------------------------

    @Test
    @DisplayName("Adding a member writes the grant rows that authorise them, and the roster reports them")
    void addingAMemberWritesTheAccessNotJustTheRow() {
        UUID person = newUser(tenant, "staff-" + tag(), "consumer");
        ResponseEntity<String> res = postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "staff"),
                "add-" + person, tenant, ownerToken);

        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.CREATED);
        JsonNode out = Json.tree(res.getBody());
        assertThat(out.path("permissions").toString()).contains("write_products");
        assertThat(count("select count(*) from merchant_users where merchant_id = :m and user_id = :u",
                Map.of("m", merchant, "u", person))).isEqualTo(1);
        assertThat(grants(person)).contains("write_products", "read_orders");
        assertThat(grants(person)).doesNotContain("read_analytics", "admin_members");

        JsonNode roster = Json.tree(get(tenant, ownerToken, "/api/v1/merchant/members?merchant_id="
                + merchant).getBody());
        assertThat(roster.path("members")).hasSize(2);
        assertThat(roster.path("count").asInt()).isEqualTo(2);
        assertThat(memberNode(roster, person).path("permissions").toString()).contains("write_products");
        // The role preset the grants came from is printed, so the screen does not have to remember it.
        assertThat(roster.path("roles").path("staff").toString()).contains("write_products");
    }

    @Test
    @DisplayName("A role change and a disable move the real access, checked through a route neither owns")
    void changingARoleChangesWhatTheCallerCanCall() {
        UUID person = newUser(tenant, "moving-" + tag(), "consumer");
        assertThat(postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "staff"),
                "add-" + person, tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String theirToken = token(tenant, person, "consumer");

        // staff has no read_analytics, so the customers screen (com.nexus.growth, unrelated route) is refused.
        assertThat(getRaw(tenant, theirToken, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        UUID memberId = memberIdOf(person);
        assertThat(patch("/api/v1/merchant/members/" + memberId, Json.map("role", "manager"), tenant, ownerToken)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(grants(person)).contains("read_analytics");
        assertThat(getRaw(tenant, theirToken, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // Demotion has to take something away, not only add.
        JsonNode demoted = Json.tree(patch("/api/v1/merchant/members/" + memberId, Json.map("role", "analyst"),
                tenant, ownerToken).getBody());
        assertThat(demoted.path("grants_removed").toString()).contains("write_products");
        assertThat(grants(person)).doesNotContain("write_products", "send_message");
        assertThat(grants(person)).contains("read_analytics");

        // Disabling empties the grants and keeps the row: the person is still on the roster, and can still
        // read nothing.
        assertThat(patch("/api/v1/merchant/members/" + memberId, Json.map("status", "disabled"), tenant,
                ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(grants(person)).isEmpty();
        assertThat(count("select count(*) from merchant_users where id = :id", Map.of("id", memberId)))
                .isEqualTo(1);
        assertThat(getRaw(tenant, theirToken, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    @DisplayName("The last owner cannot be demoted, disabled or removed — until a second admin exists")
    void theWorkspaceCannotBeLockedShut() {
        ResponseEntity<String> demote = patch("/api/v1/merchant/members/" + memberIdOf(ownerId),
                Json.map("role", "staff"), tenant, ownerToken);
        assertThat(demote.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(demote.getBody()).path("error").path("code").asText()).isEqualTo("last_admin");

        assertThat(patch("/api/v1/merchant/members/" + memberIdOf(ownerId), Json.map("status", "disabled"),
                tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(delete("/api/v1/merchant/members/" + memberIdOf(ownerId), tenant, ownerToken).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        // Refusing must not have written anything.
        assertThat(grants(ownerId)).contains("admin_members");

        UUID second = newUser(tenant, "second-" + tag(), "consumer");
        assertThat(postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", second.toString(), "role", "admin"),
                "add-" + second, tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(grants(second)).contains("admin_members");

        // Two people can administer it, so one of them may now step down.
        assertThat(delete("/api/v1/merchant/members/" + memberIdOf(ownerId), tenant, ownerToken).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(count("select count(*) from merchant_users where id = :id", Map.of("id", memberIdOf(second))))
                .isEqualTo(1);
    }

    @Test
    @DisplayName("Removing a member deletes their grants too — the schema would not do it for us")
    void removalTakesTheAccessWithTheRow() {
        UUID person = newUser(tenant, "leaving-" + tag(), "consumer");
        postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "manager"),
                "add-" + person, tenant, ownerToken);
        assertThat(grants(person)).isNotEmpty();
        String theirToken = token(tenant, person, "consumer");
        assertThat(getRaw(tenant, theirToken, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        ResponseEntity<String> gone = delete("/api/v1/merchant/members/" + memberIdOf(person), tenant, ownerToken);
        assertThat(gone.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(gone.getBody()).path("grants_revoked").asInt())
                .isEqualTo(MerchantPermissions.MANAGER.size());
        assertThat(count("select count(*) from merchant_users where merchant_id = :m and user_id = :u",
                Map.of("m", merchant, "u", person))).isZero();
        assertThat(grants(person)).isEmpty();
        assertThat(getRaw(tenant, theirToken, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    @DisplayName("A roster reports grants filed under either spelling, because the authoriser accepts both")
    void rosterReadsBothGrantSpellings() {
        UUID person = newUser(tenant, "legacy-" + tag(), "consumer");
        // The harness fixture files grants as merchant_user — the spelling the interceptor also accepts.
        staff(tenant, merchant, person, "read_analytics");
        JsonNode roster = Json.tree(get(tenant, ownerToken, "/api/v1/merchant/members?merchant_id=" + merchant)
                .getBody());
        assertThat(memberNode(roster, person).path("permissions").toString()).contains("read_analytics");
        assertThat(getRaw(tenant, token(tenant, person, "consumer"),
                "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode()).isEqualTo(HttpStatus.OK);

        // And disabling that member has to reach through to that spelling, not just the one this class writes.
        assertThat(patch("/api/v1/merchant/members/" + memberIdOf(person), Json.map("status", "disabled"), tenant,
                ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(count("select count(*) from permission_grants where merchant_id = :m and subject_id = :u",
                Map.of("m", merchant, "u", person))).isZero();
    }

    @Test
    @DisplayName("The doors are RBAC and tenant scoped: staff is refused, another market gets 404")
    void doorsAreAuthorisedAndTenantScoped() {
        UUID person = newUser(tenant, "peeker-" + tag(), "consumer");
        staff(tenant, merchant, person, "read_products");
        assertThat(getRaw(tenant, token(tenant, person, "consumer"),
                "/api/v1/merchant/members?merchant_id=" + merchant).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(get(tenant, null, "/api/v1/merchant/members?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        Tenant other = newTenant("workspace-other");
        UUID otherOwner = newUser(other, "other-owner-" + tag(), "consumer");
        own(merchant(other, "other-" + tag()), otherOwner);
        ResponseEntity<String> cross = getRaw(other, token(other, otherOwner, "consumer"),
                "/api/v1/merchant/members?merchant_id=" + merchant);
        assertThat(cross.getStatusCode()).as("a foreign merchant reads as absent, not as forbidden")
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("A bad role, a missing key and a double submit each fail in their own way")
    void writesAreGuarded() {
        UUID person = newUser(tenant, "guard-" + tag(), "consumer");
        ResponseEntity<String> bad = postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "superuser"),
                "g-" + person, tenant, ownerToken);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(bad.getBody()).path("error").path("details").path("allowed").toString())
                .contains("marketing");

        assertThat(post(tenant, ownerToken, "/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "staff"))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A person from another tenant is not a person here: 404, and no membership row behind it.
        Tenant other = newTenant("workspace-stranger");
        UUID stranger = newUser(other, "stranger-" + tag(), "consumer");
        assertThat(postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", stranger.toString(), "role", "staff"),
                "s-" + stranger, tenant, ownerToken).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(count("select count(*) from merchant_users where user_id = :u", Map.of("u", stranger)))
                .isZero();

        // One tap, one membership: the key is what makes the retry land on the same row.
        Map<String, Object> good = Json.map("merchant_id", merchant.toString(), "user_id", person.toString(),
                "role", "staff");
        assertThat(postKey("/api/v1/merchant/members", good, "same-" + nonce, tenant, ownerToken).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        ResponseEntity<String> retry = postKey("/api/v1/merchant/members", good, "same-" + nonce, tenant, ownerToken);
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(Json.tree(retry.getBody()).path("idempotent_replay").asBoolean())
                .as("the retry is answered from the stored response, not by doing the write again").isTrue();
        assertThat(count("select count(*) from merchant_users where merchant_id = :m and user_id = :u",
                Map.of("m", merchant, "u", person))).isEqualTo(1);
        // And one audit row. Serving the reply from the store is only worth something if nothing downstream
        // of the write ran either — a trail that says "member added" twice for one tap is a trail no one can
        // read, and §127 is about the trail.
        assertThat(count("""
                select count(*) from audit_logs where action = 'add_workspace_member' and merchant_id = :m
                  and actor_id = :a
                """, Map.of("m", merchant, "a", ownerId))).isEqualTo(1);
        // A second tap under a new key is a duplicate intent, and says so rather than silently re-roling.
        assertThat(postKey("/api/v1/merchant/members", good, "other-" + nonce, tenant, ownerToken).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
    }

    // ---- api keys --------------------------------------------------------

    @Test
    @DisplayName("A key's secret is shown once, its scopes are grant rows, and revoking deletes both")
    void keysAreHashedScopedAndRevocable() {
        ResponseEntity<String> res = postKey("/api/v1/merchant/api-keys",
                Json.map("merchant_id", merchant.toString(), "name", "kitchen tablet",
                        "scopes", List.of("read_products", "read_orders")),
                "k-" + nonce, tenant, ownerToken);
        assertThat(res.getStatusCode()).as(body(res)).isEqualTo(HttpStatus.CREATED);
        JsonNode out = Json.tree(res.getBody());
        String secret = out.path("api_key").asText();
        assertThat(secret).startsWith("nx_live_");
        String keyId = out.path("api_key_id").asText();

        Map<String, Object> stored = row("select key_hash, prefix, scopes from api_keys where id = :id",
                Map.of("id", UUID.fromString(keyId)));
        assertThat(String.valueOf(stored.get("key_hash"))).isNotEqualTo(secret);
        assertThat(secret).startsWith(String.valueOf(stored.get("prefix")));

        assertThat(count("""
                select count(*) from permission_grants where subject_type = 'api_key' and subject_id = :id
                """, Map.of("id", UUID.fromString(keyId)))).isEqualTo(2);

        // The list must not leak the secret — it cannot, but a projection bug would, so say it out loud.
        ResponseEntity<String> list = getRaw(tenant, ownerToken, "/api/v1/merchant/api-keys?merchant_id="
                + merchant);
        assertThat(list.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list.getBody()).doesNotContain(secret);
        assertThat(Json.tree(list.getBody()).path("api_keys").get(0).path("prefix").asText())
                .isEqualTo(stored.get("prefix"));
        assertThat(Json.tree(list.getBody()).path("allowed_scopes").toString()).contains("read_products");

        assertThat(delete("/api/v1/merchant/api-keys/" + keyId, tenant, ownerToken).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(count("select count(*) from permission_grants where subject_type = 'api_key' and subject_id = :id",
                Map.of("id", UUID.fromString(keyId)))).isZero();
        assertThat(row("select revoked_at from api_keys where id = :id", Map.of("id", UUID.fromString(keyId)))
                .get("revoked_at")).isNotNull();
    }

    @Test
    @DisplayName("A key needs a name and a scope this platform can actually honour")
    void keysRefuseWhatTheyCannotGrant() {
        ResponseEntity<String> scope = postKey("/api/v1/merchant/api-keys",
                Json.map("merchant_id", merchant.toString(), "name", "no such door",
                        "scopes", List.of("refund_payment")),
                "kbad-" + nonce, tenant, ownerToken);
        assertThat(scope.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(count("select count(*) from api_keys where name = 'no such door'", Map.of())).isZero();

        assertThat(postKey("/api/v1/merchant/api-keys", Json.map("merchant_id", merchant.toString(),
                "scopes", List.of("read_products")), "knoname-" + nonce, tenant, ownerToken).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ---- ai agent --------------------------------------------------------

    @Test
    @DisplayName("The AI switch writes the one column that exists, and refuses to pretend about the rest")
    void aiSwitchStoresOnlyWhatTheSchemaCarries() {
        ResponseEntity<String> on = postKey("/api/v1/merchant/ai-agent/config",
                Json.map("merchant_id", merchant.toString(), "enabled", true), "ai1-" + nonce, tenant, ownerToken);
        assertThat(on.getStatusCode()).as(body(on)).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(on.getBody()).path("ai_agent_enabled").asBoolean()).isTrue();
        assertThat(Json.tree(on.getBody()).path("before").path("ai_agent_enabled").asBoolean()).isFalse();
        assertThat(Json.tree(on.getBody()).path("scope_note").asText()).contains("only AI setting");
        assertThat((Boolean) row("select ai_agent_enabled from merchants where id = :id", Map.of("id", merchant))
                .get("ai_agent_enabled")).isTrue();
        assertThat(count("select count(*) from audit_logs where action = 'configure_ai_agent' and merchant_id = :m",
                Map.of("m", merchant))).isEqualTo(1);

        // configure_ai is a grant, not a membership: staff is refused even though they can write the menu.
        UUID person = newUser(tenant, "nostaff-" + tag(), "consumer");
        staff(tenant, merchant, person, "write_products");
        assertThat(postKey("/api/v1/merchant/ai-agent/config",
                Json.map("merchant_id", merchant.toString(), "enabled", false), "ai2-" + nonce, tenant,
                token(tenant, person, "consumer")).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        assertThat(postKey("/api/v1/merchant/ai-agent/config",
                Json.map("merchant_id", merchant.toString(), "enabled", "yes"), "ai3-" + nonce, tenant, ownerToken)
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    // ---------------------------------------------------------------- fixtures

    private UUID own(UUID merchantId, UUID userId) {
        jdbc.update("insert into merchant_users (merchant_id, user_id, role, status) values (:m, :u, 'owner', "
                        + "'active')",
                new MapSqlParameterSource("m", merchantId).addValue("u", userId));
        for (String permission : MerchantPermissions.OWNER) {
            jdbc.update("insert into permission_grants (subject_type, subject_id, merchant_id, permission, "
                            + "granted_by) values ('user', :u, :m, :p, :u)",
                    new MapSqlParameterSource("u", userId).addValue("m", merchantId).addValue("p", permission));
        }
        return userId;
    }

    private UUID merchant(Tenant t, String newSlug) {
        return newMerchant(t, newSlug, "published");
    }

    private List<String> grants(UUID userId) {
        return jdbc.getJdbcOperations().queryForList("""
                select permission from permission_grants
                where merchant_id = ? and subject_id = ? order by permission
                """, String.class, merchant, userId);
    }

    private UUID memberIdOf(UUID userId) {
        return (UUID) row("select id from merchant_users where merchant_id = :m and user_id = :u",
                Map.of("m", merchant, "u", userId)).get("id");
    }

    private JsonNode memberNode(JsonNode roster, UUID userId) {
        for (JsonNode member : roster.path("members")) {
            if (userId.toString().equals(member.path("user_id").asText())) {
                return member;
            }
        }
        throw new AssertionError("user " + userId + " is not on the roster " + roster);
    }

    private ResponseEntity<String> postKey(String path, Object body, String key, Tenant t, String bearer) {
        HttpHeaders headers = json(t, bearer);
        headers.add("Idempotency-Key", key);
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.POST, new HttpEntity<>(body, headers),
                String.class);
    }

    private ResponseEntity<String> patch(String path, Object body, Tenant t, String bearer) {
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.PATCH,
                new HttpEntity<>(body, json(t, bearer)), String.class);
    }

    private ResponseEntity<String> delete(String path, Tenant t, String bearer) {
        return http.exchange(java.net.URI.create(url(path)), HttpMethod.DELETE,
                new HttpEntity<>(json(t, bearer)), String.class);
    }

    private static String body(ResponseEntity<String> res) {
        return String.valueOf(res.getBody());
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }
}
