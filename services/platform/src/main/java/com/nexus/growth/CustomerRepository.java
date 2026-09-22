package com.nexus.growth;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Customer relationships for one merchant, derived only from real transaction rows
 * ({@code orders} + {@code reservations}) — API_CONTRACT §3 says merchant-side customer data
 * goes through {@code /api/v1/merchant/customers}, and §23/§56 define the Customers screen on
 * genuine purchase/reservation history. Telemetry events are deliberately not part of this: an
 * event is an observation, never a customer record (§11/§66).
 *
 * <p>A merchant that nobody has transacted with yet gets an honest empty page, not a plausible
 * list (DECISIONS D6).
 */
@Repository
public class CustomerRepository {

    /**
     * Per-merchant transactions in the window, unioned from the two tables that prove a customer
     * relationship. Cancelled/refunded rows are excluded so spend and counts reflect completed
     * business only — the same status filter {@code v_merchant_funnel} uses.
     */
    private static final String TRANSACTIONS_CTE = """
            with tx as (
              select o.user_id, 'order'::text as kind, o.total as amount, o.currency, o.created_at as at
              from orders o
              where o.merchant_id = :merchant_id and o.tenant_id = :tenant_id and o.user_id is not null
                and o.status not in ('cancelled', 'refunded')
              union all
              select r.user_id, 'reservation'::text, r.total_amount, r.currency, r.created_at
              from reservations r
              where r.merchant_id = :merchant_id and r.tenant_id = :tenant_id and r.user_id is not null
                and r.status <> 'cancelled'
            )""";

    private final TenantJdbc jdbc;

    public CustomerRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** Identity + honesty columns for the merchant row itself. */
    public Optional<Map<String, Object>> merchantRow(TenantContext tenant, UUID merchantId) {
        return jdbc.firstForTenant(tenant, """
                select m.id, m.slug, m.display_name, m.status, m.data_origin, m.tenant_id
                from merchants m
                where m.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", merchantId));
    }

    public List<Map<String, Object>> customers(TenantContext tenant, UUID merchantId, String segment,
                                               int limit, int offset) {
        String sql = TRANSACTIONS_CTE + """
                select u.id as user_id, u.display_name, u.email,
                       count(*)                                    as transactions,
                       count(*) filter (where t.kind = 'order')      as orders,
                       count(*) filter (where t.kind = 'reservation') as reservations,
                       coalesce(sum(t.amount) filter (where t.kind = 'order'), 0) as spend_amount,
                       min(t.currency) filter (where t.kind = 'order')            as spend_currency,
                       min(t.at)  as first_seen_at,
                       max(t.at)  as last_seen_at
                from tx t
                join users u on u.id = t.user_id
                where u.tenant_id = :tenant_id
                group by u.id, u.display_name, u.email
                having (:segment <> 'repeat' or count(*) >= 2)
                   and (:segment <> 'new' or count(*) = 1)
                order by max(t.at) desc, u.id
                limit :limit offset :offset
                """;
        return jdbc.forTenant(tenant, sql, Json.map("merchant_id", merchantId, "segment", segment,
                "limit", limit, "offset", offset));
    }

    public long countCustomers(TenantContext tenant, UUID merchantId, String segment) {
        String sql = TRANSACTIONS_CTE + """
                select count(*)
                from (
                  select t.user_id
                  from tx t
                  join users u on u.id = t.user_id
                  where u.tenant_id = :tenant_id
                  group by t.user_id
                  having (:segment <> 'repeat' or count(*) >= 2)
                     and (:segment <> 'new' or count(*) = 1)
                ) c
                """;
        return jdbc.countForTenant(tenant, sql, Json.map("merchant_id", merchantId, "segment", segment));
    }
}
