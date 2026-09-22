package com.nexus.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * {@code POST /api/v1/reservations} and its {@code PATCH …/{id}} release (§40, §6) over a real database —
 * the step the consumer slice ends in, and the only way back out.
 *
 * <p>What is pinned here is the difference between a booking endpoint and a form handler: the seat is taken
 * exactly once even when the button is pressed twice, the terms come from the slot rather than the client, a
 * slot that belongs to another tenant is absent instead of forbidden, and a full slot says so instead of
 * overbooking it. The release half adds the mirror image: seats come back exactly once, a hold that is
 * somebody else's is absent, and an evening already recorded as completed is not rewritten into a
 * cancellation. Those are the ways a reservation surface quietly lies about a person's plans.
 */
class ReservationApiTest extends NexusIntegrationTest {

    private Tenant tenant;
    private Tenant other;
    private UUID userId;
    private String token;
    private UUID merchant;

    @BeforeEach
    void seedBookableMerchant() {
        tenant = newTenant("booking");
        other = newTenant("booking-other");
        // `users_email_uniq` is global, not per tenant: a fixed address would collide with the next test method.
        userId = newUser(tenant, "booker-" + System.nanoTime() + "@example.test", "consumer");
        token = token(tenant, userId, "consumer");
        merchant = newMerchant(tenant, "bookable-" + System.nanoTime(), "published");
        newLocation(tenant, merchant, 22.31, 114.16, "Sha Tin");
    }

    private UUID slot(Tenant owner, UUID merchantId, Instant startsAt, int total, int left, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into availability_slots (id, merchant_id, starts_at, ends_at, capacity_total, capacity_left,
                                                price_amount, currency, source)
                values (:id, :m, :starts_at, :ends_at, :total, :left, 180.00, 'HKD', 'merchant')
                """, new MapSqlParameterSource("id", id).addValue("m", merchantId)
                .addValue("starts_at", Timestamp.from(startsAt)).addValue("ends_at", Timestamp.from(startsAt.plusSeconds(5_400)))
                .addValue("total", total).addValue("left", left));
        if (!"published".equals(status)) {
            jdbc.update("update merchants set status = :status where id = :id",
                    new MapSqlParameterSource("status", status).addValue("id", merchantId));
        }
        return id;
    }

    private Map<String, Object> body(UUID slotId, int partySize, String phone) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("merchant_id", merchant.toString());
        body.put("slot_id", slotId.toString());
        body.put("party_size", partySize);
        Map<String, Object> contact = new LinkedHashMap<>();
        contact.put("name", "Ada Lau");
        if (phone != null) {
            contact.put("phone", phone);
        }
        body.put("contact", contact);
        body.put("notes", "Window table if possible");
        return body;
    }

    private int capacityLeft(UUID slotId) {
        return jdbc.queryForObject("select capacity_left from availability_slots where id = :id",
                new MapSqlParameterSource("id", slotId), Integer.class);
    }

    private int reservationCount(UUID slotId) {
        Long n = jdbc.queryForObject("select count(*) from reservations where slot_id = :id",
                new MapSqlParameterSource("id", slotId), Long.class);
        return n == null ? 0 : n.intValue();
    }

    @Test
    @DisplayName("A booking takes the seat, answers with a code, and reads back as the caller's own")
    void bookingHoldsCapacityAndIsReadable() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");

        ResponseEntity<String> created = post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789"));

        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode out = Json.tree(created.getBody());
        assertThat(out.path("code").asText()).matches("NX-RES-[A-Z2-9]{6}");
        assertThat(out.path("status").asText()).isEqualTo("pending");
        assertThat(out.path("party_size").asInt()).isEqualTo(2);
        // The price is the slot's, in the contract's money shape — not a number the client sent.
        assertThat(out.path("price").path("amount").asText()).isEqualTo("180.00");
        assertThat(out.path("price").path("currency").asText()).isEqualTo("HKD");
        assertThat(out.path("merchant").path("name").asText()).startsWith("Demo bookable");
        assertThat(out.path("status_note").asText()).contains("pending");
        assertThat(capacityLeft(slotId)).isEqualTo(2);

        JsonNode mine = Json.tree(get(tenant, token, "/api/v1/me/reservations").getBody());
        assertThat(mine).hasSize(1);
        assertThat(mine.get(0).path("code").asText()).isEqualTo(out.path("code").asText());
        assertThat(mine.get(0).path("id").asText()).isEqualTo(out.path("reservation_id").asText());
    }

    @Test
    @DisplayName("A double-tapped confirm replays the same code and takes the seats once")
    void repeatBookingIsNotDoubleBooked() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        Map<String, Object> request = body(slotId, 2, "2345 6789");

        JsonNode first = Json.tree(post(tenant, token, "/api/v1/reservations", request).getBody());
        ResponseEntity<String> second = post(tenant, token, "/api/v1/reservations", request);

        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode replay = Json.tree(second.getBody());
        assertThat(replay.path("code").asText()).isEqualTo(first.path("code").asText());
        assertThat(replay.path("status_note").asText()).contains("already exists");
        assertThat(capacityLeft(slotId)).isEqualTo(2);
        assertThat(reservationCount(slotId)).isEqualTo(1);
    }

    @Test
    @DisplayName("Anonymous gets the §1 envelope, not a seat")
    void anonymousCannotBook() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");

        ResponseEntity<String> denied = post(tenant, null, "/api/v1/reservations", body(slotId, 2, "2345 6789"));

        assertThat(denied.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(denied.getBody()).path("error").path("code").asText()).isEqualTo("unauthorized");
        assertThat(capacityLeft(slotId)).isEqualTo(4);
    }

    @Test
    @DisplayName("Another tenant's slot is absent, and its capacity is untouched")
    void foreignSlotReadsAsMissing() {
        UUID foreignMerchant = newMerchant(other, "not-yours-" + System.nanoTime(), "published");
        newLocation(other, foreignMerchant, 22.31, 114.16, "Yuen Long");
        UUID slotId = slot(other, foreignMerchant, Instant.now().plusSeconds(7_200), 4, 4, "published");

        ResponseEntity<String> response = post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789"));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(response.getBody()).path("error").path("code").asText())
                .isEqualTo("slot_not_found");
        assertThat(capacityLeft(slotId)).isEqualTo(4);
    }

    @Test
    @DisplayName("A slot without room is a 409 that changes nothing, not an overbooking")
    void fullSlotIsRefused() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 1, "published");

        ResponseEntity<String> response = post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789"));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(response.getBody()).path("error").path("code").asText()).isEqualTo("slot_full");
        assertThat(capacityLeft(slotId)).isEqualTo(1);
        assertThat(reservationCount(slotId)).isZero();
    }

    @Test
    @DisplayName("The past is not bookable and a draft merchant does not exist")
    void termsComeFromTheData() {
        UUID past = slot(tenant, merchant, Instant.now().minusSeconds(600), 4, 4, "published");
        ResponseEntity<String> expired = post(tenant, token, "/api/v1/reservations", body(past, 2, "2345 6789"));
        assertThat(expired.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(expired.getBody()).path("error").path("message").asText()).contains("already started");

        UUID draftMerchantSlot = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "draft");
        ResponseEntity<String> draft = post(tenant, token, "/api/v1/reservations", body(draftMerchantSlot, 2, "2345 6789"));
        assertThat(draft.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(draft.getBody()).path("error").path("code").asText()).isEqualTo("merchant_not_found");
    }

    @Test
    @DisplayName("A booking needs a channel the merchant can use, and only allowlisted contact keys are stored")
    void contactIsCheckedAndConstrained() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");

        Map<String, Object> noChannel = body(slotId, 2, null);
        assertThat(post(tenant, token, "/api/v1/reservations", noChannel).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        Map<String, Object> body = body(slotId, 2, "2345 6789");
        @SuppressWarnings("unchecked")
        Map<String, Object> contact = (Map<String, Object>) body.get("contact");
        contact.put("card_number", "4444 4444 4444 4444");
        JsonNode out = Json.tree(post(tenant, token, "/api/v1/reservations", body).getBody());
        assertThat(out.path("contact").path("phone").asText()).isEqualTo("2345 6789");
        assertThat(out.path("contact").toString()).doesNotContain("card_number");
    }

    @Test
    @DisplayName("Party size is bounded by the request contract, not trusted from the client")
    void partySizeIsValidated() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");

        assertThat(post(tenant, token, "/api/v1/reservations", body(slotId, 0, "2345 6789")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(post(tenant, token, "/api/v1/reservations", body(slotId, 40, "2345 6789")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(capacityLeft(slotId)).isEqualTo(4);
    }

    // ------------------------------------------------------------------ release (§6 PATCH)

    @Test
    @DisplayName("Cancelling gives the seats back and frees the slot for that person again")
    void cancelReturnsTheSeats() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        assertThat(capacityLeft(slotId)).isEqualTo(2);

        ResponseEntity<String> released = patch(token, idPath(held), Json.map("status", "cancelled"));

        assertThat(released.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode out = Json.tree(released.getBody());
        assertThat(out.path("status").asText()).isEqualTo("cancelled");
        assertThat(out.path("code").asText()).isEqualTo(held.path("code").asText());
        assertThat(out.path("merchant").path("slug").asText()).startsWith("bookable-");
        assertThat(out.path("updated_at").asText()).isNotBlank();
        // The release is not a notification: no route here claims the merchant knows.
        assertThat(out.path("status_note").asText()).contains("not notified");
        assertThat(out.path("slot").path("capacity_left").asInt()).isEqualTo(4);
        assertThat(capacityLeft(slotId)).isEqualTo(4);

        JsonNode again = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        assertThat(again.path("code").asText()).isNotEqualTo(held.path("code").asText());
        assertThat(again.path("status").asText()).isEqualTo("pending");
    }

    @Test
    @DisplayName("A cancel pressed twice returns no second set of seats and prints no fake count")
    void cancelIsIdempotent() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        patch(token, idPath(held), Json.map("status", "cancelled"));

        ResponseEntity<String> second = patch(token, idPath(held), Json.map("status", "cancelled"));

        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode out = Json.tree(second.getBody());
        assertThat(out.path("status").asText()).isEqualTo("cancelled");
        assertThat(out.path("status_note").asText()).contains("already cancelled");
        // A replay that changed nothing must not offer a seat count as if it had.
        assertThat(out.path("slot").isMissingNode()).isTrue();
        assertThat(capacityLeft(slotId)).isEqualTo(4);
        assertThat(reservationCount(slotId)).isEqualTo(1);
    }

    @Test
    @DisplayName("Someone else's booking is absent, and their seats stay taken")
    void foreignBookingCannotBeReleased() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        UUID intruder = newUser(tenant, "intruder-" + System.nanoTime() + "@example.test", "consumer");

        // Same tenant, different person: absent, not forbidden — this route must not let anyone test
        // whether a code exists. (`contact.email` is not an authorisation either; only the token is.)
        ResponseEntity<String> denied = patch(token(tenant, intruder, "consumer"), idPath(held),
                Json.map("status", "cancelled"));
        assertThat(denied.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(denied.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_found");
        assertThat(capacityLeft(slotId)).isEqualTo(2);

        // A caller from the other tenant, asking properly: their own tenant header and their own token.
        // Sending `tenant`'s header with `other`'s bearer would be answered 401 by the auth filter, which
        // tests the session check rather than the data boundary this assertion is about.
        UUID stranger = newUser(other, "stranger-" + System.nanoTime() + "@example.test", "consumer");
        ResponseEntity<String> crossTenant = exchange(HttpMethod.PATCH, other,
                token(other, stranger, "consumer"), idPath(held), Json.map("status", "cancelled"));
        assertThat(crossTenant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(crossTenant.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_found");
        assertThat(capacityLeft(slotId)).isEqualTo(2);
    }

    @Test
    @DisplayName("The only transition a holder is offered is cancellation")
    void otherTransitionsAreRefused() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        String path = idPath(held);

        assertThat(patch(null, path, Json.map("status", "cancelled")).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        ResponseEntity<String> advance = patch(token, path, Json.map("status", "confirmed"));
        assertThat(advance.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(advance.getBody()).path("error").path("message").asText())
                .contains("merchant's decision");
        assertThat(patch(token, path, Json.map()).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(statusOf(held)).isEqualTo("pending");
        assertThat(capacityLeft(slotId)).isEqualTo(2);
    }

    @Test
    @DisplayName("An evening that already happened is a record, not a hold to release")
    void terminalStatesAreNotCancellable() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        jdbc.update("update reservations set status = 'completed' where id = cast(:id as uuid)",
                new MapSqlParameterSource("id", held.path("reservation_id").asText()));

        ResponseEntity<String> refused = patch(token, idPath(held), Json.map("status", "cancelled"));

        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(refused.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_cancellable");
        assertThat(statusOf(held)).isEqualTo("completed");
        assertThat(capacityLeft(slotId)).isEqualTo(2);
    }

    @Test
    @DisplayName("A second party size on a held slot is refused before the seats are touched")
    void changingPartySizeIsNotASecondHold() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 6, 6, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());

        ResponseEntity<String> bigger = post(tenant, token, "/api/v1/reservations", body(slotId, 4, "2345 6789"));

        // V2 allows one live hold per person per slot. Reconciling the API with that index is what keeps
        // this a 409 that names the code to cancel instead of a duplicate-key 500 after a claimed table.
        assertThat(bigger.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        JsonNode error = Json.tree(bigger.getBody()).path("error");
        assertThat(error.path("code").asText()).isEqualTo("reservation_exists");
        assertThat(error.path("details").path("code").asText()).isEqualTo(held.path("code").asText());
        assertThat(capacityLeft(slotId)).isEqualTo(4);
        assertThat(reservationCount(slotId)).isEqualTo(1);
    }

    @Test
    @DisplayName("A release never pushes a shrunken pool past its own ceiling")
    void restoreStaysInsideTheBounds() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        // The merchant cuts the table size while the hold is open: capacity_left == capacity_total == 2.
        jdbc.update("update availability_slots set capacity_total = capacity_left where id = :id",
                new MapSqlParameterSource("id", slotId));

        assertThat(patch(token, idPath(held), Json.map("status", "cancelled")).getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(capacityLeft(slotId)).isEqualTo(2);
    }

    @Test
    @DisplayName("The reason a person gives is kept, in the audit trail")
    void cancelReasonIsAudited() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());

        patch(token, idPath(held), Json.map("status", "cancelled", "reason", "Flights changed"));

        assertThat(count("select count(*) from audit_logs where action = 'reservation_cancel' "
                        + "and subject_id = cast(:id as uuid) and metadata ->> 'reason' = :reason "
                        + "and before ->> 'status' = 'pending' and after ->> 'status' = 'cancelled'",
                Json.map("id", held.path("reservation_id").asText(), "reason", "Flights changed"))).isEqualTo(1);
    }

    private String idPath(JsonNode reservation) {
        return "/api/v1/reservations/" + reservation.path("reservation_id").asText();
    }

    @Test
    @DisplayName("A booking reads back for the person it belongs to and for a workspace holding read_orders")
    void bookingReadsBackForHolderAndStaff() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        String path = idPath(held);

        JsonNode mine = Json.tree(get(tenant, token, path).getBody());
        assertThat(mine.path("reservation_id").asText()).isEqualTo(held.path("reservation_id").asText());
        assertThat(mine.path("code").asText()).isEqualTo(held.path("code").asText());
        assertThat(mine.path("status").asText()).isEqualTo("pending");
        assertThat(mine.path("contact").path("phone").asText()).isEqualTo("2345 6789");
        assertThat(mine.path("merchant").path("slug").asText()).startsWith("bookable-");
        assertThat(mine.path("updated_at").asText()).isNotBlank();

        UUID staffUser = newUser(tenant, "staff-" + System.nanoTime() + "@example.test", "consumer");
        staff(tenant, merchant, staffUser, "read_orders");
        JsonNode workspaceView = Json.tree(get(tenant, token(tenant, staffUser, "consumer"), path).getBody());
        assertThat(workspaceView.path("code").asText()).isEqualTo(mine.path("code").asText());

        // Read-after-write: the release is what a later GET reports.
        patch(token, path, Json.map("status", "cancelled"));
        assertThat(Json.tree(get(tenant, token, path).getBody()).path("status").asText()).isEqualTo("cancelled");
    }

    @Test
    @DisplayName("A booking is absent to a stranger, to a member without the grant, and to another tenant")
    void bookingIsAbsentToEveryoneElse() {
        UUID slotId = slot(tenant, merchant, Instant.now().plusSeconds(7_200), 4, 4, "published");
        JsonNode held = Json.tree(post(tenant, token, "/api/v1/reservations", body(slotId, 2, "2345 6789")).getBody());
        String path = idPath(held);

        assertThat(get(tenant, null, path).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        UUID memberWithoutGrant = newUser(tenant, "no-grant-" + System.nanoTime() + "@example.test", "consumer");
        staff(tenant, merchant, memberWithoutGrant, "read_products");
        assertThat(get(tenant, token(tenant, memberWithoutGrant, "consumer"), path).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // A grant on a different merchant of the same tenant does not reach this booking.
        UUID neighbourMerchant = newMerchant(tenant, "neighbour-" + System.nanoTime(), "published");
        UUID neighbourStaff = newUser(tenant, "neighbour-staff-" + System.nanoTime() + "@example.test", "consumer");
        staff(tenant, neighbourMerchant, neighbourStaff, "read_orders");
        assertThat(get(tenant, token(tenant, neighbourStaff, "consumer"), path).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(get(other, token(other, newUser(other, "far-" + System.nanoTime() + "@example.test", "consumer"),
                "consumer"), path).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // A malformed id is a complaint about the request, not a probe about the row.
        assertThat(get(tenant, token, "/api/v1/reservations/not-a-uuid").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    private ResponseEntity<String> patch(String bearer, String path, Map<String, Object> body) {
        return exchange(HttpMethod.PATCH, tenant, bearer, path, body);
    }

    private String statusOf(JsonNode reservation) {
        return jdbc.queryForObject("select status from reservations where id = cast(:id as uuid)",
                new MapSqlParameterSource("id", reservation.path("reservation_id").asText()), String.class);
    }
}
