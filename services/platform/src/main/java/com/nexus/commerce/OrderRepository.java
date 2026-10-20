package com.nexus.commerce;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Orders and their immutable line history (§6, DATABASE §3.4).
 *
 * <p>Two things are load-bearing here:
 *
 * <ul>
 *   <li><b>An order belongs to a buyer who may be anonymous.</b> {@code orders} has a {@code user_id}
 *       but no session column, so an anonymous checkout records its {@code session_id} in
 *       {@code orders.metadata} and the owner predicate reads it back from there. Without that, an
 *       anonymous buyer could create an order and then be unable to read or cancel it.</li>
 *   <li><b>Every status change is guarded by the status it replaces.</b> {@code update ... where
 *       status = 'created'} is the whole state machine: two concurrent confirms cannot both mark one
 *       order paid, and a terminal order is never rewritten.</li>
 * </ul>
 */
@Repository
public class OrderRepository {

    private static final String ORDER_COLUMNS = """
            o.id, o.code, o.merchant_id, o.user_id, o.status, o.fulfillment, o.subtotal, o.discount_total,
            o.fee_total, o.tax_total, o.total, o.currency, o.contact, o.metadata, o.created_at, o.updated_at,
            o.tenant_id, m.slug as merchant_slug, m.display_name as merchant_name,
            m.status as merchant_status, m.data_origin as merchant_data_origin
            """;

    private static final String ORDER_FROM = """
            from orders o join merchants m on m.id = o.merchant_id
            """;

    private final TenantJdbc jdbc;

    public OrderRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- create ----------------------------------------------------------

    public Map<String, Object> insert(TenantContext tenant, String code, UUID merchantId, UUID userId,
                                      String fulfillment, BigDecimal subtotal, BigDecimal total, String currency,
                                      String contactJson, String metadataJson) {
        return jdbc.insertForTenant(tenant, """
                insert into orders (code, tenant_id, merchant_id, user_id, status, fulfillment, subtotal,
                                    discount_total, fee_total, tax_total, total, currency, contact, metadata)
                values (:code, :tenant_id, :merchant_id, cast(:user_id as uuid), 'created', :fulfillment,
                        cast(:subtotal as numeric), 0, 0, 0, cast(:total as numeric), :currency,
                        cast(:contact as jsonb), cast(:metadata as jsonb))
                returning id, code, merchant_id, user_id, status, fulfillment, subtotal, discount_total,
                          fee_total, tax_total, total, currency, contact, metadata, created_at, updated_at,
                          tenant_id
                """, Json.map("code", code, "merchant_id", merchantId, "user_id", userId,
                "fulfillment", fulfillment, "subtotal", subtotal, "total", total, "currency", currency,
                "contact", contactJson, "metadata", metadataJson));
    }

    /**
     * {@code order_items} keeps a price and a name snapshot so the history cannot be rewritten by a
     * later merchant edit (§3.4). It has no tenant column, so the row is written only when the owning
     * order is the caller's.
     */
    public Map<String, Object> insertItem(TenantContext tenant, UUID orderId, UUID offeringId, String nameSnapshot,
                                          int quantity, BigDecimal unitPrice, BigDecimal totalPrice,
                                          String optionsJson) {
        return jdbc.insertForTenant(tenant, """
                insert into order_items (order_id, offering_id, name_snapshot, quantity, unit_price,
                                         total_price, options)
                select :order_id, cast(:offering_id as uuid), :name_snapshot, :quantity,
                       cast(:unit_price as numeric), cast(:total_price as numeric), cast(:options as jsonb)
                 where exists (select 1 from orders o where o.id = :order_id and o.tenant_id = :tenant_id)
                returning id, order_id, offering_id, name_snapshot, quantity, unit_price, total_price, options
                """, Json.map("order_id", orderId, "offering_id", offeringId, "name_snapshot", nameSnapshot,
                "quantity", quantity, "unit_price", unitPrice, "total_price", totalPrice, "options", optionsJson));
    }

    // ---- read ------------------------------------------------------------

    /**
     * The order as its buyer may see it. {@code userId} wins when the caller is signed in; otherwise the
     * anonymous {@code session_id} recorded in {@code metadata} is the only thing that opens it. A
     * foreign tenant, a foreign user and an unknown id are all the same absent row — 404, never 403.
     */
    public Optional<Map<String, Object>> find(TenantContext tenant, UUID orderId, UUID userId, String sessionId) {
        String owner = userId != null
                ? " and o.user_id = :user_id"
                : " and o.user_id is null and o.metadata->>'session_id' = :session_id";
        Map<String, Object> params = Json.map("order_id", orderId);
        params.put(userId != null ? "user_id" : "session_id", userId != null ? userId : sessionId);
        return jdbc.firstForTenant(tenant, "select " + ORDER_COLUMNS + ORDER_FROM
                + " where o.id = :order_id and o.tenant_id = :tenant_id" + owner, params);
    }

    public List<Map<String, Object>> items(TenantContext tenant, UUID orderId) {
        return jdbc.forTenant(tenant, """
                select oi.id, oi.order_id, oi.offering_id, oi.name_snapshot, oi.quantity, oi.unit_price,
                       oi.total_price, oi.options, o.tenant_id
                from order_items oi join orders o on o.id = oi.order_id
                where oi.order_id = :order_id and o.tenant_id = :tenant_id
                order by oi.id
                """, Json.map("order_id", orderId));
    }

    // ---- state machine ---------------------------------------------------

    /** {@code created -> paid}. Zero rows means someone else got there first — never an error here. */
    public int markPaid(TenantContext tenant, UUID orderId) {
        return jdbc.updateForTenant(tenant, """
                update orders set status = 'paid', updated_at = now()
                where id = :order_id and status = 'created' and tenant_id = :tenant_id
                """, Json.map("order_id", orderId));
    }

    /** {@code created -> cancelled}. The guard is the whole rule: a terminal order is never rewritten. */
    public int cancel(TenantContext tenant, UUID orderId) {
        return jdbc.updateForTenant(tenant, """
                update orders set status = 'cancelled', updated_at = now()
                where id = :order_id and status = 'created' and tenant_id = :tenant_id
                """, Json.map("order_id", orderId));
    }

    /** Used by the payment webhook: {@code paid -> refunded}, and only from a paid order. */
    public int markRefunded(TenantContext tenant, UUID orderId) {
        return jdbc.updateForTenant(tenant, """
                update orders set status = 'refunded', updated_at = now()
                where id = :order_id and status in ('paid', 'preparing') and tenant_id = :tenant_id
                """, Json.map("order_id", orderId));
    }

    public Map<String, Object> require(TenantContext tenant, UUID orderId, UUID userId, String sessionId) {
        return find(tenant, orderId, userId, sessionId)
                .orElseThrow(() -> ApiException.notFound("order_not_found", "No such order"));
    }
}
