package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * The outcome door over HTTP, one step after the yes: once the evening has begun, the workspace's
 * {@code POST /api/v1/merchant/reservations/{id}/close} records what it became — {@code completed}
 * (the table was honoured) or {@code no_show} (the guest never came) — behind the same
 * {@code manage_reservations} grant that confirms a hold (D26/D274).
 *
 * <p>The pinned properties: the record is written once (a same-outcome replay answers
 * {@code changed=false}, a different outcome answers 409 rather than overwriting), an outcome needs a
 * past (a booking whose window has not begun answers 422 — a record, not a prediction), a cancelled
 * hold answers 409 (its seats went back; its evening never happened under this booking), a pending
 * hold closes without acceptance first, and the seats never move — they left the pool when the guest
 * booked, and a past slot's capacity is history, not inventory, so the response carries no slot block
 * at all.
 */
class MerchantReservationCloseDoorTest extends NexusIntegrationTest {

    private Tenant tenant;
    private UUID merchant;
    private UUID manager;
    private UUID booker;
    private String managerToken;
    private String bookerToken;
    private UUID slotId;
    private Instant slotStart;
    private Instant slotEnd;

    @BeforeEach
    void seedWorkspace() {
        tenant = newTenant("resclose");
        merchant = newMerchant(tenant, "rc-" + tag(), "published");
        manager = newUser(tenant, "manager" + tag(), "consumer");
        staff(tenant, merchant, manager, "read_orders", "manage_reservations");
        managerToken = token(tenant, manager, "consumer");
        booker = newUser(tenant, "booker" + tag(), "consumer");
        bookerToken = token(tenant, booker, "consumer");
        slotId = UUID.randomUUID();
        slotStart = Instant.now().plusSeconds(7 * 86_400);
        slotEnd = slotStart.plusSeconds(7_200);
        jdbc.update("""
                insert into availability_slots (id, merchant_id, starts_at, ends_at,
                                                capacity_total, capacity_left, price_amount)
                values (:id, :m, :starts, :ends, 4, 4, 388.00)
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", slotId)
                .addValue("m", merchant).addValue("starts", Timestamp.from(slotStart))
                .addValue("ends", Timestamp.from(slotEnd)));
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private String closePath(UUID reservationId) {
        return "/api/v1/merchant/reservations/" + reservationId + "/close";
    }

    private static Map<String, Object> outcome(String status) {
        return Json.map("status", status);
    }

    /** A live hold through the consumer's own door: 201 and pending, seats claimed. */
    private JsonNode book(int party, String phone) {
        return bookAs(booker, party, phone);
    }

    private JsonNode bookAs(UUID guest, int party, String phone) {
        ResponseEntity<String> res = post(tenant, token(tenant, guest, "consumer"), "/api/v1/reservations",
                Json.map("merchant_id", merchant.toString(), "slot_id", slotId.toString(),
                        "party_size", party, "contact", Json.map("name", "Gwen Book",
                                "phone", phone, "email", "gwen@example.test")));
        assertThat(res.getStatusCode()).as(res.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode booked = Json.tree(res.getBody());
        assertThat(booked.path("status").asText()).isEqualTo("pending");
        return booked;
    }

    /** The time machine: close reads the booking's own copied window, so the evening moves, not the slot. */
    private void eveningHappened() {
        jdbc.update("update reservations set starts_at = :s, ends_at = :e where merchant_id = :m",
                Map.of("s", Timestamp.from(Instant.now().minusSeconds(3_600)),
                        "e", Timestamp.from(Instant.now().minusSeconds(1_800)), "m", merchant));
    }

    @Test
    @DisplayName("Close records the outcome once, moves no seats, and a replay re-reads instead of rewriting")
    void closeRecordsTheOutcomeOnceAndRewritesNothing() {
        JsonNode booked = book(2, "+85260001111");
        UUID reservationId = UUID.fromString(booked.path("reservation_id").asText());
        assertThat(post(tenant, managerToken,
                "/api/v1/merchant/reservations/" + reservationId + "/accept", Map.of())
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        eveningHappened();

        ResponseEntity<String> close = post(tenant, managerToken, closePath(reservationId),
                outcome("completed"));
        assertThat(close.getStatusCode()).as(close.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode done = Json.tree(close.getBody());
        assertThat(done.path("changed").asBoolean()).isTrue();
        assertThat(done.path("reservation").path("status").asText()).isEqualTo("completed");
        assertThat(done.path("reservation").path("code").asText())
                .isEqualTo(booked.path("code").asText());
        assertThat(done.path("status_note").asText()).contains("on record as honoured");
        // A past slot's capacity is history, not inventory: the response carries no slot block.
        assertThat(done.path("slot").isMissingNode()).isTrue();
        assertThat(row("select capacity_left from availability_slots where id = :id", Map.of("id", slotId))
                .get("capacity_left")).isEqualTo(2);
        assertThat(row("select status from reservations where id = :id", Map.of("id", reservationId))
                .get("status")).isEqualTo("completed");

        // A double-click does not rewrite a decision the evening already settled.
        ResponseEntity<String> second = post(tenant, managerToken, closePath(reservationId),
                outcome("completed"));
        assertThat(second.getStatusCode()).as(second.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode again = Json.tree(second.getBody());
        assertThat(again.path("changed").asBoolean()).isFalse();
        assertThat(again.path("reservation").path("status").asText()).isEqualTo("completed");
        assertThat(again.path("status_note").asText()).contains("already recorded");

        // And the other outcome cannot overwrite this one: the record was written once.
        ResponseEntity<String> rewrite = post(tenant, managerToken, closePath(reservationId),
                outcome("no_show"));
        assertThat(rewrite.getStatusCode()).as(rewrite.getBody()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(rewrite.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_closable");

        // The holder sees the evening's outcome on their own read.
        ResponseEntity<String> holder = get(tenant, bookerToken, "/api/v1/reservations/" + reservationId);
        assertThat(holder.getStatusCode()).as(holder.getBody()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(holder.getBody()).path("status").asText()).isEqualTo("completed");

        // Both calls are audited, and each says what it was: the first carried the pre-close state
        // (confirmed — acceptance happened before the evening), the replay carried none and named
        // itself. The 409 attempt threw before any audit line. (`::text` because a jsonb column
        // arrives as a PGobject, not as a string Jackson can re-parse.)
        assertThat(count("select count(*) from audit_logs where action = 'reservation_close' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(2);
        Map<String, Object> fresh = row("select before::text as before, after::text as after "
                + "from audit_logs where action = 'reservation_close' "
                + "and merchant_id = :m order by id limit 1", Map.of("m", merchant));
        assertThat(Json.tree((String) fresh.get("before")).path("status").asText()).isEqualTo("confirmed");
        assertThat(Json.tree((String) fresh.get("after")).path("status").asText()).isEqualTo("completed");
        assertThat(Json.tree((String) fresh.get("after")).path("replay").asBoolean()).isFalse();
        Map<String, Object> replay = row("select before::text as before, after::text as after "
                + "from audit_logs where action = 'reservation_close' "
                + "and merchant_id = :m order by id desc limit 1", Map.of("m", merchant));
        assertThat(replay.get("before")).isNull();
        assertThat(Json.tree((String) replay.get("after")).path("replay").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("A caller without the grant, a future evening, a cancelled hold, and a stranger's booking are all refused")
    void theRefusalTableIsARefusal() {
        // Three live holds drain the four-seat slot: A(2) will be cancelled, B(1) and C(1) stay
        // pending. Different guests — one holder cannot book the same slot twice (reservation_exists).
        JsonNode a = book(2, "+85260001111");
        UUID holdA = UUID.fromString(a.path("reservation_id").asText());
        UUID bookerB = newUser(tenant, "bookerb" + tag(), "consumer");
        JsonNode b = bookAs(bookerB, 1, "+85260003333");
        UUID holdB = UUID.fromString(b.path("reservation_id").asText());
        UUID bookerC = newUser(tenant, "bookerc" + tag(), "consumer");
        JsonNode c = bookAs(bookerC, 1, "+85260004444");
        UUID holdC = UUID.fromString(c.path("reservation_id").asText());
        String pathA = closePath(holdA);
        Map<String, Object> completed = outcome("completed");
        assertThat(row("select capacity_left from availability_slots where id = :id", Map.of("id", slotId))
                .get("capacity_left")).isEqualTo(0);

        assertThat(post(tenant, null, pathA, completed).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // A member of this merchant who may read orders may not record outcomes: the grant the route
        // asks for is manage_reservations, and read_orders does not subsume it.
        UUID member = newUser(tenant, "reader" + tag(), "consumer");
        staff(tenant, merchant, member, "read_orders");
        assertThat(post(tenant, token(tenant, member, "consumer"), pathA, completed).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Same tenant, no membership at all: still 403 — the hold exists in their tenant, it is
        // simply not theirs to close.
        UUID outsider = newUser(tenant, "outsider" + tag(), "consumer");
        assertThat(post(tenant, token(tenant, outsider, "consumer"), pathA, completed).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // A live hold whose window has not begun has no evening to record: 422 naming starts_at.
        ResponseEntity<String> future = post(tenant, managerToken, pathA, completed);
        assertThat(future.getStatusCode()).as(future.getBody()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(future.getBody()).path("error").path("code").asText())
                .isEqualTo("validation_error");
        assertThat(Json.tree(future.getBody()).path("error").path("details").path("field").asText())
                .isEqualTo("starts_at");

        // The body names one of exactly two records an evening can end with.
        ResponseEntity<String> wrong = post(tenant, managerToken, pathA, outcome("cancelled"));
        assertThat(wrong.getStatusCode()).as(wrong.getBody()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(wrong.getBody()).path("error").path("details").path("given").asText())
                .isEqualTo("cancelled");
        assertThat(post(tenant, managerToken, pathA, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A cancelled hold is refused outright: its seats went back, and its evening never happened
        // under this booking. The holder releases the hold through their own door first.
        assertThat(exchange(org.springframework.http.HttpMethod.PATCH, tenant, bookerToken,
                "/api/v1/reservations/" + holdA, Json.map("status", "cancelled")).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(row("select capacity_left from availability_slots where id = :id", Map.of("id", slotId))
                .get("capacity_left")).isEqualTo(2);
        ResponseEntity<String> cancelled = post(tenant, managerToken, pathA, completed);
        assertThat(cancelled.getStatusCode()).as(cancelled.getBody()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(cancelled.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_closable");

        // Now the evening passes, and a pending hold records its outcome directly — acceptance is
        // not a precondition for closing, only for confirming. Both spellings witnessed from
        // pending: no_show for B, completed for C.
        eveningHappened();
        ResponseEntity<String> guestNeverCame = post(tenant, managerToken, closePath(holdB),
                outcome("no_show"));
        assertThat(guestNeverCame.getStatusCode()).as(guestNeverCame.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode missed = Json.tree(guestNeverCame.getBody());
        assertThat(missed.path("changed").asBoolean()).isTrue();
        assertThat(missed.path("reservation").path("status").asText()).isEqualTo("no_show");
        assertThat(missed.path("status_note").asText()).contains("on record as a no-show");
        ResponseEntity<String> honoured = post(tenant, managerToken, closePath(holdC), completed);
        assertThat(honoured.getStatusCode()).as(honoured.getBody()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(honoured.getBody()).path("reservation").path("status").asText())
                .isEqualTo("completed");
        // Closing moves no seats: the pool is where the releases left it.
        assertThat(row("select capacity_left from availability_slots where id = :id", Map.of("id", slotId))
                .get("capacity_left")).isEqualTo(2);

        // Another tenant's hold is absent, not forbidden — the same 404 an unknown id gets.
        Tenant other = newTenant("resclose-other");
        UUID theirs = newMerchant(other, "elsewhere-" + tag(), "published");
        UUID otherBooker = newUser(other, "booker" + tag(), "consumer");
        UUID otherSlot = UUID.randomUUID();
        jdbc.update("""
                insert into availability_slots (id, merchant_id, starts_at, ends_at,
                                                capacity_total, capacity_left, price_amount)
                values (:id, :m, :starts, :ends, 2, 2, 120.00)
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource("id", otherSlot)
                .addValue("m", theirs).addValue("starts", Timestamp.from(slotStart))
                .addValue("ends", Timestamp.from(slotEnd)));
        ResponseEntity<String> theirBooking = post(other, token(other, otherBooker, "consumer"),
                "/api/v1/reservations", Json.map("merchant_id", theirs.toString(),
                        "slot_id", otherSlot.toString(), "party_size", 1,
                        "contact", Json.map("phone", "+85260002222")));
        assertThat(theirBooking.getStatusCode()).as(theirBooking.getBody()).isEqualTo(HttpStatus.CREATED);
        UUID foreignId = UUID.fromString(
                Json.tree(theirBooking.getBody()).path("reservation_id").asText());
        ResponseEntity<String> stranger = post(tenant, managerToken, closePath(foreignId), completed);
        assertThat(stranger.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(stranger.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_found");
        assertThat(post(tenant, managerToken, closePath(UUID.randomUUID()), completed).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Two 403s, two permission_denied rows naming this merchant; exactly two outcome rows
        // written, each carrying the pending state it closed from.
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(2);
        assertThat(count("select count(*) from audit_logs where action = 'reservation_close' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(2);
        Map<String, Object> first = row("select before::text as before, after::text as after "
                + "from audit_logs where action = 'reservation_close' "
                + "and merchant_id = :m order by id limit 1", Map.of("m", merchant));
        assertThat(Json.tree((String) first.get("before")).path("status").asText()).isEqualTo("pending");
        assertThat(Json.tree((String) first.get("after")).path("replay").asBoolean()).isFalse();
    }
}
