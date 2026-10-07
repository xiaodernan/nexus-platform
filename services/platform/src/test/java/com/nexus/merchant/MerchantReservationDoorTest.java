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
 * The acceptance door over HTTP, witnessed end-to-end: a hold a real guest booked through
 * {@code POST /api/v1/reservations} is confirmed only by the workspace's
 * {@code POST /api/v1/merchant/reservations/{id}/accept}, behind {@code manage_reservations} (D26).
 *
 * <p>The pinned properties: accepting is a named human's act (403 for anyone holding the wrong grant,
 * 404 for another tenant's hold), the seats never move — they left the pool when the guest booked and
 * a replay or a cancelled hold cannot move them either — a double-tap answers {@code changed=false}
 * instead of rewriting the decision, and a cancelled hold is refused outright because confirming it
 * would promise a table that went back to the pool.
 */
class MerchantReservationDoorTest extends NexusIntegrationTest {

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
        tenant = newTenant("resaccept");
        merchant = newMerchant(tenant, "ra-" + tag(), "published");
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

    private String acceptPath(UUID reservationId) {
        return "/api/v1/merchant/reservations/" + reservationId + "/accept";
    }

    /** A live hold through the consumer's own door: 201, pending, and two of four seats claimed. */
    private JsonNode book() {
        ResponseEntity<String> res = post(tenant, bookerToken, "/api/v1/reservations",
                Json.map("merchant_id", merchant.toString(), "slot_id", slotId.toString(),
                        "party_size", 2, "contact", Json.map("name", "Gwen Book",
                                "phone", "+85260001111", "email", "gwen@example.test")));
        assertThat(res.getStatusCode()).as(res.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode booked = Json.tree(res.getBody());
        assertThat(booked.path("status").asText()).isEqualTo("pending");
        assertThat(booked.path("slot").path("capacity_left").asInt()).isEqualTo(2);
        return booked;
    }

    @Test
    @DisplayName("Accept confirms once, moves no seats, and a replay re-reads instead of rewriting")
    void acceptConfirmsOnceAndMovesNoSeats() {
        JsonNode booked = book();
        UUID reservationId = UUID.fromString(booked.path("reservation_id").asText());

        ResponseEntity<String> accept = post(tenant, managerToken, acceptPath(reservationId), Map.of());
        assertThat(accept.getStatusCode()).as(accept.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode done = Json.tree(accept.getBody());
        assertThat(done.path("changed").asBoolean()).isTrue();
        assertThat(done.path("reservation").path("status").asText()).isEqualTo("confirmed");
        assertThat(done.path("reservation").path("code").asText())
                .isEqualTo(booked.path("code").asText());
        // The seats left the pool at booking time; accepting must not touch them again.
        assertThat(done.path("slot").path("capacity_left").asInt()).isEqualTo(2);
        assertThat(done.path("status_note").asText()).contains("Accepted");
        assertThat(row("select status from reservations where id = :id", Map.of("id", reservationId))
                .get("status")).isEqualTo("confirmed");

        // The holder sees the merchant's yes on their own read.
        ResponseEntity<String> holder = get(tenant, bookerToken, "/api/v1/reservations/" + reservationId);
        assertThat(holder.getStatusCode()).as(holder.getBody()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(holder.getBody()).path("status").asText()).isEqualTo("confirmed");

        // A double-click does not rewrite when the decision was made — and no seats come back.
        ResponseEntity<String> second = post(tenant, managerToken, acceptPath(reservationId), Map.of());
        assertThat(second.getStatusCode()).as(second.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode again = Json.tree(second.getBody());
        assertThat(again.path("changed").asBoolean()).isFalse();
        assertThat(again.path("reservation").path("status").asText()).isEqualTo("confirmed");
        assertThat(again.path("slot").path("capacity_left").asInt()).isEqualTo(2);
        assertThat(again.path("status_note").asText()).contains("already accepted");

        // Both calls are audited, and each says what it was: the first carried a before state,
        // the replay carried none and named itself as a replay. (`::text` because a jsonb column
        // arrives as a PGobject, not as a string Jackson can re-parse.)
        assertThat(count("select count(*) from audit_logs where action = 'reservation_accept' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(2);
        Map<String, Object> fresh = row("select before::text as before, after::text as after "
                + "from audit_logs where action = 'reservation_accept' "
                + "and merchant_id = :m order by id limit 1", Map.of("m", merchant));
        assertThat(Json.tree((String) fresh.get("before")).path("status").asText()).isEqualTo("pending");
        assertThat(Json.tree((String) fresh.get("after")).path("replay").asBoolean()).isFalse();
        Map<String, Object> replay = row("select before::text as before, after::text as after "
                + "from audit_logs where action = 'reservation_accept' "
                + "and merchant_id = :m order by id desc limit 1", Map.of("m", merchant));
        assertThat(replay.get("before")).isNull();
        assertThat(Json.tree((String) replay.get("after")).path("replay").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("A caller cannot accept without the grant, confirm a cancelled hold, or reach a stranger's booking")
    void theRefusalTableIsARefusal() {
        JsonNode booked = book();
        UUID reservationId = UUID.fromString(booked.path("reservation_id").asText());
        String path = acceptPath(reservationId);

        assertThat(post(tenant, null, path, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // A member of this merchant who may read orders may not confirm them: the grant the route
        // asks for is manage_reservations, and read_orders does not subsume it.
        UUID member = newUser(tenant, "reader" + tag(), "consumer");
        staff(tenant, merchant, member, "read_orders");
        assertThat(post(tenant, token(tenant, member, "consumer"), path, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Same tenant, no membership at all: still 403 — the hold exists in their tenant, it is
        // simply not theirs to accept.
        UUID outsider = newUser(tenant, "outsider" + tag(), "consumer");
        assertThat(post(tenant, token(tenant, outsider, "consumer"), path, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // A cancelled hold refused with its own code, and the seats it returned stay returned:
        // accepting it must not resurrect a table that is back in the pool. The holder releases
        // the hold through their own door first.
        assertThat(exchange(org.springframework.http.HttpMethod.PATCH, tenant, bookerToken,
                "/api/v1/reservations/" + reservationId, Json.map("status", "cancelled")).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(row("select capacity_left from availability_slots where id = :id", Map.of("id", slotId))
                .get("capacity_left")).isEqualTo(4);
        ResponseEntity<String> confirm = post(tenant, managerToken, path, Map.of());
        assertThat(confirm.getStatusCode()).as(confirm.getBody()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(confirm.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_confirmable");
        assertThat(row("select capacity_left from availability_slots where id = :id", Map.of("id", slotId))
                .get("capacity_left")).isEqualTo(4);

        // Another tenant's hold is absent, not forbidden — the same 404 an unknown id gets.
        Tenant other = newTenant("resaccept-other");
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
        ResponseEntity<String> stranger = post(tenant, managerToken, acceptPath(foreignId), Map.of());
        assertThat(stranger.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.tree(stranger.getBody()).path("error").path("code").asText())
                .isEqualTo("reservation_not_found");
        assertThat(post(tenant, managerToken, acceptPath(UUID.randomUUID()), Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Two 403s, two permission_denied rows naming this merchant.
        assertThat(count("select count(*) from audit_logs where action = 'permission_denied' "
                + "and merchant_id = :m and tenant_id = :t", Map.of("m", merchant, "t", tenant.id())))
                .isEqualTo(2);
    }
}
