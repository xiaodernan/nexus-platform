package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Arrays;
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
 * The §106 request ledger: what {@code deletion_requests} says about a deletion the platform itself completed.
 *
 * <p>The table's own DDL declares a {@code kind} vocabulary of {@code account|memory|personalization|export}, a
 * {@code status} that defaults to {@code 'pending'}, and a {@code completed_at} column. At the parent of this
 * file exactly one production call site filed a row — the {@code DELETE /me} door, with kind {@code account} —
 * and nothing in {@code services/platform/src/main} ever wrote {@code status} or {@code completed_at}: the insert
 * spelled {@code 'pending'} inside its own VALUES list, so the two columns had one value each across the whole
 * build no matter what happened to the request, and the {@code personalization} member of the vocabulary had no
 * door behind it even though {@code POST /me/personalization/reset} deletes the inferred preferences of exactly
 * that name and files no request at all. The person's own export therefore could never show a personalization
 * deletion having been requested, and the one request it did show stayed {@code 'pending'} forever after the
 * platform had done everything it was ever going to do about it.
 *
 * <p>These cases pin the ledger to the act: a request whose deletion the platform performed inside the same
 * request is filed as completed with its completion moment set, and a request that hands work to the retention
 * sweeper stays pending until the sweeper runs. {@code docs/TRACEABILITY.md}'s requirement 100 row now has a
 * real job behind it: {@code RetentionSweeper}. A test that pins "forever pending" would be a false regression
 * assertion of the exact thing the retention workflow is supposed to fix — design, not a bug.
 */
@ActiveProfiles("test")
class DeletionRequestLedgerDoorTest extends NexusIntegrationTest {

    @Autowired
    IdentityRepository users;

    /** The new sweep class, constructed inline against the same jdbc template this test drives. */
    private RetentionSweeper sweeper() {
        return new RetentionSweeper(new com.nexus.platform.TenantJdbc(jdbc));
    }

    private record Person(Tenant tenant, UUID id, String token) {
    }

    /** One row of the ledger as the table holds it: its state, what it says it removed, and whether it says when. */
    private record Filed(String status, JsonNode payload, boolean hasCompletion) {
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private static TenantContext context(Tenant tenant) {
        return new TenantContext(tenant.id(), tenant.slug(), "HKD", "Asia/Hong_Kong", "HK");
    }

    private Person consumer() {
        Tenant tenant = newTenant("ledger");
        UUID id = newUser(tenant, "ledger" + tag(), "consumer");
        return new Person(tenant, id, token(tenant, id, "consumer"));
    }

    private void plant(Person person, String key, String source) {
        jdbc.update("insert into user_preferences (user_id, kind, key, value, source) values (:u, 'food', :key,"
                        + " cast(:value as jsonb), :source)",
                new MapSqlParameterSource("u", person.id()).addValue("key", key)
                        .addValue("value", Json.write(Json.map("note", "preference " + key)))
                        .addValue("source", source));
    }

    private long requests(Person person, String kind) {
        return count("select count(*) from deletion_requests where user_id = :u and kind = :k",
                Map.of("u", person.id(), "k", kind));
    }

    /**
     * The row a kind has, read field by field. Every caller asserts {@link #requests} names exactly one first, so
     * an absent kind is refused by the count claim before this read runs, rather than by an empty-result throw.
     */
    private Filed request(Person person, String kind) {
        Map<String, Object> row = row("select d.status, d.payload::text as payload, d.completed_at"
                        + " from deletion_requests d where d.user_id = :u and d.kind = :k",
                Map.of("u", person.id(), "k", kind));
        return new Filed((String) row.get("status"), Json.tree(String.valueOf(row.get("payload"))),
                row.get("completed_at") != null);
    }

    private void reset(Person person) {
        ResponseEntity<String> answer = post(person.tenant(), person.token(),
                "/api/v1/me/personalization/reset", Json.map());
        assertThat(answer.getStatusCode()).as("the reset door itself must stay green; it said: %s",
                answer.getBody()).isEqualTo(HttpStatus.OK);
    }

    private void erase(Person person) {
        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, person.tenant(), person.token(),
                "/api/v1/me", null);
        assertThat(answer.getStatusCode()).as("the erase door itself must stay green; it said: %s",
                answer.getBody()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("A personalization reset files the request for the deletion it just made, as completed")
    void resetFilesOneCompletedPersonalizationRequest() {
        Person person = consumer();
        plant(person, "inferred-a", "inferred");
        plant(person, "inferred-b", "inferred");
        plant(person, "declared-a", "declared");

        ResponseEntity<String> answer = post(person.tenant(), person.token(),
                "/api/v1/me/personalization/reset", Json.map());
        assertThat(answer.getStatusCode()).as("the reset door itself must stay green; it said: %s",
                answer.getBody()).isEqualTo(HttpStatus.OK);
        int removed = Json.tree(answer.getBody()).path("removed_inferred_preferences").asInt();
        assertThat(removed).as("the door takes the two inferred rows and keeps the declared one").isEqualTo(2);

        assertThat(requests(person, "personalization"))
                .as("the deletion the platform performed inside this request belongs in its own ledger — the"
                        + " table's kind vocabulary names this kind and this is the door that performs it")
                .isEqualTo(1);
        Filed filed = request(person, "personalization");
        assertThat(filed.status())
                .as("a request whose work is already done may not read as one still waiting").isEqualTo("completed");
        assertThat(filed.hasCompletion())
                .as("the status claims a completion moment, so the column that names it must hold one").isTrue();
        assertThat(filed.payload().path("removed_inferred").asInt(-1))
                .as("the row says what was actually removed, and the number is the one the response just"
                        + " answered, not a second copy of it: payload was %s", filed.payload()).isEqualTo(removed);
    }

    @Test
    @DisplayName("A reset that removes nothing still files the request, recording a removal of zero")
    void resetWithNothingInferredStillFilesTheRequest() {
        Person person = consumer();
        plant(person, "declared-only", "declared");

        ResponseEntity<String> answer = post(person.tenant(), person.token(),
                "/api/v1/me/personalization/reset", Json.map());
        assertThat(answer.getStatusCode()).as("the door said: %s", answer.getBody()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(answer.getBody()).path("removed_inferred_preferences").asInt())
                .as("no inferred row exists, so nothing is taken").isZero();

        assertThat(requests(person, "personalization"))
                .as("the request is filed because the person made it, not because it happened to delete rows — a"
                        + " ledger that only records non-empty outcomes cannot tell a no-op apart from a door"
                        + " nobody called")
                .isEqualTo(1);
        assertThat(request(person, "personalization").payload().path("removed_inferred").asInt(-1))
                .as("and the row records the zero it removed").isZero();
    }

    @Test
    @DisplayName("The retention sweep wipes the contact/payload copies and deletes saved searches")
    void theRetentionSweepActuallySweepsTheCopies() {
        Tenant tenant = newTenant("sweeper");
        UUID merchant = newMerchant(tenant, "sweeper-merchant", "published");
        UUID personId = newUser(tenant, "sweeper-" + tag(), "consumer");
        String contact = Json.write(Json.map("phone", "+85260001234", "email", "sweeper@example.test"));

        // Plant the rows: one reservation, one order, one notification, one saved search — all owned by this user.
        jdbc.update("""
                insert into reservations (tenant_id, merchant_id, user_id, code, offering_id, contact, starts_at, status)
                values (:t, :m, :u, :code, null, cast(:c as jsonb), now() + interval '1 day', 'pending')
                """,
                new MapSqlParameterSource("t", tenant.id()).addValue("m", merchant)
                        .addValue("u", personId).addValue("c", contact).addValue("code", "PROBE-" + tag()));
        jdbc.update("""
                insert into orders (tenant_id, merchant_id, user_id, code, contact, currency, total, status)
                values (:t, :m, :u, :code, cast(:c as jsonb), 'HKD', 100.00, 'created')
                """,
                new MapSqlParameterSource("t", tenant.id()).addValue("m", merchant)
                        .addValue("u", personId).addValue("c", contact).addValue("code", "PROBE-" + tag()));
        jdbc.update("""
                insert into notifications (tenant_id, audience, user_id, merchant_id, channel, template,
                                           payload, status)
                values (:t, 'consumer', :u, :m, 'in_app', 'probe', cast(:c as jsonb), 'pending')
                """,
                new MapSqlParameterSource("t", tenant.id()).addValue("m", merchant)
                        .addValue("u", personId).addValue("c", contact));
        jdbc.update("""
                insert into saved_searches (user_id, query, intent)
                values (:u, 'sweeper-example', '{"probe": true}'::jsonb)
                """,
                new MapSqlParameterSource("u", personId));

        // Erase (soft) the person's own row — the retention sweep must finish the job.
        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, tenant,
                token(tenant, personId, "consumer"), "/api/v1/me", null);
        assertThat(answer.getStatusCode()).isEqualTo(HttpStatus.OK);

        // Sanity: the erase does NOT touch the copies — they are exactly the rows the sweeper is for.
        assertThat(String.valueOf(row("select contact from reservations where user_id = :u",
                Map.of("u", personId)).get("contact")).replaceAll("\\s", ""))
                .as("the erase leaves the reservation's contact copy untouched").isNotEqualTo("{}");

        com.nexus.identity.RetentionSweeper.SweepReport report = sweeper().sweepPendingDeletionRequests(1000, 0);
        assertThat(report.processed()).as("at least the account row this test filed").isGreaterThanOrEqualTo(1);
        // Counting the tables the sweep reached is global on a shared test database — the useful
        // claim is the one about THIS user's rows; other users' pending rows are not this test's to assert about.
        assertThat(count("select count(*) from reservations where user_id = :u and contact != '{}'::jsonb",
                Map.of("u", personId)))
                .as("the sweeper reached this user's reservation contact copy").isZero();
        assertThat(request(personFor(tenant, personId, "consumer"), "account").status())
                .as("the erase request is the one the sweep completes").isEqualTo("completed");

        assertThat(String.valueOf(row("select contact from reservations where user_id = :u",
                Map.of("u", personId)).get("contact")).replaceAll("\\s", ""))
                .as("the reservation's contact jsonb is erased by the sweep").isEqualTo("{}");
        assertThat(String.valueOf(row("select contact from orders where user_id = :u",
                Map.of("u", personId)).get("contact")).replaceAll("\\s", ""))
                .as("the order's contact jsonb is erased by the sweep").isEqualTo("{}");
        assertThat(String.valueOf(row("select payload from notifications where user_id = :u",
                Map.of("u", personId)).get("payload")).replaceAll("\\s", ""))
                .as("the notification's payload is rewritten to an empty object by the sweep").isEqualTo("{}");
        assertThat(count("select count(*) from saved_searches where user_id = :u", Map.of("u", personId)))
                .as("saved searches are deleted entirely").isZero();
    }

    private Person personFor(Tenant tenant, UUID id, String role) {
        return new Person(tenant, id, token(tenant, id, role));
    }

    @Test
    @DisplayName("The account erase stays a pending request, and the retention sweep completes it")
    void accountEraseFilesAPendingRequestUntilTheRetentionSweepRuns() {
        Person person = consumer();

        erase(person);

        assertThat(requests(person, "account")).as("the erase door files its request").isEqualTo(1);
        Filed filed = request(person, "account");
        assertThat(filed.status()).as("the erase itself only reaches the users row and its identity links,"
                + " so the copies still sit in reservations, orders, notifications and saved searches"
                + " — the row genuinely cannot be completed at erase time").isEqualTo("pending");
        assertThat(filed.hasCompletion()).isFalse();

        // The retention workflow performs the remaining step:
        com.nexus.identity.RetentionSweeper.SweepReport report = sweeper().sweepPendingDeletionRequests(1000, 0);
        assertThat(report.processed()).as("at least this account row was swept").isGreaterThanOrEqualTo(1);
        Filed completed = request(person, "account");
        assertThat(completed.status()).isEqualTo("completed");
        assertThat(completed.hasCompletion()).isTrue();
    }

    @Test
    @DisplayName("The reset's request and the erase's request are two rows, each in its own state")
    void theTwoDoorsFileTwoRowsAndNeitherStateIsTheOthers() {
        Person person = consumer();
        plant(person, "inferred-x", "inferred");

        reset(person);
        erase(person);

        assertThat(requests(person, "personalization")).as("one reset files one personalization row").isEqualTo(1);
        assertThat(requests(person, "account")).as("and one erase files one account row — neither door writes"
                + " into the other's kind").isEqualTo(1);
        assertThat(request(person, "personalization").status()).isEqualTo("completed");
        assertThat(request(person, "account").status()).isEqualTo("pending");
    }

    @Test
    @DisplayName("The person's own export carries the personalization request with its completion moment")
    void exportShowsThePersonalizationRequestItFiled() {
        Person person = consumer();
        plant(person, "inferred-y", "inferred");

        reset(person);

        ResponseEntity<String> answer = get(person.tenant(), person.token(), "/api/v1/me/export");
        assertThat(answer.getStatusCode()).as("a live account reads its own file; it said: %s", answer.getBody())
                .isEqualTo(HttpStatus.OK);
        JsonNode payload = Json.tree(answer.getBody());
        JsonNode rows = payload.path("deletion_requests");
        assertThat(rows.isArray()).as("the section is a list: %s", rows).isTrue();
        assertThat(payload.path("section_sizes").path("deletion_requests").asInt())
                .as("and the file states the section's size, which is the array's own length")
                .isEqualTo(rows.size());
        assertThat(rows.size()).as("the reset the person made is the one row their file holds").isEqualTo(1);

        JsonNode row = rows.get(0);
        assertThat(row.path("kind").asText()).as("the file names the kind the door performed").isEqualTo("personalization");
        assertThat(row.path("status").asText()).as("and the state that performs it earned").isEqualTo("completed");
        assertThat(row.has("completed_at")).as("the section reads the column, so a completed row cannot leave"
                + " its completion moment out of the file the person asks for").isTrue();
        assertThat(row.path("completed_at").isNull())
                .as("a row whose status says completed shows the moment it says: %s", row).isFalse();
        assertThat(row.path("payload").path("removed_inferred").asInt(-1))
                .as("and the payload the file publishes is the row's own, not a re-typed copy")
                .isEqualTo(1);
    }

    @Test
    @DisplayName("The erase's own request outlives the account's ability to read it: export after erasure")
    void theErasedAccountHoldsARequestItCanNoLongerExport() {
        Person person = consumer();

        erase(person);

        assertThat(requests(person, "account")).as("the erase filed the request the retention workflow is"
                + " meant to be driven from").isEqualTo(1);
        ResponseEntity<String> answer = get(person.tenant(), person.token(), "/api/v1/me/export");
        assertThat(answer.getStatusCode()).as("and the same token can no longer read the file that would show"
                + " it: the export establishes its subject through the same lifecycle read every other /me door"
                + " uses (D310), so an erased account answers absent. Pinned as the boundary this unit inherits"
                + " rather than moved — it said: %s", answer.getBody()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(answer.getBody()).path("error").path("code").asText())
                .as("refused for the absent account, not by a section-level rule about deletion_requests")
                .isEqualTo("user_not_found");
        assertThat(request(person, "account").status())
                .as("while the pending row the person can no longer reach is still on the table, unreadable"
                        + " and unresolved").isEqualTo("pending");
    }

    /**
     * The declaration walked instead of quoted. Both doors above read one state each — the erase's pending row
     * and the reset's completed one — and a state no door reaches could still be mis-bound by the insert. This
     * case files every member {@code IdentityRepository.DeletionState} declares, through the repository seam,
     * and asks the row which pair it got, so adding a member without giving it a door cannot pass quietly.
     */
    @Test
    @DisplayName("Every state the declaration offers files exactly the pair it declares")
    void everyDeclaredStateFilesItsOwnPair() {
        IdentityRepository.DeletionState[] states = IdentityRepository.DeletionState.values();
        assertThat(states).as("the ledger's states come from one declaration, and this census walks that"
                + " declaration rather than a list typed beside it").isNotEmpty();
        assertThat(Arrays.stream(states).map(IdentityRepository.DeletionState::status).distinct().count())
                .as("no two states may share a status text, or a row could not say which of them filed it")
                .isEqualTo(states.length);

        for (IdentityRepository.DeletionState state : states) {
            Person person = consumer();
            users.createDeletionRequest(context(person.tenant()), person.id(),
                    IdentityRepository.DeletionKind.MEMORY, state, Json.map("filed_by", "the state census"));

            Filed filed = request(person, "memory");
            assertThat(filed.status()).as("%s must file the status text it declares", state)
                    .isEqualTo(state.status());
            assertThat(filed.hasCompletion())
                    .as("%s declares that its rows %s carry a completed_at, and the column must agree with the"
                            + " status on the same row — the two are bound from this one declaration, so a row"
                            + " that says one and shows the other is the defect this ledger existed to stop",
                            state, state.carriesCompletion() ? "do" : "do not")
                    .isEqualTo(state.carriesCompletion());
            assertThat(filed.payload().path("filed_by").asText())
                    .as("%s still files the payload its caller handed it", state).isEqualTo("the state census");
        }
    }
}
