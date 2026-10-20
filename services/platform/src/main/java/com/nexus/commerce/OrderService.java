package com.nexus.commerce;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import java.math.BigDecimal;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Orders (§6): creation from a priced cart, the status machine, and cancellation.
 *
 * <p>The state machine is written down once, here, and every transition is executed as a guarded
 * {@code update ... where status = :expected} in {@link OrderRepository}. That combination is what
 * makes "a terminal order is never cancelled twice" a property of the SQL rather than a hope about
 * request ordering: the loser of a race gets zero rows and is told what actually happened.
 */
@Service
public class OrderService {

    /** {@code orders.status} domain, DATABASE §3.4. */
    public static final List<String> STATES =
            List.of("created", "paid", "preparing", "completed", "cancelled", "refunded");
    private static final Set<String> TERMINAL = Set.of("completed", "cancelled", "refunded");
    private static final Map<String, List<String>> TRANSITIONS = Map.of(
            "created", List.of("paid", "cancelled"),
            "paid", List.of("preparing", "refunded"),
            "preparing", List.of("completed", "refunded"),
            "completed", List.of(),
            "cancelled", List.of(),
            "refunded", List.of());

    /** The same unambiguous alphabet the reservation code uses: a code is read back over the phone. */
    private static final char[] CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private final OrderRepository orders;
    private final PaymentRepository payments;

    public OrderService(OrderRepository orders, PaymentRepository payments) {
        this.orders = orders;
        this.payments = payments;
    }

    /**
     * One line of a checkout, already priced from the offering/reservation it came from. The price is
     * carried as a value, never read from the request body — a client that could name its own price
     * would be a client buying at a price no merchant offered (§20, §42).
     */
    public record CheckoutLine(UUID offeringId, UUID reservationId, String kind, String name, int quantity,
                               BigDecimal unitPrice, String currency, String optionsJson, String priceSource) {
    }

    public static boolean cancellable(String status) {
        return "created".equals(status);
    }

    public static boolean terminal(String status) {
        return TERMINAL.contains(status);
    }

    public static Map<String, Object> statusMachine(String status) {
        return Json.map("states", STATES,
                "allowed_transitions", TRANSITIONS.getOrDefault(status, List.of()),
                "terminal", terminal(status),
                "cancellable", cancellable(status),
                "note", "A created order can be cancelled or paid. Money that has moved needs the "
                        + "permissioned refund path, not this route (§42).");
    }

    // ---- create ----------------------------------------------------------

    /**
     * Writes the order and its line history in one transaction. Totals are summed from the lines the
     * server derived, so the stored total cannot drift from the stored lines.
     */
    @Transactional
    public Map<String, Object> create(TenantContext tenant, UUID userId, String sessionId, UUID merchantId,
                                      String fulfillment, String contactJson, List<CheckoutLine> lines,
                                      Map<String, Object> metadata) {
        if (lines.isEmpty()) {
            throw ApiException.conflict("cart_empty", "There is nothing to check out",
                    Json.map("resource", "cart", "reason", "no lines"));
        }
        String currency = lines.get(0).currency();
        BigDecimal subtotal = BigDecimal.ZERO;
        for (CheckoutLine line : lines) {
            subtotal = subtotal.add(line.unitPrice().multiply(BigDecimal.valueOf(line.quantity())));
        }
        Map<String, Object> metadataRow = new LinkedHashMap<>(metadata);
        if (sessionId != null) {
            // orders has no session column (CONTRACT GAP), so an anonymous buyer's handle is recorded
            // here and read back by OrderRepository.find() — without it the order would be unreadable.
            metadataRow.put("session_id", sessionId);
        }
        Map<String, Object> order = orders.insert(tenant, newCode(), merchantId, userId, fulfillment, subtotal,
                subtotal, currency, contactJson, Json.write(metadataRow));
        UUID orderId = Json.uuid(order, "id");
        for (CheckoutLine line : lines) {
            orders.insertItem(tenant, orderId, line.offeringId(), line.name(), line.quantity(), line.unitPrice(),
                    line.unitPrice().multiply(BigDecimal.valueOf(line.quantity())), line.optionsJson());
        }
        return orders.require(tenant, orderId, userId, sessionId);
    }

    private static String newCode() {
        StringBuilder suffix = new StringBuilder(6);
        for (int i = 0; i < 6; i++) {
            suffix.append(CODE_ALPHABET[RANDOM.nextInt(CODE_ALPHABET.length)]);
        }
        return "NX-ORD-" + suffix;
    }

    // ---- read ------------------------------------------------------------

    public Map<String, Object> get(TenantContext tenant, UUID userId, String sessionId, UUID orderId) {
        Map<String, Object> order = orders.require(tenant, orderId, userId, sessionId);
        return view(tenant, order);
    }

    public Map<String, Object> view(TenantContext tenant, Map<String, Object> order) {
        UUID orderId = Json.uuid(order, "id");
        String status = Json.str(order, "status");
        String currency = Json.str(order, "currency");
        List<Map<String, Object>> lines = new ArrayList<>();
        for (Map<String, Object> row : orders.items(tenant, orderId)) {
            BigDecimal unit = Json.dec(row, "unit_price");
            BigDecimal total = Json.dec(row, "total_price");
            lines.add(Json.map("order_item_id", Json.str(row, "id"), "offering_id", Json.str(row, "offering_id"),
                    "name_snapshot", Json.str(row, "name_snapshot"), "quantity", Json.integer(row, "quantity"),
                    "unit_price", Json.money(unit, currency), "line_total", Json.money(total, currency),
                    "options", Json.jsonObject(row, "options")));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("order_id", orderId.toString());
        out.put("code", Json.str(order, "code"));
        out.put("status", status);
        out.put("status_machine", statusMachine(status));
        out.put("fulfillment", Json.str(order, "fulfillment"));
        out.put("merchant", Json.map("id", Json.str(order, "merchant_id"), "slug", Json.str(order, "merchant_slug"),
                "name", Json.str(order, "merchant_name"), "status", Json.str(order, "merchant_status")));
        out.put("buyer", buyerOf(order));
        out.put("items", lines);
        out.put("totals", Json.map("subtotal", Json.money(Json.dec(order, "subtotal"), currency),
                "discount_total", Json.money(Json.dec(order, "discount_total"), currency),
                "fee_total", Json.money(Json.dec(order, "fee_total"), currency),
                "tax_total", Json.money(Json.dec(order, "tax_total"), currency),
                "total", Json.money(Json.dec(order, "total"), currency),
                "currency", currency));
        out.put("currency", currency);
        out.put("contact", Json.jsonObject(order, "contact"));
        out.put("payment", payments.latestForOrder(tenant, orderId)
                .map(PaymentService::paymentView).orElse(null));
        out.put("flags", Json.map("demo", com.nexus.platform.DemoFlags.isDemo(
                Json.str(order, "merchant_data_origin"))));
        out.put("created_at", Json.ts(order, "created_at"));
        out.put("updated_at", Json.ts(order, "updated_at"));
        return out;
    }

    private static Map<String, Object> buyerOf(Map<String, Object> order) {
        String userId = Json.str(order, "user_id");
        Map<String, Object> metadata = Json.jsonObject(order, "metadata");
        Object sessionId = metadata.get("session_id");
        return Json.map("type", userId != null ? "user" : "anonymous", "user_id", userId,
                "session_id", sessionId == null ? null : String.valueOf(sessionId));
    }

    // ---- cancel ----------------------------------------------------------

    /**
     * Cancelling follows the machine, it does not override it. A {@code created} order becomes
     * {@code cancelled}; a paid, completed or refunded order answers {@code 409 order_not_cancellable}
     * with the status it actually has, because money has moved and that is a different problem (§42).
     *
     * <p>A second cancel of an order already {@code cancelled} is a <em>replay</em>, not a conflict:
     * it returns 200 with {@code already_cancelled: true} and writes nothing. That is the same answer
     * {@code ReservationService.cancel} has given since D26, and one platform cannot have two meanings
     * for "cancel twice" — the double-tapped button that gets 409 the second time is a client bug report
     * waiting to happen, while the property worth protecting (one row, one write) is asserted by the
     * guarded {@code update ... where status = 'created'} below rather than by the status code.
     */
    @Transactional
    public Map<String, Object> cancel(TenantContext tenant, UUID userId, String sessionId, UUID orderId) {
        Map<String, Object> order = orders.require(tenant, orderId, userId, sessionId);
        String status = Json.str(order, "status");
        boolean replay = "cancelled".equals(status);
        if (!replay && !cancellable(status)) {
            throw notCancellable(orderId, status);
        }
        if (!replay) {
            if (orders.cancel(tenant, orderId) == 0) {
                // Lost a race with a concurrent confirm or cancel: report the state that actually won.
                Map<String, Object> after = orders.require(tenant, orderId, userId, sessionId);
                if ("cancelled".equals(Json.str(after, "status"))) {
                    replay = true;
                } else {
                    throw notCancellable(orderId, Json.str(after, "status"));
                }
            } else {
                payments.failPendingForOrder(tenant, orderId, "order_cancelled");
            }
        }
        Map<String, Object> out = new LinkedHashMap<>(
                view(tenant, orders.require(tenant, orderId, userId, sessionId)));
        out.put("already_cancelled", replay);
        return out;
    }

    private static ApiException notCancellable(UUID orderId, String status) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("order_id", orderId.toString());
        details.put("status", status);
        details.put("allowed", List.of("created"));
        details.put("terminal", terminal(status));
        return ApiException.conflict("order_not_cancellable",
                "Only an order that has not been paid can be cancelled from here (status=" + status
                        + "). A paid order needs the permissioned refund path (§42).",
                details);
    }
}
