package com.nexus.commerce;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The §42 order reads and the cancel transition.
 *
 * <p>Ownership is part of the query, not a check after it: {@link OrderService#get} and
 * {@link OrderService#cancel} both take the acting user <em>and</em> the anonymous session id, so an
 * order belonging to somebody else — or to another tenant — reads as absent (404) rather than as a 403
 * that would confirm the order exists.
 *
 * <p>Cancel is deliberately not idempotency-keyed: it is naturally idempotent through the status
 * machine, so a retry reports the state it found instead of needing a key to replay an answer. The
 * transition itself refuses to run twice — {@code cancelled} is terminal — which is what stops a
 * double-tap from releasing capacity twice.
 */
@RestController
@RequestMapping("/api/v1/orders")
public class OrderController {

    private final OrderService orders;

    public OrderController(OrderService orders) {
        this.orders = orders;
    }

    /** {@code GET /api/v1/orders/{id}} — the order and its status machine. */
    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        return orders.get(tenant, Req.userId(request), Req.sessionId(request), requireUuid(id, "id"));
    }

    /**
     * {@code POST /api/v1/orders/{id}/cancel} — cancelling releases whatever the order was holding.
     * An order that is already cancelled (or otherwise terminal) answers with its current state at 200
     * rather than an error: the caller asked for a state the order is already in, and the honest answer
     * is "it is cancelled", not "you cannot cancel it".
     */
    @PostMapping("/{id}/cancel")
    public Map<String, Object> cancel(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        return orders.cancel(tenant, Req.userId(request), Req.sessionId(request), requireUuid(id, "id"));
    }

    private static UUID requireUuid(String raw, String field) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }
}
