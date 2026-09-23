package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
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
    @DisplayName("Every member write says what authorised it, and the removal shows it meant it")
    void theStatedBasisIsTheEnforcedOne() {
        // D53: `authorisation_basis` is §40's doctrine printed in a payload — "a printed field is a promise"
        // (D42) — and until now no test named it, and the removal door did not carry it at all even though it
        // checks the same permission. All three now answer the same sentence, and the last one has to prove the
        // sentence's second half by taking the grant rows with the membership row.
        UUID person = newUser(tenant, "basis-" + tag(), "consumer");
        ResponseEntity<String> added = postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "staff"),
                "basis-" + person, tenant, ownerToken);
        assertThat(added.getStatusCode()).as(body(added)).isEqualTo(HttpStatus.CREATED);
        assertThat(body(added)).contains("permission_grants")
                .contains("roles only choose which grant rows exist");

        UUID memberId = memberIdOf(person);
        assertThat(body(patch("/api/v1/merchant/members/" + memberId, Json.map("role", "manager"), tenant,
                ownerToken))).contains("permission_grants").contains("roles only choose which grant rows exist");

        ResponseEntity<String> removed = delete("/api/v1/merchant/members/" + memberId, tenant, ownerToken);
        assertThat(removed.getStatusCode()).as(body(removed)).isEqualTo(HttpStatus.OK);
        assertThat(body(removed)).contains("permission_grants")
                .contains("roles only choose which grant rows exist");
        assertThat(grants(person)).as("the access really lived in the rows the sentence names").isEmpty();
    }

    @Test
    @DisplayName("The workspace's own refusals name themselves, not just their status")
    void refusalsCarryTheirOwnCode() {
        // D55: the code is the part a client branches on. A 409 that could be "already a member" or "you are
        // the last administrator" is not an answer, and both of those exist behind this door.
        UUID person = newUser(tenant, "named-" + tag(), "consumer");
        ResponseEntity<String> added = postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "staff"),
                "first-" + person, tenant, ownerToken);
        assertThat(added.getStatusCode()).as(body(added)).isEqualTo(HttpStatus.CREATED);

        ResponseEntity<String> twice = postKey("/api/v1/merchant/members",
                Json.map("merchant_id", merchant.toString(), "user_id", person.toString(), "role", "manager"),
                "second-" + person, tenant, ownerToken);
        assertThat(twice.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(twice.getBody()).path("error").path("code").asText()).isEqualTo("member_exists");
        assertThat(Json.tree(twice.getBody()).path("error").path("details").path("role").asText())
                .as("the refusal says what is there, so the caller can change it rather than guess")
                .isEqualTo("staff");
        assertThat(Json.tree(twice.getBody()).path("error").path("details").path("member_id").asText())
                .isNotBlank();

        ResponseEntity<String> noMember = patch("/api/v1/merchant/members/" + UUID.randomUUID(),
                Json.map("role", "analyst"), tenant, ownerToken);
        assertThat(noMember.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(noMember.getBody()).path("error").path("code").asText())
                .isEqualTo("member_not_found");

        ResponseEntity<String> noKey = delete("/api/v1/merchant/api-keys/" + UUID.randomUUID()
                + "?merchant_id=" + merchant, tenant, ownerToken);
        assertThat(noKey.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(noKey.getBody()).path("error").path("code").asText())
                .as("the authoriser resolves the key's merchant before anything else, and says which link failed")
                .isEqualTo("api_key_not_found");
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
    @DisplayName("GET /me answers with the grant rows, under either spelling, and stops when access ends")
    void myWorkspacesPrintTheirGrants() {
        // `/me` used to answer `"permissions": []` for every membership. A console that trusted it rendered an
        // owner with no capabilities, and nothing about the payload said the list was a placeholder — so the
        // fiction survived a full stack of correct-looking screens. It is now the same reader the roster uses.
        JsonNode mine = Json.tree(get(tenant, ownerToken, "/api/v1/me").getBody()).path("memberships");
        assertThat(mine).as("the owner has exactly this one workspace").hasSize(1);
        assertThat(mine.get(0).path("merchant").path("id").asText()).isEqualTo(merchant.toString());
        assertThat(names(mine.get(0).path("permissions")))
                .as("what /me prints is what the table holds")
                .isEqualTo(grants(ownerId));

        // The other spelling has to be visible here too, or the two doors would disagree about one person.
        UUID person = newUser(tenant, "me-staff-" + tag(), "consumer");
        staff(tenant, merchant, person, "read_analytics");
        assertThat(names(Json.tree(get(tenant, token(tenant, person, "consumer"), "/api/v1/me").getBody())
                .path("memberships").get(0).path("permissions"))).contains("read_analytics");

        // And when the access ends, the print ends with it — the membership row staying behind on purpose.
        assertThat(patch("/api/v1/merchant/members/" + memberIdOf(person), Json.map("status", "disabled"), tenant,
                ownerToken).getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode after = Json.tree(get(tenant, token(tenant, person, "consumer"), "/api/v1/me").getBody());
        assertThat(after.path("memberships").get(0).path("status").asText()).isEqualTo("disabled");
        assertThat(names(after.path("memberships").get(0).path("permissions"))).isEmpty();
    }

    @Test
    @DisplayName("A lapsed grant opens nothing and is printed by nobody; a future one still opens")
    void anExpiredGrantOpensNothingAndIsNotPrinted() {
        UUID person = newUser(tenant, "lapsed-" + tag(), "consumer");
        staff(tenant, merchant, person, "read_analytics");
        String bearer = token(tenant, person, "consumer");
        assertThat(getRaw(tenant, bearer, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(names(Json.tree(get(tenant, bearer, "/api/v1/me").getBody()).path("memberships").get(0)
                .path("permissions"))).contains("read_analytics");

        // AGENT_CONTRACT §8 promises grants expire, and four authorisation reads carry the predicate for it —
        // while D42 left the seed writing no deadline at all, which made this the only row in the repository
        // that answers the question. A flipped comparison and a dropped `is null` arm look identical until one
        // of them is called: the first would turn every future-dated grant into a lockout, the second would
        // lock out every human in the product, and neither is reachable by a test that only ever sees nulls.
        expire(person, "read_analytics", "-1 minute");
        assertThat(getRaw(tenant, bearer, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .as("a row that has lapsed authorises nothing").isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(names(Json.tree(get(tenant, bearer, "/api/v1/me").getBody()).path("memberships").get(0)
                .path("permissions"))).as("and no door advertises an access the caller has lost")
                .doesNotContain("read_analytics");
        assertThat(names(memberNode(Json.tree(get(tenant, ownerToken,
                "/api/v1/merchant/members?merchant_id=" + merchant).getBody()), person)
                .path("permissions"))).as("the roster agrees with the authoriser, not with the surviving row")
                .doesNotContain("read_analytics");

        // Back-dating the deadline to the future has to give the access straight back, with no write and no
        // re-grant — which is what separates "the predicate rejected a lapsed row" from "the row went away".
        expire(person, "read_analytics", "+1 day");
        assertThat(getRaw(tenant, bearer, "/api/v1/merchant/customers?merchant_id=" + merchant).getStatusCode())
                .as("a grant with time left is not a lapse").isEqualTo(HttpStatus.OK);
        assertThat(names(Json.tree(get(tenant, bearer, "/api/v1/me").getBody()).path("memberships").get(0)
                .path("permissions"))).contains("read_analytics");
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

    /** A printed permission array as a list, so it can be compared with the SQL the screen claims to show. */
    private static List<String> names(JsonNode array) {
        List<String> out = new java.util.ArrayList<>();
        array.forEach(node -> out.add(node.asText()));
        return out;
    }

    /**
     * Move one grant's deadline to a relative offset, and fail if the row it aimed at was not there to aim at.
     * Both spellings a human's grant can carry are offered the update, and the sum has to be exactly one: two
     * would mean the same permission is held twice over and the test could not say which row lapsed, zero
     * would mean the assertion below had been watching a grant that never had an expiry to lose.
     */
    private void expire(UUID userId, String permission, String offset) {
        int moved = 0;
        for (String subjectType : PermissionService.HUMAN_SUBJECT_TYPES) {
            moved += jdbc.update("update permission_grants set expires_at = now() + cast(:offset as interval) "
                            + "where subject_type = :t and subject_id = :u and merchant_id = :m "
                            + "and permission = :p",
                    new MapSqlParameterSource("t", subjectType).addValue("u", userId).addValue("m", merchant)
                            .addValue("p", permission).addValue("offset", offset));
        }
        assertThat(moved).as("grant %s for %s", permission, userId).isEqualTo(1);
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
