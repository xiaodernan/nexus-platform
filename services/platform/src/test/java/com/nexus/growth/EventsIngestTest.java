package com.nexus.growth;

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

/**
 * {@code POST /api/v1/events} (§11/§58): append-only telemetry with batch idempotency, anonymous
 * session-only ingest and server-computed attribution. Every assertion that a number is *exact*
 * (accepted/rejected/row counts) is the point: an ingest that silently double-counts or drops is
 * the failure mode the contract names.
 */
class EventsIngestTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID user;

    @BeforeEach
    void seed() {
        tenant = newTenant("events");
        user = newUser(tenant, "tracker" + tag(), "consumer");
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private static String session() {
        return "sess-" + tag();
    }

    private ResponseEntity<String> postBatch(Tenant t, String token, String idemKey, Object body) {
        HttpHeaders headers = json(t, token);
        if (idemKey != null) {
            headers.set("Idempotency-Key", idemKey);
        }
        return http.exchange(url("/api/v1/events"), HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
    }

    private static Map<String, Object> event(String name, String sessionId) {
        return sessionId == null
                ? Map.of("name", name)
                : Map.of("name", name, "session_id", sessionId);
    }

    private long rowsFor(String sessionId) {
        return count("select count(*) from events where tenant_id = :t and session_id = :s",
                Map.of("t", tenant.id(), "s", sessionId));
    }

    // ---------------------------------------------------------------- happy path

    @Test
    @DisplayName("Anonymous batch appends rows with forced anonymous attribution and returns 202 counts")
    void anonymousBatchAppends() {
        String sid = session();
        ResponseEntity<String> res = postBatch(tenant, null, "evt-" + tag(),
                Map.of("events", List.of(event("view", sid), event("click", sid))));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("accepted").asInt()).isEqualTo(2);
        assertThat(body.path("rejected").asInt()).isZero();
        assertThat(body.path("duplicates").asInt()).isZero();
        assertThat(rowsFor(sid)).isEqualTo(2);

        Map<String, Object> row = row("select actor_type, coalesce(actor_id::text, '') as actor_id,"
                + " tenant_id::text as tenant_id from events where session_id = :s and name = 'view'",
                Map.of("s", sid));
        assertThat(row.get("actor_type")).isEqualTo("anonymous");
        assertThat(row.get("actor_id")).isEqualTo("");
        assertThat(row.get("tenant_id")).isEqualTo(tenant.id().toString());
    }

    @Test
    @DisplayName("Replaying the same Idempotency-Key returns the recorded response and appends nothing")
    void batchIsIdempotentPerKey() {
        String sid = session();
        String key = "evt-" + tag();
        Map<String, Object> batch = Map.of("events", List.of(event("search", sid), event("view", sid)));
        JsonNode first = Json.tree(postBatch(tenant, null, key, batch).getBody());
        JsonNode replay = Json.tree(postBatch(tenant, null, key, batch).getBody());
        assertThat(first.path("accepted").asInt()).isEqualTo(2);
        assertThat(replay.path("accepted").asInt()).isEqualTo(2);
        assertThat(replay.path("idempotent_replay").asBoolean()).isTrue();
        assertThat(rowsFor(sid)).isEqualTo(2);
    }

    @Test
    @DisplayName("Same event_id under a different batch key is deduped by event_id, never doubled")
    void eventIdDedupesAcrossBatches() {
        String sid = session();
        String eventId = UUID.randomUUID().toString();
        Map<String, Object> e = Map.of("event_id", eventId, "name", "view", "session_id", sid);
        JsonNode a = Json.tree(postBatch(tenant, null, "evt-a-" + tag(), Map.of("events", List.of(e))).getBody());
        JsonNode b = Json.tree(postBatch(tenant, null, "evt-b-" + tag(), Map.of("events", List.of(e))).getBody());
        assertThat(a.path("accepted").asInt()).isEqualTo(1);
        assertThat(a.path("duplicates").asInt()).isZero();
        assertThat(b.path("duplicates").asInt()).isEqualTo(1);
        assertThat(b.path("accepted").asInt()).isEqualTo(1); // the observation is durable, just not double-counted
        assertThat(rowsFor(sid)).isEqualTo(1);
    }

    @Test
    @DisplayName("A signed-in caller's actor is the principal, never whatever the payload claimed")
    void authenticatedAttributionIsServerComputed() {
        String sid = session();
        Map<String, Object> e = Map.of("name", "favorite", "session_id", sid,
                "actor_type", "anonymous", "actor_id", UUID.randomUUID().toString());
        JsonNode body = Json.tree(postBatch(tenant, token(tenant, user, "consumer"), "evt-" + tag(),
                Map.of("events", List.of(e))).getBody());
        assertThat(body.path("accepted").asInt()).isEqualTo(1);
        Map<String, Object> row = row("select actor_type, actor_id::text as actor_id from events"
                + " where session_id = :s", Map.of("s", sid));
        assertThat(row.get("actor_type")).isEqualTo("user");
        assertThat(String.valueOf(row.get("actor_id"))).isEqualTo(user.toString());
    }

    // ---------------------------------------------------------------- the subject half (D70)

    /**
     * Pins what the door does today with a caller-supplied <em>subject</em>, which is the half of the pair
     * {@code authenticatedAttributionIsServerComputed} does not visit. Measured, not endorsed: the actor is a
     * server fact, but a subject is accepted on shape alone — no declared vocabulary (V1:769 comments one, no
     * CHECK exists), no resolution against any table, no tenant test — and {@code v_merchant_funnel} counts
     * {@code subject_type='merchant'} rows as views/clicks/actions. The class-level javadoc and STATUS §66 name
     * the open decision; this test is the witness that would go red if the door ever starts checking, which is
     * the point of writing it down rather than leaving it to a comment.
     */
    @Test
    @DisplayName("A claimed subject is stored as claimed and moves the merchant funnel; the pair rule still bites")
    void claimedSubjectIsStoredAndMovesTheFunnel() {
        UUID merchant = newMerchant(tenant, "funnel" + tag(), "published");
        assertThat(funnelViews(merchant)).isZero();

        String sid = session();
        JsonNode body = Json.tree(postBatch(tenant, null, "evt-" + tag(), Map.of("events", List.of(
                Map.of("name", "view", "session_id", sid,
                        "subject_type", "merchant", "subject_id", merchant.toString())))).getBody());
        assertThat(body.path("accepted").asInt()).isEqualTo(1);
        assertThat(body.path("rejected").asInt()).isZero();

        Map<String, Object> row = row("select subject_type, subject_id::text as subject_id, actor_type"
                + " from events where session_id = :s", Map.of("s", sid));
        assertThat(row.get("subject_type")).isEqualTo("merchant");
        assertThat(row.get("subject_id")).isEqualTo(merchant.toString());
        assertThat(row.get("actor_type")).isEqualTo("anonymous");
        assertThat(funnelViews(merchant)).isEqualTo(1L);
    }

    /**
     * The vocabulary is a shape, not a declaration: a type name that resolves to nothing in this schema is
     * stored anyway. The funnel does not count it (its join names {@code merchant} specifically), which is why
     * this half is loud and that half is quiet — and why the census in {@code quality.sql} cannot see either,
     * because it only reads the seed.
     */
    @Test
    @DisplayName("An undeclared subject_type passes the shape gate and is stored unresolved")
    void undeclaredSubjectTypeIsAccepted() {
        String sid = session();
        UUID nowhere = UUID.randomUUID();
        JsonNode body = Json.tree(postBatch(tenant, null, "evt-" + tag(), Map.of("events", List.of(
                Map.of("name", "view", "session_id", sid,
                        "subject_type", "not_a_declared_type", "subject_id", nowhere.toString())))).getBody());
        assertThat(body.path("accepted").asInt()).isEqualTo(1);
        assertThat(body.path("rejected").asInt()).isZero();

        Map<String, Object> row = row("select subject_type, subject_id::text as subject_id"
                + " from events where session_id = :s", Map.of("s", sid));
        assertThat(row.get("subject_type")).isEqualTo("not_a_declared_type");
        assertThat(row.get("subject_id")).isEqualTo(nowhere.toString());
        assertThat(count("select count(*) from merchants where id = :m", Map.of("m", nowhere))).isZero();
    }

    /** The one real guard on this half: the two columns must arrive together. Pinned so a later fix reads as a change, not a regression. */
    @Test
    @DisplayName("subject_type without subject_id (or the reverse) is rejected, never stored half")
    void subjectMustArriveAsAPair() {
        String sid = session();
        JsonNode typeOnly = Json.tree(postBatch(tenant, null, "evt-a-" + tag(), Map.of("events", List.of(
                Map.of("name", "view", "session_id", sid, "subject_type", "merchant")))).getBody());
        assertThat(typeOnly.path("rejected").asInt()).isEqualTo(1);
        assertThat(typeOnly.path("reject_reasons").get(0).path("reason").asText())
                .isEqualTo("subject_type_and_id_must_pair");
        assertThat(rowsFor(sid)).isZero();

        JsonNode idOnly = Json.tree(postBatch(tenant, null, "evt-b-" + tag(), Map.of("events", List.of(
                Map.of("name", "view", "session_id", sid, "subject_id", UUID.randomUUID().toString())))).getBody());
        assertThat(idOnly.path("rejected").asInt()).isEqualTo(1);
        assertThat(rowsFor(sid)).isZero();
    }

    private long funnelViews(UUID merchant) {
        Map<String, Object> r = row("select views from v_merchant_funnel where merchant_id = :m",
                Map.of("m", merchant));
        return ((Number) r.get("views")).longValue();
    }

    // ---------------------------------------------------------------- honest limits

    @Test
    @DisplayName("Idempotency-Key is required; anonymous events without a session_id are rejected, not dropped")
    void limitsAreEnforced() {
        assertThat(postBatch(tenant, null, null, Map.of("events", List.of(event("view", session())))).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        JsonNode body = Json.tree(postBatch(tenant, null, "evt-" + tag(),
                Map.of("events", List.of(event("view", null)))).getBody());
        assertThat(body.path("accepted").asInt()).isZero();
        assertThat(body.path("rejected").asInt()).isEqualTo(1);
        assertThat(body.path("reject_reasons").get(0).path("reason").asText())
                .isEqualTo("anonymous_event_requires_session_id");

        // An anonymous caller may not attribute an event to a user.
        JsonNode forged = Json.tree(postBatch(tenant, null, "evt-" + tag(),
                Map.of("events", List.of(Map.of("name", "view", "session_id", session(),
                        "actor_type", "user", "actor_id", user.toString())))).getBody());
        assertThat(forged.path("rejected").asInt()).isEqualTo(1);
        assertThat(forged.path("reject_reasons").get(0).path("reason").asText())
                .isEqualTo("anonymous_caller_must_not_claim_actor");
    }

    @Test
    @DisplayName("Malformed events are counted and explained; the valid ones in the batch still land")
    void invalidEventsAreRejectedNotSilent() {
        String sid = session();
        JsonNode body = Json.tree(postBatch(tenant, null, "evt-" + tag(), Map.of("events", List.of(
                Map.of("name", "Bad Name", "session_id", sid),          // name pattern
                Map.of("event_id", "nope", "name", "view", "session_id", sid), // bad uuid
                Map.of("name", "view", "session_id", sid, "properties", "free text"), // not an object
                event("view", sid)))).getBody());
        assertThat(body.path("rejected").asInt()).isEqualTo(3);
        assertThat(body.path("accepted").asInt()).isEqualTo(1);
        assertThat(rowsFor(sid)).isEqualTo(1);
    }

    @Test
    @DisplayName("A batch over the documented cap is refused whole with max_batch in the error")
    void oversizedBatchRefused() {
        String sid = session();
        List<Map<String, Object>> many = new java.util.ArrayList<>();
        for (int i = 0; i < EventsController.MAX_BATCH + 1; i++) {
            many.add(event("view", sid));
        }
        ResponseEntity<String> res = postBatch(tenant, null, "evt-" + tag(), Map.of("events", many));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(res.getBody()).contains("max_batch");
        assertThat(rowsFor(sid)).isZero();
    }

    @Test
    @DisplayName("Ingest with an empty batch is a legal no-op")
    void emptyBatchAccepted() {
        ResponseEntity<String> res = postBatch(tenant, null, "evt-" + tag(), Map.of("events", List.of()));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        JsonNode body = Json.tree(res.getBody());
        assertThat(body.path("accepted").asInt()).isZero();
        assertThat(body.path("rejected").asInt()).isZero();
    }

    @Test
    @DisplayName("Events land in the caller's tenant only — a second tenant's ingest is separate")
    void tenantIsolation() {
        String sid = session();
        postBatch(tenant, null, "evt-" + tag(), Map.of("events", List.of(event("view", sid))));
        Tenant other = newTenant("events-b");
        String otherSid = session();
        postBatch(other, null, "evt-" + tag(), Map.of("events", List.of(event("view", otherSid))));
        assertThat(count("select count(*) from events where tenant_id = :t and session_id = :s",
                Map.of("t", tenant.id(), "s", otherSid))).isZero();
        assertThat(count("select count(*) from events where tenant_id = :t", Map.of("t", other.id())))
                .isEqualTo(1);
    }
}
