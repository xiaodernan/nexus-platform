package com.nexus.catalog;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Reservations (§40) — the one write path that turns a slot the consumer page displayed into seats
 * somebody is committed to. {@code availability_slots} has no tenant column, so every statement
 * reaches it through the merchant that owns it; that join is also what makes another tenant's slot
 * read as absent ({@code 404}) rather than forbidden, which is the tenancy rule the whole suite proves.
 */
@Repository
public class ReservationRepository {

    private final TenantJdbc jdbc;

    public ReservationRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** The slot exactly as the booking decision needs it: its window, what is left, what it costs, who owns it. */
    public Optional<Map<String, Object>> slot(TenantContext tenant, UUID slotId) {
        return jdbc.firstForTenant(tenant, """
                select s.id, s.merchant_id, s.pool_id, s.starts_at, s.ends_at, s.capacity_total, s.capacity_left,
                       s.price_amount, s.currency, m.status as merchant_status, m.slug as merchant_slug,
                       m.display_name as merchant_name, m.tenant_id
                from availability_slots s join merchants m on m.id = s.merchant_id
                where s.id = :slot_id and m.tenant_id = :tenant_id
                """, Json.map("slot_id", slotId));
    }

    /**
     * Claim the seats in the same statement that decides whether they exist: {@code capacity_left >=
     * :party_size} is the guard, so two bookings of the last table cannot both see room. Zero rows is not
     * an error here — it is the answer "someone took them first", which the caller turns into a 409.
     */
    public int claim(TenantContext tenant, UUID slotId, int partySize) {
        return jdbc.updateForTenant(tenant, """
                update availability_slots s
                   set capacity_left = s.capacity_left - :party_size, updated_at = now()
                  from merchants m
                 where s.id = :slot_id and m.id = s.merchant_id and m.tenant_id = :tenant_id
                   and s.capacity_left >= :party_size
                """, Json.map("slot_id", slotId, "party_size", partySize));
    }

    /**
     * Replay guard: one person holds one live booking per slot (V2's partial unique index on
     * {@code (slot_id, user_id) where status in ('pending','confirmed')}), so this must not filter on
     * {@code party_size} — matching the index's own key. The caller compares the party size and either
     * replays the same code or refuses to take a second table, which is the only reading of the rule
     * that cannot end in a duplicate-key 500.
     */
    public Optional<Map<String, Object>> existing(TenantContext tenant, UUID userId, UUID slotId) {
        return jdbc.firstForTenant(tenant, """
                select r.id, r.code, r.status, r.starts_at, r.ends_at, r.party_size, r.total_amount, r.currency,
                       r.contact, r.notes, r.slot_id, r.offering_id, r.merchant_id, r.created_at, r.user_id,
                       m.slug as merchant_slug, m.display_name as merchant_name, r.tenant_id
                from reservations r join merchants m on m.id = r.merchant_id
                where r.user_id = :user_id and r.slot_id = :slot_id
                  and r.status in ('pending', 'confirmed') and m.tenant_id = :tenant_id
                order by r.created_at desc limit 1
                """, Json.map("user_id", userId, "slot_id", slotId));
    }

    /** A single booking, tenant-anchored through its merchant, plus who holds it and what it cites. */
    public Optional<Map<String, Object>> byId(TenantContext tenant, UUID reservationId) {
        return jdbc.firstForTenant(tenant, """
                select r.id, r.code, r.status, r.starts_at, r.ends_at, r.party_size, r.total_amount, r.currency,
                       r.contact, r.notes, r.slot_id, r.offering_id, r.merchant_id, r.user_id, r.source,
                       r.created_at, r.updated_at,
                       m.slug as merchant_slug, m.display_name as merchant_name, m.tenant_id
                from reservations r join merchants m on m.id = r.merchant_id
                where r.id = :reservation_id and m.tenant_id = :tenant_id
                """, Json.map("reservation_id", reservationId));
    }

    public Map<String, Object> insert(TenantContext tenant, UUID userId, Map<String, Object> slot, String code,
                                      int partySize, Map<String, Object> contact, String notes, UUID offeringId) {
        return jdbc.insertForTenant(tenant, """
                insert into reservations (code, tenant_id, merchant_id, user_id, offering_id, slot_id, party_size,
                                          contact, starts_at, ends_at, status, total_amount, currency, notes, source)
                values (:code, :tenant_id, :merchant_id, :user_id, cast(:offering_id as uuid), :slot_id,
                        :party_size, cast(:contact as jsonb), :starts_at, :ends_at, 'pending',
                        cast(:total_amount as numeric), :currency, cast(:notes as text), 'consumer')
                returning id, code, status, starts_at, ends_at, party_size, total_amount, currency, contact, notes,
                          merchant_id, slot_id, offering_id, created_at
                """, Json.map("code", code, "tenant_id", tenant.tenantId(),
                "merchant_id", Json.uuid(slot, "merchant_id"), "user_id", userId,
                "offering_id", offeringId, "slot_id", Json.uuid(slot, "id"), "party_size", partySize,
                "contact", Json.write(contact), "starts_at", slot.get("starts_at"),
                "ends_at", slot.get("ends_at"),
                "total_amount", Json.dec(slot, "price_amount"), "currency", Json.str(slot, "currency"),
                "notes", notes));
    }

    /** What the slot looks like after the claim — returned so the page cannot show a stale seat count. */
    public Optional<Map<String, Object>> slotAfter(TenantContext tenant, UUID slotId) {
        return jdbc.firstForTenant(tenant, """
                select s.id, s.capacity_left, s.updated_at, m.tenant_id
                from availability_slots s join merchants m on m.id = s.merchant_id
                where s.id = :slot_id and m.tenant_id = :tenant_id
                """, Json.map("slot_id", slotId));
    }

    /**
     * Release the hold, and only from a state that still holds seats. The guard is in the statement, not
     * in the caller, so a double-tapped cancel cannot cancel twice — and the second call returns zero
     * rows, which the service reads as "already cancelled" instead of a second restore.
     */
    public int cancel(TenantContext tenant, UUID reservationId) {
        return jdbc.updateForTenant(tenant, """
                update reservations r
                   set status = 'cancelled', updated_at = now()
                  from merchants m
                 where r.id = :reservation_id and m.id = r.merchant_id and m.tenant_id = :tenant_id
                   and r.status in ('pending', 'confirmed')
                """, Json.map("reservation_id", reservationId));
    }

    /**
     * The merchant's booking inbox (§23): holds on this merchant's tables, soonest first. The predicate
     * is written once ({@link #inboxScope}) and reused by {@link #inboxCount} — a count that drifts from
     * the list would make {@code total_estimate} a different question than the page answers.
     */
    public List<Map<String, Object>> inbox(TenantContext tenant, UUID merchantId, String status,
                                           Instant from, Instant to, int limit, int offset) {
        Scope scope = inboxScope(merchantId, status, from, to);
        Map<String, Object> params = new LinkedHashMap<>(scope.params());
        params.put("tenant_id", tenant.tenantId());
        params.put("limit", limit);
        params.put("offset", offset);
        return jdbc.forTenant(tenant, """
                select r.id, r.code, r.status, r.source, r.starts_at, r.ends_at, r.party_size,
                       r.total_amount, r.currency, r.contact, r.notes, r.slot_id, r.offering_id,
                       r.user_id, r.merchant_id, r.created_at, r.updated_at, m.tenant_id
                from reservations r join merchants m on m.id = r.merchant_id
                """ + " where " + scope.where() + " order by r.starts_at asc, r.created_at asc"
                + " limit :limit offset :offset", params);
    }

    public long inboxCount(TenantContext tenant, UUID merchantId, String status, Instant from, Instant to) {
        Scope scope = inboxScope(merchantId, status, from, to);
        Map<String, Object> params = new LinkedHashMap<>(scope.params());
        params.put("tenant_id", tenant.tenantId());
        return jdbc.countForTenant(tenant,
                "select count(*) from reservations r join merchants m on m.id = r.merchant_id where "
                        + scope.where(), params);
    }

    /**
     * {@code m.tenant_id} is the tenancy guard and {@code r.merchant_id} the scope — both, deliberately.
     * {@code reservations} carries its own {@code tenant_id} column, but the row's merchant is what makes
     * it this merchant's inbox, and a booking whose merchant moved tenant would otherwise read twice.
     */
    private static Scope inboxScope(UUID merchantId, String status, Instant from, Instant to) {
        StringBuilder where = new StringBuilder("m.tenant_id = :tenant_id and r.merchant_id = :merchant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("merchant_id", merchantId);
        if (status != null) {
            where.append(" and r.status = :status");
            params.put("status", status);
        }
        if (from != null) {
            where.append(" and r.starts_at >= :from");
            params.put("from", Timestamp.from(from));
        }
        if (to != null) {
            // Half-open: `to` is the end of the window, not a booking to include.
            where.append(" and r.starts_at < :to");
            params.put("to", Timestamp.from(to));
        }
        return new Scope(where.toString(), params);
    }

    private record Scope(String where, Map<String, Object> params) {
    }

    /**
     * Put the seats back. {@code least(...)} keeps the update inside {@code
     * availability_slots_capacity_bounds}: a merchant who shrank the pool after this booking would
     * otherwise make the restore fail the CHECK, and a booking that cannot be released cleanly is worse
     * for the diner than a slot that reads one seat short of its new total.
     */
    public int restore(TenantContext tenant, UUID slotId, int partySize) {
        return jdbc.updateForTenant(tenant, """
                update availability_slots s
                   set capacity_left = least(s.capacity_left + :party_size, s.capacity_total), updated_at = now()
                  from merchants m
                 where s.id = :slot_id and m.id = s.merchant_id and m.tenant_id = :tenant_id
                   and s.capacity_left < s.capacity_total
                """, Json.map("slot_id", slotId, "party_size", partySize));
    }
}
