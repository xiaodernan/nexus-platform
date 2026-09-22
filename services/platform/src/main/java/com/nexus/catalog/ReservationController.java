package com.nexus.catalog;

import com.nexus.merchant.MerchantPermissions;
import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/v1/reservations} and {@code PATCH /api/v1/reservations/{id}} — the terminal step of the
 * consumer slice (§40, spec §166-§170) and the only way back out of it.
 *
 * <p>Authenticated as a user, always: a reservation is a claim about a named person's evening, so the
 * subject comes from the token and never from the body (§52). The response carries the human-readable
 * code and nothing else is promised about the merchant having seen it — {@code status} stays
 * {@code pending} until a human or the merchant's agent accepts, and no route here can advance it (§109).
 * The holder can only release a hold, which is the one transition that does not require trusting a
 * permission the §5 workspace vocabulary does not yet define (D26).
 */
@RestController
@RequestMapping("/api/v1/reservations")
@RequiresAuth
public class ReservationController {

    /**
     * Contact is an allowlist, not a pass-through: only these three keys reach the {@code contact} jsonb
     * column, so a client cannot park arbitrary personal data (or card data, §42) in our tables.
     */
    public record ContactBody(@Size(max = 120) String name, @Size(max = 40) String phone,
                              @Size(max = 254) String email) {
    }

    public record ReservationBody(@NotNull UUID merchantId, @NotNull UUID slotId,
                                  @NotNull @Min(1) @Max(20) Integer partySize,
                                  ContactBody contact, @Size(max = 500) String notes, UUID offeringId) {
    }

    /**
     * §6 guards the transitions, so this accepts one target state. {@code reason} has no column on
     * {@code reservations}; it is written to the audit event rather than dropped, and the response says
     * so — the alternative is asking a person why they cancelled and throwing the answer away.
     */
    public record PatchBody(String status, @Size(max = 140) String reason) {
    }

    private final ReservationService reservations;
    private final AuditService audit;
    private final PermissionService permissions;

    public ReservationController(ReservationService reservations, AuditService audit,
                                 PermissionService permissions) {
        this.reservations = reservations;
        this.audit = audit;
        this.permissions = permissions;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> book(@Valid @RequestBody ReservationBody body,
                                                    HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        Req.requireCsrfForCookieWrites(request);

        Map<String, Object> slot = reservations.slot(tenant, body.slotId())
                .orElseThrow(() -> ApiException.notFound("slot_not_found",
                        "No such slot in this tenant"));
        if (!body.merchantId().toString().equals(Json.str(slot, "merchant_id"))) {
            throw ApiException.validation("merchant_id does not own this slot",
                    Json.map("slot_id", body.slotId().toString()));
        }
        if (!"published".equals(Json.str(slot, "merchant_status"))) {
            // A draft or suspended merchant is absent from the consumer surface, including its slots (§D24).
            throw ApiException.notFound("merchant_not_found", "No such merchant");
        }
        ReservationService.requireFuture(slot);

        ContactBody contact = body.contact() == null ? new ContactBody(null, null, null) : body.contact();
        if (isBlank(contact.phone()) && isBlank(contact.email())) {
            throw ApiException.validation(
                    "A reservation needs a phone number or an email so the merchant can confirm it",
                    Json.map("fields", java.util.List.of("contact.phone", "contact.email")));
        }
        Map<String, Object> contactRow = new LinkedHashMap<>();
        if (!isBlank(contact.name())) {
            contactRow.put("name", contact.name().trim());
        }
        if (!isBlank(contact.phone())) {
            contactRow.put("phone", contact.phone().trim());
        }
        if (!isBlank(contact.email())) {
            contactRow.put("email", contact.email().trim().toLowerCase());
        }

        ReservationService.Booking booking = reservations.book(tenant, userId, slot, body.partySize(),
                contactRow, blankToNull(body.notes()), body.offeringId());
        Map<String, Object> row = booking.row();
        audit.record(request, "reservation_create", "reservation", Json.uuid(row, "id"),
                Json.uuid(row, "merchant_id"), null,
                Json.map("code", Json.str(row, "code"), "slot_id", Json.str(row, "slot_id"),
                        "party_size", Json.integer(row, "party_size"), "reused", booking.reused()),
                null);

        Map<String, Object> out = new LinkedHashMap<>(view(row, slot));
        out.put("status_note", booking.reused()
                ? "An open booking for this slot and party size already exists; the same code was returned."
                : "Held as pending. The merchant has not confirmed it yet, and the seats are out of the pool now.");
        out.put("slot", slotBlock(booking.slot()));
        return ResponseEntity.status(booking.reused() ? HttpStatus.OK : HttpStatus.CREATED).body(out);
    }

    /**
     * {@code GET /api/v1/reservations/{id}} — the booking as it reads now, for the person it belongs to or
     * for a workspace that can read that merchant's orders.
     *
     * <p>The SDK already shipped this method, so the choice was to serve it or to delete a promised
     * capability. Serving it won because the read is named by a permission §5 already defines
     * ({@code read_orders}), which the write that would advance somebody else's hold is not (D26). Anyone
     * who is neither gets 404, not 403: the route must not confirm that a code exists.
     */
    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable String id, HttpServletRequest request) {
        Map<String, Object> row = requireReadable(request, id);
        return view(row, row);
    }

    /**
     * {@code PATCH /api/v1/reservations/{id}} — release a hold (§6: "status transitions guarded").
     *
     * <p>Only the person the booking is on can release it, and only to {@code cancelled}; the state machine
     * itself is in {@link ReservationService#cancel}, which refuses to rewrite a {@code completed} or
     * {@code no_show} row. A booking that is not yours answers 404 rather than 403 (D5), because the route
     * would otherwise let anyone test whether a code exists. The seats go back to the slot in the same
     * transaction, so {@code slot.capacity_left} in the response is the count after the release.
     */
    @PatchMapping("/{id}")
    public Map<String, Object> patch(@PathVariable String id, @RequestBody PatchBody body,
                                     HttpServletRequest request) {
        Req.requireCsrfForCookieWrites(request);
        Map<String, Object> held = requireHolder(request, id);
        TenantContext tenant = Req.tenant(request);
        String target = body == null ? null : body.status();
        if (target == null || target.isBlank()) {
            throw ApiException.validation("'status' is required; the only transition this route offers is to "
                    + "'cancelled'", Json.map("field", "status", "allowed", java.util.List.of("cancelled")));
        }
        if (!"cancelled".equals(target)) {
            throw ApiException.validation("A reservation can only be moved to 'cancelled'. Advancing a hold to "
                    + "'" + target + "' is the merchant's decision, not this route's",
                    Json.map("field", "status", "allowed", java.util.List.of("cancelled"), "given", target));
        }

        ReservationService.Cancellation cancelled = reservations.cancel(tenant, held);
        String before = Json.str(held, "status");
        Map<String, Object> result = cancelled.row();
        audit.record(request, "reservation_cancel", "reservation", Json.uuid(result, "id"),
                Json.uuid(result, "merchant_id"), Json.map("status", before, "code", Json.str(result, "code")),
                Json.map("status", Json.str(result, "status"), "code", Json.str(result, "code")),
                body.reason() == null ? null : Json.map("reason", body.reason()));

        Map<String, Object> out = new LinkedHashMap<>(view(result, result));
        out.put("status_note", cancelled.replay()
                ? "This booking was already cancelled; nothing changed and no seats were returned twice."
                : "Cancelled. The seats are back in the slot's pool — but the merchant is not notified by this "
                        + "route, so tell them if you have already spoken to them.");
        if (cancelled.slot() != null) {
            out.put("slot", slotBlock(cancelled.slot()));
        }
        return out;
    }

    // ---- authorisation of one booking -----------------------------------

    /** Load by id, tenant-anchored through its merchant: another tenant's booking is absent (D5). */
    private Map<String, Object> load(HttpServletRequest request, String id) {
        UUID reservationId = Json.uuidOrNull(id);
        if (reservationId == null) {
            throw ApiException.validation("'id' must be a uuid", Json.map("field", "id"));
        }
        return reservations.find(Req.tenant(request), reservationId)
                .orElseThrow(() -> ApiException.notFound("reservation_not_found", "No such booking"));
    }

    /**
     * The holder, from the token — never from {@code contact.email}, which the requester typed. A booking
     * with no {@code user_id} was made by an agent or a key and has no holder to release it.
     */
    private Map<String, Object> requireHolder(HttpServletRequest request, String id) {
        Map<String, Object> row = load(request, id);
        UUID userId = Req.userId(request);
        if (userId == null || !userId.equals(Json.uuid(row, "user_id"))) {
            throw ApiException.notFound("reservation_not_found", "No such booking");
        }
        return row;
    }

    /** The holder, or a workspace that may read this merchant's orders. */
    private Map<String, Object> requireReadable(HttpServletRequest request, String id) {
        Map<String, Object> row = load(request, id);
        UUID userId = Req.userId(request);
        if (userId != null && userId.equals(Json.uuid(row, "user_id"))) {
            return row;
        }
        if (!canReadOrders(Req.tenant(request), Req.principal(request), Json.uuid(row, "merchant_id"))) {
            throw ApiException.notFound("reservation_not_found", "No such booking");
        }
        return row;
    }

    /**
     * The same three spellings of one human subject that {@code AuthorizationInterceptor} accepts: a
     * workspace member's grant can be filed under the principal's own subject type, under
     * {@code merchant_user}, or under {@code user} with the membership's user id. Written here instead of
     * shared because the interceptor is a security component another stream is editing, and this call
     * site must not change what it enforces.
     */
    private boolean canReadOrders(TenantContext tenant, Principal principal, UUID merchantId) {
        if (merchantId == null) {
            return false;
        }
        return permissions.has(tenant, principal.subjectType(), principal.subjectId(), merchantId,
                MerchantPermissions.READ_ORDERS)
                || permissions.has(tenant, "merchant_user", principal.subjectId(), merchantId,
                MerchantPermissions.READ_ORDERS)
                || (principal.userId() != null && !principal.userId().equals(principal.subjectId())
                && permissions.has(tenant, "user", principal.userId(), merchantId,
                MerchantPermissions.READ_ORDERS));
    }

    private static Map<String, Object> slotBlock(Map<String, Object> slot) {
        return Json.map("id", Json.str(slot, "id"), "capacity_left", Json.integer(slot, "capacity_left"),
                "as_of", Json.ts(slot, "updated_at"));
    }

    /**
     * The merchant's name and slug come from the context row: {@code insert … returning} only sees the new
     * reservation row, so on a booking the names ride in from the slot, and on a cancellation the re-read
     * row already carries them.
     */
    private static Map<String, Object> view(Map<String, Object> row, Map<String, Object> context) {
        return Json.map("reservation_id", Json.str(row, "id"), "code", Json.str(row, "code"),
                "status", Json.str(row, "status"), "starts_at", Json.ts(row, "starts_at"),
                "ends_at", Json.ts(row, "ends_at"), "party_size", Json.integer(row, "party_size"),
                "price", Json.money(row, "total_amount", "currency"),
                "contact", Json.jsonObject(row, "contact"), "notes", Json.str(row, "notes"),
                "merchant", Json.map("id", Json.str(row, "merchant_id"),
                        "name", orElse(Json.str(row, "merchant_name"), Json.str(context, "merchant_name")),
                        "slug", orElse(Json.str(row, "merchant_slug"), Json.str(context, "merchant_slug"))),
                "created_at", Json.ts(row, "created_at"), "updated_at", Json.ts(row, "updated_at"));
    }

    private static String orElse(String preferred, String fallback) {
        return preferred != null ? preferred : fallback;
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private static String blankToNull(String value) {
        return isBlank(value) ? null : value.trim();
    }
}
