package com.nexus.admin;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Repository;

/**
 * The read side of {@code GET /api/v1/admin/search/analytics} (§9).
 *
 * <p>The data source is the platform's own telemetry: {@code events} (§58, DATABASE.md §3.12) and the
 * {@code v_north_star} roll-up over it, which defines a search as {@code events.name = 'search'} and a
 * fulfilled intent as a {@code reserve|purchase|favorite|cart_add} event. Both are read tenant-scoped
 * through {@link TenantJdbc}, so one market's search traffic can never be reported as another's.
 *
 * <p>Every statement is a bounded window, never a full scan: the day series is capped by the caller's
 * {@code days} and a {@code limit}, and the event-name breakdown is a top-N with a total order
 * ({@code events desc, name asc}) so its page boundary is stable.
 */
@Repository
public class AdminSearchAnalyticsRepository {

    private final TenantJdbc jdbc;

    public AdminSearchAnalyticsRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** Totals over the window, from the same view the daily series reads. */
    public Map<String, Object> totals(TenantContext tenant, int windowDays) {
        return jdbc.firstForTenant(tenant, """
                select coalesce(sum(v.searches), 0) as searches,
                       coalesce(sum(v.sessions), 0) as sessions,
                       coalesce(sum(v.fulfilled_intents), 0) as fulfilled_intents,
                       count(*) as active_days
                from v_north_star v
                where v.tenant_id = :tenant_id
                  and v.day >= date_trunc('day', now()) - (:window_days * interval '1 day')
                """, Json.map("window_days", windowDays)).orElse(new java.util.LinkedHashMap<>());
    }

    /** The daily series, newest first, bounded by the window and the caller's limit. */
    public List<Map<String, Object>> daily(TenantContext tenant, int windowDays, int limit) {
        return jdbc.forTenant(tenant, """
                select to_char(v.day, 'YYYY-MM-DD') as day, v.sessions, v.searches, v.fulfilled_intents
                from v_north_star v
                where v.tenant_id = :tenant_id
                  and v.day >= date_trunc('day', now()) - (:window_days * interval '1 day')
                order by v.day desc
                limit :limit
                """, Json.map("window_days", windowDays, "limit", limit));
    }

    /** Event-name breakdown over the window — the raw telemetry the view summarises. */
    public List<Map<String, Object>> byEventName(TenantContext tenant, int windowDays, int limit) {
        return jdbc.forTenant(tenant, """
                select e.name, count(*) as events, count(distinct e.session_id) as sessions
                from events e
                where e.tenant_id = :tenant_id
                  and e.occurred_at >= now() - (:window_days * interval '1 day')
                group by e.name
                order by events desc, e.name asc
                limit :limit
                """, Json.map("window_days", windowDays, "limit", limit));
    }
}
