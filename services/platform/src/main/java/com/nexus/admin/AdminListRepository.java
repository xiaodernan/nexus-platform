package com.nexus.admin;

import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Repository;

/**
 * The read side of the §9 admin lists. Nothing here writes, and nothing here returns a row the caller
 * did not ask for.
 *
 * <p>Three rules are enforced by construction rather than by comment:
 * <ul>
 *   <li><b>Every statement is tenant-scoped.</b> All of them go through {@link TenantJdbc#forTenant},
 *       which refuses SQL that does not predicate on {@code tenant_id} — including the two tables that
 *       have no tenant column of their own ({@code trust_signals}, {@code llm_calls}), which are reached
 *       through a JOIN to their tenant-owned parent.</li>
 *   <li><b>Every list is bounded.</b> The caller's {@code limit} is clamped by {@link
 *       com.nexus.platform.Paging} and the row count of the same predicate travels with the page, so a
 *       screen never has to guess how much work is behind it.</li>
 *   <li><b>Ordering is total.</b> Each query's ORDER BY ends in a primary-key tiebreak, so two rows
 *       created in the same millisecond cannot swap places between the first page and the second.</li>
 * </ul>
 *
 * <p>Users are deliberately absent: {@code com.nexus.identity.IdentityRepository} already owns that
 * projection ({@code listUsers}/{@code countUsers}) and a second one is how the same person starts
 * being described two ways (STATUS D24 §1).
 */
@Repository
public class AdminListRepository {

    /** A page of rows plus the count of the predicate that produced it. */
    public record Slice(List<Map<String, Object>> rows, long total) {
    }

    private final TenantJdbc jdbc;

    public AdminListRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- merchants

    private static final String MERCHANT_SELECT = """
            select m.id, m.slug, m.display_name, m.display_name_zh, m.status, m.data_origin,
                   m.category_primary, m.plan, m.ownership_verified, m.rating_agg, m.review_count,
                   m.popularity_score, m.avg_price_hkd, m.price_band, m.created_at, m.updated_at,
                   (select l.district from locations l
                     where l.merchant_id = m.id and l.tenant_id = :tenant_id and l.is_primary
                     limit 1) as district
            from merchants m
            """;

    public Slice merchants(TenantContext tenant, String status, String q, String orderBy, int limit, int offset) {
        StringBuilder where = new StringBuilder("where m.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        if (status != null) {
            where.append(" and m.status = :status");
            params.put("status", status);
        }
        if (q != null) {
            where.append(" and (m.display_name ilike :q or m.slug ilike :q)");
            params.put("q", "%" + q + "%");
        }
        return slice(tenant, MERCHANT_SELECT + where, "select count(*) from merchants m " + where,
                params, orderBy, limit, offset);
    }

    // ---------------------------------------------------------------- orders

    private static final String ORDER_SELECT = """
            select o.id, o.code, o.status, o.fulfillment, o.subtotal, o.discount_total, o.fee_total,
                   o.tax_total, o.total, o.currency, o.created_at, o.updated_at,
                   o.merchant_id, m.display_name as merchant_name, m.slug as merchant_slug,
                   o.user_id, u.display_name as customer_name, cast(u.email as text) as customer_email
            from orders o
            join merchants m on m.id = o.merchant_id and m.tenant_id = :tenant_id
            left join users u on u.id = o.user_id
            """;

    public Slice orders(TenantContext tenant, String status, String orderBy, int limit, int offset) {
        StringBuilder where = new StringBuilder("where o.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        if (status != null) {
            where.append(" and o.status = :status");
            params.put("status", status);
        }
        return slice(tenant, ORDER_SELECT + where, "select count(*) from orders o " + where,
                params, orderBy, limit, offset);
    }

    // ---------------------------------------------------------------- reservations

    private static final String RESERVATION_SELECT = """
            select r.id, r.code, r.status, r.party_size, r.starts_at, r.ends_at, r.total_amount,
                   r.currency, r.source, r.contact, r.created_at, r.updated_at,
                   r.merchant_id, m.display_name as merchant_name, m.slug as merchant_slug,
                   r.user_id, u.display_name as customer_name, cast(u.email as text) as customer_email
            from reservations r
            join merchants m on m.id = r.merchant_id and m.tenant_id = :tenant_id
            left join users u on u.id = r.user_id
            """;

    public Slice reservations(TenantContext tenant, String status, String orderBy, int limit, int offset) {
        StringBuilder where = new StringBuilder("where r.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        if (status != null) {
            where.append(" and r.status = :status");
            params.put("status", status);
        }
        return slice(tenant, RESERVATION_SELECT + where, "select count(*) from reservations r " + where,
                params, orderBy, limit, offset);
    }

    // ---------------------------------------------------------------- reviews

    /**
     * The review body travels as a 200-character excerpt, not in full: 11,000 seeded reviews with their
     * text would turn a 20-row page into a megabyte, and a moderation list only needs enough to decide
     * whether to open the case.
     */
    private static final String REVIEW_SELECT = """
            select r.id, r.rating, r.title, left(r.body, 200) as body_excerpt, r.language, r.status,
                   r.data_origin, r.verified_purchase, r.verified_reservation, r.helpful_count,
                   r.created_at, r.updated_at,
                   r.merchant_id, m.display_name as merchant_name, m.slug as merchant_slug,
                   r.user_id, u.display_name as author_name, r.author_label
            from reviews r
            join merchants m on m.id = r.merchant_id and m.tenant_id = :tenant_id
            left join users u on u.id = r.user_id
            """;

    public Slice reviews(TenantContext tenant, String status, String orderBy, int limit, int offset) {
        StringBuilder where = new StringBuilder("where r.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        if (status != null) {
            where.append(" and r.status = :status");
            params.put("status", status);
        }
        return slice(tenant, REVIEW_SELECT + where, "select count(*) from reviews r " + where,
                params, orderBy, limit, offset);
    }

    // ---------------------------------------------------------------- reports

    /**
     * {@code reports} has no table of its own in V1 (DATABASE.md §3.12 has no such object); the platform's
     * anomaly/detection ledger is {@code trust_signals}, so that is what this serves. The two other
     * candidate meanings — a consumer abuse report and a merchant dispute — would each need a table and a
     * subject model, and inventing one here would be a fake read. See CONTRACT GAP in the controller.
     *
     * <p>{@code trust_signals} carries no {@code tenant_id}: it is scoped through its merchant.
     */
    private static final String REPORT_SELECT = """
            select s.id, s.kind, s.severity, s.score, s.detected_by, s.status, s.evidence, s.created_at,
                   s.merchant_id, m.display_name as merchant_name, m.slug as merchant_slug,
                   m.status as merchant_status, m.data_origin
            from trust_signals s
            join merchants m on m.id = s.merchant_id
            """;

    public Slice reports(TenantContext tenant, String status, String kind, String orderBy, int limit, int offset) {
        StringBuilder where = new StringBuilder("where m.tenant_id = :tenant_id");
        Map<String, Object> params = new LinkedHashMap<>();
        if (status != null) {
            where.append(" and s.status = :status");
            params.put("status", status);
        }
        if (kind != null) {
            where.append(" and s.kind = :kind");
            params.put("kind", kind);
        }
        return slice(tenant, REPORT_SELECT + where, "select count(*) from trust_signals s "
                + "join merchants m on m.id = s.merchant_id " + where, params, orderBy, limit, offset);
    }

    // ---------------------------------------------------------------- shared

    private Slice slice(TenantContext tenant, String select, String count, Map<String, Object> params,
                        String orderBy, int limit, int offset) {
        Map<String, Object> pageParams = new LinkedHashMap<>(params);
        pageParams.put("limit", limit);
        pageParams.put("offset", offset);
        List<Map<String, Object>> rows = jdbc.forTenant(tenant,
                select + " order by " + orderBy + " limit :limit offset :offset", pageParams);
        long total = jdbc.countForTenant(tenant, count, params);
        return new Slice(rows, total);
    }
}
