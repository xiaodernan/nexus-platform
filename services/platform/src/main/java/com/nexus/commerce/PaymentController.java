package com.nexus.commerce;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Idempotent;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/v1/payments/{order_id}/confirm} — the demo payment provider's door (§42).
 *
 * <p>The whole route exists to be safe on a second call. A buyer double-tapping "pay" must end with one
 * captured payment and one paid order, and the two mechanisms that deliver that are deliberately
 * layered: the {@code Idempotency-Key} replays the recorded answer, and — independently — the capture
 * statement is guarded on {@code status = 'pending'}, so even a keyless retry with a fresh key cannot
 * capture money twice. The second layer is the one that matters, because it holds even when the first
 * is defeated by a client that generates a new key per attempt.
 *
 * <p>{@code changed} in the response distinguishes "this call captured the payment" from "it was
 * already captured and here it is". A caller that only reads {@code payment.status} cannot tell those
 * apart, and the difference is exactly what an operator investigating a double charge needs.
 *
 * <p>The real providers arrive through {@code POST /api/v1/webhooks/payments/{provider}} instead; this
 * route is the demo one, and it says so in its answer rather than pretending to be a card network.
 */
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    /** Providers a client may confirm through this route. A real provider confirms by webhook. */
    private static final List<String> DEMO_PROVIDERS = List.of("demo");

    private final OrderRepository orders;
    private final PaymentRepository payments;
    private final OrderService orderService;
    private final IdempotencyService idempotency;
    private final AuditService audit;

    public PaymentController(OrderRepository orders, PaymentRepository payments, OrderService orderService,
                             IdempotencyService idempotency, AuditService audit) {
        this.orders = orders;
        this.payments = payments;
        this.orderService = orderService;
        this.idempotency = idempotency;
        this.audit = audit;
    }

    @PostMapping("/{order_id}/confirm")
    @RequiresAuth
    @Idempotent(scope = "payment")
    public Map<String, Object> confirm(@PathVariable String order_id,
                                       @RequestBody(required = false) Map<String, Object> body,
                                       HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID orderId = requireUuid(order_id, "order_id");
        UUID userId = Req.userId(request);
        String sessionId = Req.sessionId(request);
        String provider = provider(body);
        String key = request.getHeader("Idempotency-Key");

        return idempotency.run("payment", key, userId, () -> capture(tenant, request, orderId, userId, sessionId,
                provider, key));
    }

    /**
     * One capture attempt. The order is resolved first and tenant-scoped, so an order that is not the
     * caller's is a 404 before anything else can happen — and the amount comes from the order row, never
     * from the request, because §42 makes the platform the only party that may name a price.
     */
    private Map<String, Object> capture(TenantContext tenant, HttpServletRequest request, UUID orderId,
                                        UUID userId, String sessionId, String provider, String key) {
        Map<String, Object> order = orders.require(tenant, orderId, userId, sessionId);

        var alreadyCaptured = payments.capturedForOrder(tenant, orderId);
        if (alreadyCaptured.isPresent()) {
            Map<String, Object> payment = alreadyCaptured.get();
            return Json.map(
                    "order", orderService.view(tenant, order),
                    "payment", PaymentService.paymentView(payment),
                    "changed", false,
                    "already_paid", true,
                    "provider", Json.str(payment, "provider"),
                    "note", "This order was already captured; the existing payment is returned untouched.");
        }

        var pending = payments.pendingForOrder(tenant, orderId);
        Map<String, Object> payment = pending.orElseGet(() -> payments.insert(tenant, orderId, provider, null, key,
                amountOf(order), Json.str(order, "currency"), "pending"));

        UUID paymentId = Json.uuid(payment, "id");
        String providerRef = "demo_" + paymentId;
        int captured = payments.capture(tenant, paymentId, providerRef);
        if (captured == 0) {
            // The guarded update refused: the row left 'pending' between the read and the write. Report
            // what is actually there instead of asserting a capture that did not happen.
            Map<String, Object> current = payments.capturedForOrder(tenant, orderId)
                    .orElseThrow(() -> ApiException.conflict("payment_not_capturable",
                            "The payment for this order is no longer pending and is not captured",
                            Json.map("order_id", orderId.toString())));
            return Json.map(
                    "order", orderService.view(tenant, order),
                    "payment", PaymentService.paymentView(current),
                    "changed", false,
                    "already_paid", true,
                    "note", "The payment had already left 'pending'; the existing state is returned.");
        }

        orders.markPaid(tenant, orderId);
        Map<String, Object> fresh = payments.find(tenant, paymentId).orElse(payment);
        audit.record(request, "confirm_payment", "order", orderId, Json.uuid(order, "merchant_id"),
                null, Json.map("payment_id", paymentId.toString(), "provider", provider, "status", "captured"),
                Json.map("provider_ref", providerRef));

        return Json.map(
                "order", orderService.view(tenant, orders.require(tenant, orderId, userId, sessionId)),
                "payment", PaymentService.paymentView(fresh),
                "changed", true,
                "already_paid", false,
                "provider", provider,
                "note", "Demo provider: no card network was contacted. Real providers confirm by webhook.");
    }

    private static BigDecimal amountOf(Map<String, Object> order) {
        BigDecimal total = Json.dec(order, "total");
        return total == null ? BigDecimal.ZERO : total;
    }

    private static String provider(Map<String, Object> body) {
        Object raw = body == null ? null : body.get("provider");
        String value = raw == null || String.valueOf(raw).isBlank() ? "demo"
                : String.valueOf(raw).trim().toLowerCase(java.util.Locale.ROOT);
        if (!DEMO_PROVIDERS.contains(value)) {
            throw ApiException.validation(
                    "This route confirms the demo provider only; real providers confirm by webhook",
                    Json.map("field", "provider", "allowed", DEMO_PROVIDERS));
        }
        return value;
    }

    private static UUID requireUuid(String raw, String field) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }
}
