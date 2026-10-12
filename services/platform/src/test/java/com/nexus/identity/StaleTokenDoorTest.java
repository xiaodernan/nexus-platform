package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TokenRegistry;
import com.nexus.testsupport.NexusIntegrationTest;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.test.context.ActiveProfiles;

/**
 * What a still-unexpired access token can do to an account the platform has just erased (§106, §3).
 *
 * <p>D309 closed the erasure itself and left one sentence of the contract's §3 {@code logout} row standing: the
 * access token
 * keeps working until its own {@code exp}, because no request path consults revocation state for a JWT, and
 * short expiry is the mechanism on purpose. This file does not fight that ruling — it asks what the window
 * actually reaches once the row says its owner is gone, and found two things the ruling never promised.
 *
 * <p>(1) {@code IdentityRepository.requireUserInTenant} was the lifecycle guard for every child table with no
 * tenant column of its own — preferences, favorites, saved searches, deletion requests. Its SQL selects the
 * row {@code where ... and u.status = 'active'}, and it ran through {@code TenantJdbc.crossTenant}, which
 * returns a {@code List} the caller never looked at. So the guard could not refuse anything, and two of its
 * seven HEAD call sites — {@code upsertPreference} and {@code createDeletionRequest} — carry comments written in
 * the present tense that the anchor had been verified, while four more name the table's missing tenant column
 * and lean on the same inert check. Measured on HEAD's own bytes, an erased
 * subject's stale token filed a preference, a favorite and a saved search, wiped an inferred preference, and
 * answered a second erasure with the full {@code 200} delete payload — which that controller files only after
 * its {@code deletion_requests} insert and its {@code delete_data} audit row — six writes the erasure had
 * already forbidden.
 *
 * <p>(2) {@code PATCH /api/v1/me} answered {@code 404 user_not_found} — and wrote anyway. The controller
 * updated the row, filed its {@code update_profile} audit row, and only then read the user back to build the
 * response, which is where the not-found came from. The erased row came back carrying a display name, a phone
 * number and an avatar URL: a request that told the caller nothing had happened had undone the erasure.
 *
 * <p>So the guard now reads its own result, the profile door establishes its subject before it decides the
 * subject's fate, and the erasure's update keeps a lifecycle predicate of its own so a future caller that
 * forgets the read still cannot move an erased row. The token window itself is untouched — what changed is
 * that the window can no longer write to a row the person asked to have erased.
 */
@ActiveProfiles("test")
class StaleTokenDoorTest extends NexusIntegrationTest {

    @Autowired
    TokenRegistry registry;

    @Autowired
    IdentityRepository users;

    private record Person(Tenant tenant, UUID id, String token, UUID merchant, String marker) {
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private static TenantContext context(Tenant tenant) {
        return new TenantContext(tenant.id(), tenant.slug(), "HKD", "Asia/Hong_Kong", "HK");
    }

    /** A live consumer with planted contact values, a staff membership, and an access token minted now. */
    private Person activePerson() {
        Tenant tenant = newTenant("stale");
        String marker = "stale" + tag();
        UUID id = UUID.randomUUID();
        jdbc.update("insert into users (id, tenant_id, email, phone, password_hash, display_name, avatar_url,"
                + " locale, role, status, marketing_opt_in) values (:id, :t, :email, :phone, :hash, :display,"
                + " :avatar, 'en', 'consumer', 'active', true)",
                new MapSqlParameterSource("id", id).addValue("t", tenant.id())
                        .addValue("email", marker + "@example.test").addValue("phone", "+852-90000000")
                        .addValue("hash", "bcrypt$" + marker).addValue("display", "Stale " + marker)
                        .addValue("avatar", "https://cdn.example.test/" + marker + ".png"));
        UUID merchant = newMerchant(tenant, "stale-cafe-" + tag(), "published");
        staff(tenant, merchant, id, "read_products", "write_products");
        return new Person(tenant, id, token(tenant, id, "consumer"), merchant, marker);
    }

    private void erase(Person person) {
        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, person.tenant(), person.token(),
                "/api/v1/me", null);
        assertThat(answer.getStatusCode()).as("the erase door must itself stay green, it said: %s",
                answer.getBody()).isEqualTo(HttpStatus.OK);
    }

    private JsonNode rowJson(UUID id) {
        Map<String, Object> record = row("select to_jsonb(u)::text as doc from users u where u.id = :id",
                Map.of("id", id));
        return Json.tree(String.valueOf(record.get("doc")));
    }

    private long prefs(Person person) {
        return count("select count(*) from user_preferences where user_id = :u", Map.of("u", person.id()));
    }

    private long favorites(Person person) {
        return count("select count(*) from favorites where user_id = :u", Map.of("u", person.id()));
    }

    private long searches(Person person) {
        return count("select count(*) from saved_searches where user_id = :u", Map.of("u", person.id()));
    }

    private long deletionRows(Person person) {
        return count("select count(*) from deletion_requests where user_id = :u", Map.of("u", person.id()));
    }

    private long auditRows(Person person, String action) {
        return count("select count(*) from audit_logs where action = :a and actor_id = :u",
                Map.of("a", action, "u", person.id()));
    }

    private void plantPreference(Person person, String key, String source) {
        jdbc.update("insert into user_preferences (user_id, kind, key, value, source) values (:u, 'food', :key,"
                        + " cast(:value as jsonb), :source)",
                new MapSqlParameterSource("u", person.id()).addValue("key", key)
                        .addValue("value", Json.write(Json.map("email", person.marker() + "@example.test")))
                        .addValue("source", source));
    }

    // ---------------------------------------------------------------- the door

    @Test
    @DisplayName("The lifecycle guard reads its own result: an erased anchor throws, a live one passes")
    void theGuardActuallyLooks() {
        Person live = activePerson();
        assertThatCode(() -> users.requireUserInTenant(context(live.tenant()), live.id()))
                .as("a live account must pass its own guard, or this door is a wall").doesNotThrowAnyException();

        Person gone = activePerson();
        erase(gone);
        assertThatThrownBy(() -> users.requireUserInTenant(context(gone.tenant()), gone.id()))
                .as("requireUserInTenant selects the row where status = 'active', so it must refuse when that"
                        + " select returns nothing — the erased account is exactly the row it exists to refuse")
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.code())
                        .as("and it refuses with the absent-account code the read uses, not an internal one")
                        .isEqualTo("user_not_found"));
    }

    @Test
    @DisplayName("An erased subject's still-valid token files no preference")
    void preferenceWriteIsRefusedAndFilesNothing() {
        Person person = activePerson();
        erase(person);
        long before = prefs(person);

        ResponseEntity<String> answer = post(person.tenant(), person.token(), "/api/v1/me/preferences",
                Json.map("kind", "food", "key", "after-erase", "value", Json.map("note", "resurrected")));

        assertThat(answer.getStatusCode()).as("a preference filed for an erased account re-opens the erasure;"
                + " the door said: %s", answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(answer.getBody()).path("error").path("code").asText())
                .as("the refusal names the absent account, which is what the guard's select found")
                .isEqualTo("user_not_found");
        assertThat(prefs(person)).as("no user_preferences row may appear for the erased id").isEqualTo(before);
    }

    @Test
    @DisplayName("An erased subject's still-valid token saves no favorite")
    void favoriteWriteIsRefusedAndFilesNothing() {
        Person person = activePerson();
        erase(person);
        long before = favorites(person);

        ResponseEntity<String> answer = post(person.tenant(), person.token(), "/api/v1/me/favorites",
                Json.map("subject_type", "merchant", "subject_id", person.merchant().toString()));

        assertThat(answer.getStatusCode()).as("a favorite row for an erased account is a write the erasure"
                + " already forbade; the door said: %s", answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(favorites(person)).as("no favorites row may appear for the erased id").isEqualTo(before);
    }

    @Test
    @DisplayName("An erased subject's still-valid token saves no search")
    void savedSearchIsRefusedAndFilesNothing() {
        Person person = activePerson();
        erase(person);
        long before = searches(person);

        ResponseEntity<String> answer = post(person.tenant(), person.token(), "/api/v1/me/saved-searches",
                Json.map("name", "ghost", "query", "quiet dinner"));

        assertThat(answer.getStatusCode()).as("the saved_searches insert runs through the same anchor guard;"
                + " the door said: %s", answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(searches(person)).as("no saved_searches row may appear for the erased id").isEqualTo(before);
    }

    @Test
    @DisplayName("An erased subject's reset deletes nothing and answers absent")
    void resetPersonalizationIsRefusedAndTakesNothing() {
        Person person = activePerson();
        plantPreference(person, "inferred-before", "inferred");
        long before = prefs(person);
        erase(person);

        ResponseEntity<String> answer = post(person.tenant(), person.token(),
                "/api/v1/me/personalization/reset", Json.map());

        assertThat(answer.getStatusCode()).as("deleteInferredPreferences runs through the same anchor guard;"
                + " the door said: %s", answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(prefs(person)).as("the inferred row planted before the erasure stays: a refused request"
                + " must be inert, not half-applied").isEqualTo(before);
    }

    @Test
    @DisplayName("PATCH /me by an erased subject answers absent and writes nothing, even through the repository")
    void profileWriteCannotResurrectAnErasedRow() {
        Person person = activePerson();
        erase(person);
        JsonNode afterErase = rowJson(person.id);
        long auditBefore = auditRows(person, "update_profile");

        ResponseEntity<String> answer = exchange(HttpMethod.PATCH, person.tenant(), person.token(),
                "/api/v1/me", Json.map("display_name", "Resurrected " + tag(), "phone", "+852-91111111",
                        "avatar_url", "https://cdn.example.test/resurrected.png"));

        assertThat(answer.getStatusCode()).as("the profile door answers what it did; it said: %s",
                answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        JsonNode afterAttempt = rowJson(person.id);
        assertThat(afterAttempt.path("display_name").asText()).as("the erase set display_name to 'Deleted"
                + " user'; a 404 must not put a name back").isEqualTo(afterErase.path("display_name").asText());
        assertThat(afterAttempt.path("phone").isNull())
                .as("phone was erased to null; a refused PATCH must not re-file it").isTrue();
        assertThat(afterAttempt.path("avatar_url").isNull())
                .as("avatar_url was erased to null; a refused PATCH must not re-file it").isTrue();
        assertThat(auditRows(person, "update_profile")).as("no update_profile audit row for a request that"
                + " wrote nothing").isEqualTo(auditBefore);

        // The statement's own lifecycle predicate, witnessed apart from the controller's read: a future
        // caller that forgets to check the subject must still be unable to move an erased row.
        int written = users.updateProfile(context(person.tenant()), person.id(), "Through the repository",
                null, null, null, "+852-92222222");
        assertThat(written).as("updateProfile's own WHERE must write 0 rows for an erased subject — the"
                + " second layer has to catch what the first one catches").isZero();
        assertThat(rowJson(person.id).path("display_name").asText())
                .as("and the row must say nothing changed").isEqualTo(afterErase.path("display_name").asText());
    }

    @Test
    @DisplayName("A second DELETE /me is refused and files neither a job row nor an audit row")
    void theSecondEraseDoesNothing() {
        Person person = activePerson();
        erase(person);
        long jobs = deletionRows(person);
        long audits = auditRows(person, "delete_data");

        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, person.tenant(), person.token(),
                "/api/v1/me", null);

        assertThat(answer.getStatusCode()).as("the account is already gone, and D5 says an unreadable thing"
                + " reads absent; the second erase said: %s", answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(deletionRows(person)).as("one erasure files exactly one deletion_request row; a replay"
                + " that files a second hands the §106 retention job a duplicate").isEqualTo(jobs);
        assertThat(auditRows(person, "delete_data")).as("and no second delete_data audit row either")
                .isEqualTo(audits);
    }

    @Test
    @DisplayName("The erasure revokes nothing and the refresh exchange dies on the account read, not on a denylist")
    void theSessionFamilySurvivesTheEraseAndTheExchangeStillRefuses() {
        Person person = activePerson();
        String sid = "sid-" + person.id();
        String jti = UUID.randomUUID().toString();
        String refresh = jwt.sign(jwt.claims("refresh", person.id().toString(),
                person.tenant().id().toString(), sid, jti, Map.of("role", "consumer")));
        registry.registerFamily(sid, jti, Duration.ofDays(30));

        erase(person);
        ResponseEntity<String> answer = post(person.tenant(), null, "/api/v1/auth/refresh",
                Json.map("refresh_token", refresh));

        assertThat(answer.getStatusCode()).as("the exchange must refuse; it said: %s", answer.getBody())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(answer.getBody()).path("error").path("code").asText())
                .as("refused because the account read is gone, not because anything was revoked — a"
                    + " refresh_reuse_detected here would claim a replay the erasure never filed")
                .isEqualTo("user_not_found");
        assertThat(Json.tree(answer.getBody()).has("access_token")).as("no new credential for an erased"
                + " account").isFalse();
        // Pinned, not blessed: the erase's declared scope is the users row and its identity links, so the
        // family entry stays in the store while being inert, because the read behind the exchange dies.
        // A unit that later severs families owns this row.
        assertThat(registry.familyKnown(sid)).as("DELETE /me files no session revocation at all — the"
                + " family survives in the store and only the account read keeps it from minting").isTrue();
    }

    @Test
    @DisplayName("Control: the same doors stay open for a live account")
    void theLiveAccountPassesEveryDoorThisFileRefusesTheDeadOne() {
        Person person = activePerson();

        assertThat(prefs(person)).as("before-image: this person has no preferences yet").isEqualTo(0L);
        plantPreference(person, "declared-live", "declared");
        assertThat(prefs(person)).as("a live account files its own preference").isEqualTo(1L);

        ResponseEntity<String> profile = exchange(HttpMethod.PATCH, person.tenant(), person.token(),
                "/api/v1/me", Json.map("display_name", "Renewed " + tag()));
        assertThat(profile.getStatusCode()).as("a live PATCH /me said: %s", profile.getBody())
                .isEqualTo(HttpStatus.OK);
        assertThat(rowJson(person.id).path("display_name").asText()).startsWith("Renewed ");

        assertThat(post(person.tenant(), person.token(), "/api/v1/me/favorites",
                Json.map("subject_type", "merchant", "subject_id", person.merchant().toString()))
                .getStatusCode()).as("a live favorite write").isEqualTo(HttpStatus.OK);
        assertThat(favorites(person)).isEqualTo(1L);

        assertThat(post(person.tenant(), person.token(), "/api/v1/me/saved-searches",
                Json.map("name", "live", "query", "quiet dinner")).getStatusCode())
                .as("a live saved search").isEqualTo(HttpStatus.OK);
        assertThat(searches(person)).isEqualTo(1L);

        assertThat(post(person.tenant(), person.token(), "/api/v1/me/personalization/reset", Json.map())
                .getStatusCode()).as("a live reset").isEqualTo(HttpStatus.OK);
        assertThat(prefs(person)).as("the reset wipes inferred memory and keeps the declared row (§33)")
                .isEqualTo(1L);

        erase(person);
        assertThat(deletionRows(person)).as("the live account's own erase filed its job row").isEqualTo(1L);
    }
}
