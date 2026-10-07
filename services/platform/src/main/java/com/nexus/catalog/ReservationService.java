package com.nexus.catalog;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Booking a seat (§40). Two rules shape this class, and both are about not lying to the visitor:
 *
 * <ul>
 *   <li><b>The slot decides the terms.</b> {@code starts_at}, {@code ends_at} and {@code total_amount} are copied
 *       from the {@code availability_slots} row, never taken from the request — a client that could name its own
 *       time or price would be a client booking an appointment the merchant never offered (§19).</li>
 *   <li><b>Capacity is claimed in the statement that checks it.</b> Read-then-write would let two confirmations
 *       both see one seat, so the decrement carries {@code capacity_left >= party_size} as its own guard, inside
 *       one transaction so a failed insert cannot silently eat a table.</li>
 *   <li><b>A hold is released by the same rule it was taken by.</b> {@link #cancel} guards on
 *       {@code status in ('pending','confirmed')} in the update itself, so a double-tapped cancel returns the
 *       seats once, and the two states that describe an evening already lived are refused rather than rewritten.
 *       One live hold per person per slot is a database rule (V2), so {@link #book} reads it the same way
 *       instead of discovering it as a duplicate-key 500.</li>
 * </ul>
 */
@Service
public class ReservationService {

    /** Unambiguous alphabet: a code is read back over the phone. */
    private static final char[] CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private final ReservationRepository reservations;

    public ReservationService(ReservationRepository reservations) {
        this.reservations = reservations;
    }

    /** The outcome, so the controller can answer 200 for a replay and 201 for a new hold. */
    public record Booking(Map<String, Object> row, boolean reused, Map<String, Object> slot) {
    }

    /**
     * A released hold. {@code slot} is the slot as it reads afterwards, or {@code null} when nothing was
     * released — so a caller can never print a fresh seat count for a cancellation that did not happen.
     */
    public record Cancellation(Map<String, Object> row, Map<String, Object> slot, boolean replay) {
    }

    public Optional<Map<String, Object>> slot(TenantContext tenant, UUID slotId) {
        return reservations.slot(tenant, slotId);
    }

    /** What the slot reads now — the seat count a page may print after something touched the pool. */
    public Optional<Map<String, Object>> slotAfter(TenantContext tenant, UUID slotId) {
        return reservations.slotAfter(tenant, slotId);
    }

    public Optional<Map<String, Object>> find(TenantContext tenant, UUID reservationId) {
        return reservations.byId(tenant, reservationId);
    }

    /** A page of the inbox plus how many rows the same filter has in total. */
    public record Inbox(List<Map<String, Object>> items, long total) {
    }

    /**
     * The merchant's booking inbox (§23). The window is validated here rather than in the controller
     * because {@code from > to} is not a bad request about a field — it is a question no page can answer,
     * and the empty list it would return is indistinguishable from "the merchant has no bookings".
     */
    public Inbox inbox(TenantContext tenant, UUID merchantId, String status, Instant from, Instant to,
                       int limit, int offset) {
        if (from != null && to != null && !from.isBefore(to)) {
            throw ApiException.validation("'from' must be before 'to'",
                    Json.map("fields", List.of("from", "to"), "from", from.toString(), "to", to.toString()));
        }
        return new Inbox(reservations.inbox(tenant, merchantId, status, from, to, limit, offset),
                reservations.inboxCount(tenant, merchantId, status, from, to));
    }

    @Transactional
    public Booking book(TenantContext tenant, UUID userId, Map<String, Object> slot, int partySize,
                        Map<String, Object> contact, String notes, UUID offeringId) {
        UUID slotId = Json.uuid(slot, "id");
        Optional<Map<String, Object>> already = reservations.existing(tenant, userId, slotId);
        if (already.isPresent()) {
            Map<String, Object> held = already.get();
            Integer heldParty = Json.integer(held, "party_size");
            if (heldParty != null && heldParty.intValue() == partySize) {
                return new Booking(held, true, reservations.slotAfter(tenant, slotId).orElse(slot));
            }
            // One live hold per person per slot (V2). Changing the party size is a change to that hold,
            // not a second one — so it is refused with the code to cancel, rather than reaching the
            // unique index and answering 500 after a seat claim this transaction then rolls back.
            throw ApiException.conflict("reservation_exists",
                    "You already hold this slot for a party of " + heldParty + "; release "
                            + Json.str(held, "code") + " before booking a different size",
                    Json.map("reservation_id", Json.str(held, "id"), "code", Json.str(held, "code"),
                            "status", Json.str(held, "status"), "party_size", heldParty));
        }
        if (Json.integer(slot, "capacity_left") == null || Json.integer(slot, "capacity_left") < partySize) {
            throw ApiException.conflict("slot_full", "That slot no longer has room for this party size",
                    Json.map("slot_id", slotId.toString(), "capacity_left", Json.integer(slot, "capacity_left")));
        }
        if (reservations.claim(tenant, slotId, partySize) == 0) {
            // Between the read above and this statement someone else took the seats; the guard did its job.
            throw ApiException.conflict("slot_full", "That slot filled while the request was in flight",
                    Json.map("slot_id", slotId.toString()));
        }
        return new Booking(reservations.insert(tenant, userId, slot, newCode(), partySize, contact, notes,
                offeringId), false, reservations.slotAfter(tenant, slotId).orElse(slot));
    }

    /**
     * Release a hold and its seats. Only {@code pending}/{@code confirmed} hold anything: a
     * {@code completed} or {@code no_show} row is the record of an evening that already happened, and
     * rewriting it as cancelled would falsify the merchant's history (§109), so it is refused.
     */
    @Transactional
    public Cancellation cancel(TenantContext tenant, Map<String, Object> row) {
        UUID reservationId = Json.uuid(row, "id");
        String status = Json.str(row, "status");
        if ("cancelled".equals(status)) {
            return new Cancellation(row, null, true);
        }
        if (!"pending".equals(status) && !"confirmed".equals(status)) {
            throw ApiException.conflict("reservation_not_cancellable",
                    "A booking that is " + status + " is a record, not a hold, so it cannot be cancelled",
                    Json.map("reservation_id", reservationId.toString(), "status", status));
        }
        if (reservations.cancel(tenant, reservationId) == 0) {
            // The row moved under the read — re-read it so the answer is the state, not the intent.
            return new Cancellation(find(tenant, reservationId)
                    .orElseThrow(() -> ApiException.notFound("reservation_not_found", "No such booking")),
                    null, true);
        }
        UUID slotId = Json.uuidOrNull(Json.str(row, "slot_id"));
        Integer partySize = Json.integer(row, "party_size");
        if (slotId != null && partySize != null && partySize > 0) {
            reservations.restore(tenant, slotId, partySize);
        }
        return new Cancellation(find(tenant, reservationId).orElse(row),
                slotId == null ? null : reservations.slotAfter(tenant, slotId).orElse(null), false);
    }

    /**
     * A merchant's acceptance. {@code replay} is true when the row was already confirmed — the answer
     * is the state as it reads now, not a second decision about it.
     */
    public record Acceptance(Map<String, Object> row, boolean replay) {
    }

    /**
     * Accept a hold (§23, D26). Only {@code pending} confirms: a cancelled hold already released its
     * seats, so confirming it would promise a table that went back to the pool, and a {@code completed}
     * or {@code no_show} row is the record of an evening that happened (§109), not a hold. Accepting
     * moves no seats — they left the pool when the holder booked and stay out until the holder
     * releases — so the slot in the response reads exactly as the inbox left it.
     */
    @Transactional
    public Acceptance accept(TenantContext tenant, Map<String, Object> row) {
        UUID reservationId = Json.uuid(row, "id");
        String status = Json.str(row, "status");
        if ("confirmed".equals(status)) {
            return new Acceptance(row, true);
        }
        if (!"pending".equals(status)) {
            throw ApiException.conflict("reservation_not_confirmable",
                    "A booking that is " + status + " is not a live hold, so there is nothing to accept",
                    Json.map("reservation_id", reservationId.toString(), "status", status));
        }
        if (reservations.accept(tenant, reservationId) == 0) {
            // The row moved under the read — re-read it so the answer is the state, not the intent.
            return new Acceptance(find(tenant, reservationId)
                    .orElseThrow(() -> ApiException.notFound("reservation_not_found", "No such booking")), true);
        }
        return new Acceptance(find(tenant, reservationId).orElse(row), false);
    }

    /**
     * The evening's outcome (§6, §23). A live hold ({@code pending} or {@code confirmed}) whose window
     * has begun can be closed exactly once, into {@code completed} or {@code no_show} — the two records
     * an evening can end with. A cancelled hold refuses (its seats went back to the pool and its
     * evening never happened under this booking), an already-closed row refuses a different outcome
     * (the record is written once; rewriting it is the §109 crime), the same outcome replays, and a
     * future evening refuses on time: an outcome is a record, not a prediction.
     */
    @Transactional
    public Closing close(TenantContext tenant, Map<String, Object> row, String target) {
        UUID reservationId = Json.uuid(row, "id");
        String status = Json.str(row, "status");
        if (target.equals(status)) {
            return new Closing(row, true);
        }
        if (!"pending".equals(status) && !"confirmed".equals(status)) {
            throw ApiException.conflict("reservation_not_closable",
                    "A booking that is " + status + " is not a live hold, so there is no evening left to record",
                    Json.map("reservation_id", reservationId.toString(), "status", status));
        }
        requireBegun(row);
        if (reservations.close(tenant, reservationId, target) == 0) {
            // The row moved under the read — re-read it so the answer is the state, not the intent.
            return new Closing(find(tenant, reservationId)
                    .orElseThrow(() -> ApiException.notFound("reservation_not_found", "No such booking")), true);
        }
        return new Closing(find(tenant, reservationId).orElse(row), false);
    }

    /** A closed evening. {@code replay} is true when the row already carried this outcome. */
    public record Closing(Map<String, Object> row, boolean replay) {
    }

    /** An outcome needs a past: a booking whose window has not begun has no evening to record. */
    public static void requireBegun(Map<String, Object> row) {
        Object startsAt = row.get("starts_at");
        Instant starts = startsAt instanceof java.sql.Timestamp t ? t.toInstant()
                : startsAt instanceof java.time.OffsetDateTime o ? o.toInstant() : null;
        if (starts != null && starts.isAfter(Instant.now())) {
            throw ApiException.validation("The evening has not begun yet, so there is no outcome to record",
                    Json.map("field", "starts_at", "starts_at", starts.toString()));
        }
    }

    private static String newCode() {
        StringBuilder suffix = new StringBuilder(6);
        for (int i = 0; i < 6; i++) {
            suffix.append(CODE_ALPHABET[RANDOM.nextInt(CODE_ALPHABET.length)]);
        }
        return "NX-RES-" + suffix;
    }

    /** A slot in the past is not bookable, whatever its row still says about capacity. */
    public static void requireFuture(Map<String, Object> slot) {
        Object startsAt = slot.get("starts_at");
        Instant starts = startsAt instanceof java.sql.Timestamp t ? t.toInstant()
                : startsAt instanceof java.time.OffsetDateTime o ? o.toInstant() : null;
        if (starts != null && starts.isBefore(Instant.now())) {
            throw ApiException.validation("That slot has already started", Json.map("slot_id",
                    Json.str(slot, "id"), "starts_at", starts.toString()));
        }
    }
}
