package com.nexus.commerce;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Payments (§42). The schema is the policy here: {@code payments.idempotency_key} is {@code NOT NULL
 * UNIQUE}, and no column can hold a card number — {@code client_secret_ref} is a pointer into a
 * provider's vault and stays null for the demo provider (D5, §42).
 *
 * <p>Every statement reaches {@code payments} through the order that owns it, which is both the tenant
 * predicate {@link TenantJdbc} demands and the reason one tenant's payment can never be confirmed
 * through another tenant's request.
 */
@Repository
public class PaymentRepository {

    private static final String COLUMNS = """
            p.id, p.order_id, p.provider, p.provider_ref, p.idempotency_key, p.amount, p.currency,
            p.status, p.client_secret_ref, p.failure_reason, p.captured_at, p.created_at, p.updated_at
            """;

    private static final String FROM = """
            from payments p join orders o on o.id = p.order_id
            """;

    private final TenantJdbc jdbc;

    public PaymentRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** The newest payment attempt for an order — pending, captured or failed. */
    public Optional<Map<String, Object>> latestForOrder(TenantContext tenant, UUID orderId) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + FROM
                + " where p.order_id = :order_id and o.tenant_id = :tenant_id"
                + " order by p.created_at desc limit 1", Json.map("order_id", orderId));
    }

    /** Money that has actually moved. This is the row a second confirm must return instead of writing. */
    public Optional<Map<String, Object>> capturedForOrder(TenantContext tenant, UUID orderId) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + FROM
                + " where p.order_id = :order_id and o.tenant_id = :tenant_id"
                + " and p.status in ('captured', 'authorized') order by p.captured_at desc nulls last limit 1",
                Json.map("order_id", orderId));
    }

    public Optional<Map<String, Object>> pendingForOrder(TenantContext tenant, UUID orderId) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + FROM
                + " where p.order_id = :order_id and o.tenant_id = :tenant_id and p.status = 'pending'"
                + " order by p.created_at desc limit 1", Json.map("order_id", orderId));
    }

    public Optional<Map<String, Object>> find(TenantContext tenant, UUID paymentId) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + FROM
                + " where p.id = :payment_id and o.tenant_id = :tenant_id", Json.map("payment_id", paymentId));
    }

    /** A provider names its own object, so a webhook is resolved by (provider, provider_ref) first. */
    public Optional<Map<String, Object>> byProviderRef(TenantContext tenant, String provider, String providerRef) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + FROM
                + " where p.provider = :provider and p.provider_ref = :provider_ref and o.tenant_id = :tenant_id"
                + " order by p.created_at desc limit 1",
                Json.map("provider", provider, "provider_ref", providerRef));
    }

    /**
     * {@code payments} has no tenant column, so the insert carries its own guard: it writes only when
     * the order it belongs to is the caller's.
     */
    public Map<String, Object> insert(TenantContext tenant, UUID orderId, String provider, String providerRef,
                                      String idempotencyKey, BigDecimal amount, String currency, String status) {
        return jdbc.insertForTenant(tenant, """
                insert into payments (order_id, provider, provider_ref, idempotency_key, amount, currency,
                                      status, captured_at)
                select :order_id, :provider, cast(:provider_ref as text), :idempotency_key,
                       cast(:amount as numeric), :currency, :status,
                       case when :status = 'captured' then now() else null end
                 where exists (select 1 from orders o where o.id = :order_id and o.tenant_id = :tenant_id)
                returning id, order_id, provider, provider_ref, idempotency_key, amount, currency, status,
                          client_secret_ref, failure_reason, captured_at, created_at, updated_at
                """, Json.map("order_id", orderId, "provider", provider, "provider_ref", providerRef,
                "idempotency_key", idempotencyKey, "amount", amount, "currency", currency, "status", status));
    }

    /**
     * {@code pending -> captured}, guarded on the status it replaces. Zero rows is the answer "this
     * payment was already captured or already failed", which the caller reports rather than retries.
     */
    public int capture(TenantContext tenant, UUID paymentId, String providerRef) {
        return jdbc.updateForTenant(tenant, """
                update payments p
                   set status = 'captured', provider_ref = cast(:provider_ref as text), captured_at = now(),
                       failure_reason = null, updated_at = now()
                  from orders o
                 where p.id = :payment_id and o.id = p.order_id and o.tenant_id = :tenant_id
                   and p.status = 'pending'
                """, Json.map("payment_id", paymentId, "provider_ref", providerRef));
    }

    public int fail(TenantContext tenant, UUID paymentId, String reason) {
        return jdbc.updateForTenant(tenant, """
                update payments p
                   set status = 'failed', failure_reason = cast(:reason as text), updated_at = now()
                  from orders o
                 where p.id = :payment_id and o.id = p.order_id and o.tenant_id = :tenant_id
                   and p.status = 'pending'
                """, Json.map("payment_id", paymentId, "reason", reason));
    }

    /** Refunds a captured payment. Reached only from a verified provider webhook, never from a client. */
    public int refund(TenantContext tenant, UUID paymentId, String reason) {
        return jdbc.updateForTenant(tenant, """
                update payments p
                   set status = 'refunded', failure_reason = cast(:reason as text), updated_at = now()
                  from orders o
                 where p.id = :payment_id and o.id = p.order_id and o.tenant_id = :tenant_id
                   and p.status in ('captured', 'authorized')
                """, Json.map("payment_id", paymentId, "reason", reason));
    }

    /** The pending payment of an order, if any — cancelled alongside the order so nothing is left open. */
    public int failPendingForOrder(TenantContext tenant, UUID orderId, String reason) {
        return jdbc.updateForTenant(tenant, """
                update payments p
                   set status = 'failed', failure_reason = cast(:reason as text), updated_at = now()
                  from orders o
                 where p.order_id = :order_id and o.id = p.order_id and o.tenant_id = :tenant_id
                   and p.status = 'pending'
                """, Json.map("order_id", orderId, "reason", reason));
    }
}
