package com.nexus.merchant;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Windowed merchant analytics (contract §5, spec §56).
 *
 * <p>Every number here is measured over the caller's window from the platform's own tables, and each
 * one names the table it came from. That is deliberate, because the alternative — reporting the
 * {@code v_merchant_funnel} projection as if it were a time series — would be a lie twice over: the
 * view has no window, and its {@code revenue} column is the fan-out bug D25/STATUS §28 records. So the
 * funnel stays where it is used (the overview, which labels its own definition) and this read answers
 * "what happened between these two instants" from {@code events}, {@code reservations} and
 * {@code orders} directly.
 *
 * <p>{@code events} has no {@code merchant_id}: a merchant-scoped event is identified by
 * {@code subject_type='merchant'} + {@code subject_id}. Every statement also predicates on
 * {@code tenant_id = :tenant_id}, so one market's traffic can never be reported as another's.
 */
@Repository
public class MerchantAnalyticsRepository {

    private final TenantJdbc jdbc;

    public MerchantAnalyticsRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** Event counts by name over the window. An empty window returns no rows — never a zero row. */
    public List<Map<String, Object>> eventCounts(TenantContext tenant, UUID merchantId, Instant from, Instant to) {
        return jdbc.forTenant(tenant, """
                select e.name, count(*) as events, count(distinct e.session_id) as sessions
                from events e
                where e.tenant_id = :tenant_id
                  and e.subject_type = 'merchant' and e.subject_id = :merchant_id
                  and e.occurred_at >= cast(:from as timestamptz)
                  and e.occurred_at < cast(:to as timestamptz)
                group by e.name
                order by events desc, e.name asc
                """, Json.map("merchant_id", merchantId, "from", from.toString(), "to", to.toString()));
    }

    /** Daily event series over the window, oldest first so a chart does not have to reverse it. */
    public List<Map<String, Object>> dailySeries(TenantContext tenant, UUID merchantId, Instant from, Instant to) {
        return jdbc.forTenant(tenant, """
                select to_char(date_trunc('day', e.occurred_at), 'YYYY-MM-DD') as day,
                       count(*) as events
                from events e
                where e.tenant_id = :tenant_id
                  and e.subject_type = 'merchant' and e.subject_id = :merchant_id
                  and e.occurred_at >= cast(:from as timestamptz)
                  and e.occurred_at < cast(:to as timestamptz)
                group by date_trunc('day', e.occurred_at)
                order by date_trunc('day', e.occurred_at) asc
                """, Json.map("merchant_id", merchantId, "from", from.toString(), "to", to.toString()));
    }

    /**
     * Bookings over the window, counted by when they were <em>made</em>. A reservation is windowed on
     * {@code created_at} rather than {@code starts_at}: "how many bookings did I take this month" is a
     * question about the booking, and the seat's own date is a different question the reservations list
     * answers.
     */
    public Map<String, Object> reservations(TenantContext tenant, UUID merchantId, Instant from, Instant to) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as bookings,
                       count(*) filter (where r.status in ('confirmed', 'completed')) as honoured,
                       count(*) filter (where r.status = 'cancelled') as cancelled,
                       coalesce(sum(r.total_amount) filter (where r.status not in ('cancelled')), 0) as booked_value
                from reservations r
                where r.tenant_id = :tenant_id and r.merchant_id = :merchant_id
                  and r.created_at >= cast(:from as timestamptz)
                  and r.created_at < cast(:to as timestamptz)
                """, Json.map("merchant_id", merchantId, "from", from.toString(), "to", to.toString()))
                .orElse(Map.of());
    }

    /**
     * Orders over the window. {@code cancelled} and {@code refunded} are excluded from revenue for the
     * same reason the overview excludes them, and the count that was excluded is reported separately so
     * the two numbers reconcile instead of quietly disagreeing.
     */
    public Map<String, Object> orders(TenantContext tenant, UUID merchantId, Instant from, Instant to) {
        return jdbc.firstForTenant(tenant, """
                select count(*) as orders,
                       count(*) filter (where o.status in ('cancelled', 'refunded')) as voided,
                       coalesce(sum(o.total) filter (where o.status not in ('cancelled', 'refunded')), 0) as revenue,
                       min(o.currency) as currency
                from orders o
                where o.tenant_id = :tenant_id and o.merchant_id = :merchant_id
                  and o.created_at >= cast(:from as timestamptz)
                  and o.created_at < cast(:to as timestamptz)
                """, Json.map("merchant_id", merchantId, "from", from.toString(), "to", to.toString()))
                .orElse(Map.of());
    }

    /** The window's own bounds as the database sees them, so a client can echo what it really got. */
    public Map<String, Object> windowBounds(TenantContext tenant, UUID merchantId, Instant from, Instant to) {
        return jdbc.firstForTenant(tenant, """
                select (select count(*) from events e
                         where e.tenant_id = :tenant_id and e.subject_type = 'merchant'
                           and e.subject_id = :merchant_id) as events_lifetime,
                       (select min(e.occurred_at) from events e
                         where e.tenant_id = :tenant_id and e.subject_type = 'merchant'
                           and e.subject_id = :merchant_id) as first_event_at
                """, Json.map("merchant_id", merchantId)).orElse(Map.of());
    }
}
