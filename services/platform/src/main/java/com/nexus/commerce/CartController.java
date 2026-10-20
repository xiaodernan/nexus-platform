package com.nexus.commerce;

import com.nexus.platform.ApiException;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Idempotent;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The §41 universal cart over HTTP: products, services and reservations in one cart, owned by a signed-in
 * user or by an anonymous {@code session_id}.
 *
 * <p>This is the controller the commerce service layer shipped without, so every §6 cart route answered
 * 404 while {@link CartService} already held the semantics — the price re-derivation, the TTL verdict and
 * the multi-merchant refusal. What lives here is only the HTTP shape: which verb maps to which service
 * call, which status code a create returns, and the idempotency wrapper the checkout needs.
 *
 * <p>Two things are deliberately not re-implemented here. The caller's identity is resolved by
 * {@link CartService.Subject#of(HttpServletRequest)} — one definition of "whose cart is this", shared by
 * every route — and the price a buyer sees is always the service's verdict, never the request body's:
 * a client that sends {@code unit_price} has it ignored, because §20/§42 make the platform the only
 * source of a price.
 */
@RestController
@RequestMapping("/api/v1/carts")
public class CartController {

    private final CartService carts;
    private final IdempotencyService idempotency;

    public CartController(CartService carts, IdempotencyService idempotency) {
        this.carts = carts;
        this.idempotency = idempotency;
    }

    /**
     * {@code POST /api/v1/carts} — creates the caller's cart, or hands back the one they already have.
     * Anonymous callers are allowed: the cart is keyed by {@code session_id}, which is what makes
     * "add to cart before signing in" possible at all.
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody(required = false) Map<String, Object> body,
                                                      HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> cart = carts.currentOrCreate(tenant, CartService.Subject.of(request));
        return ResponseEntity.status(HttpStatus.CREATED).body(carts.view(tenant, cart));
    }

    /**
     * {@code GET /api/v1/carts/current} — the universal cart. Materialised on demand rather than 404ing
     * for a caller who has none: the SDK's {@code addItem()} carries no cart id, so "the current cart"
     * has to be resolvable per subject, and an empty cart row costs one reapable tuple (the contract gap
     * is recorded on {@link CartService#currentOrCreate}).
     */
    @GetMapping("/current")
    public Map<String, Object> current(HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        // The projection, not the row: the row's key is `id` while every consumer of this route reads
        // `cart_id`, and a cart with no printed id is a handle the client cannot use (the same reason
        // currentOrCreate materialises one instead of 404ing).
        return carts.view(tenant, carts.currentOrCreate(tenant, CartService.Subject.of(request)));
    }

    /** {@code POST /api/v1/carts/items} — adds one offering or one reservation, never both. */
    @PostMapping("/items")
    public ResponseEntity<Map<String, Object>> addItem(@RequestBody Map<String, Object> body,
                                                       HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID offeringId = Json.uuidOrNull(text(body.get("offering_id")));
        UUID reservationId = Json.uuidOrNull(text(body.get("reservation_id")));
        if (body.get("offering_id") != null && offeringId == null) {
            throw ApiException.validation("offering_id must be a uuid", Json.map("field", "offering_id"));
        }
        if (body.get("reservation_id") != null && reservationId == null) {
            throw ApiException.validation("reservation_id must be a uuid", Json.map("field", "reservation_id"));
        }
        Integer quantity = integer(body.get("quantity"), "quantity");
        Map<String, Object> options = options(body.get("options"));
        Map<String, Object> cart = carts.addItem(tenant, CartService.Subject.of(request), offeringId,
                reservationId, quantity, options);
        return ResponseEntity.status(HttpStatus.CREATED).body(cart);
    }

    /** {@code PATCH /api/v1/carts/items/{id}} — quantity and/or options on one line. */
    @PatchMapping("/items/{id}")
    public Map<String, Object> patchItem(@PathVariable String id, @RequestBody Map<String, Object> body,
                                         HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID itemId = requireUuid(id, "id");
        Integer quantity = integer(body.get("quantity"), "quantity");
        Map<String, Object> options = body.containsKey("options") ? options(body.get("options")) : null;
        return carts.updateItem(tenant, CartService.Subject.of(request), itemId, quantity, options);
    }

    /** {@code DELETE /api/v1/carts/items/{id}} — removing a line never touches another cart's line. */
    @DeleteMapping("/items/{id}")
    public Map<String, Object> removeItem(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        return carts.removeItem(tenant, CartService.Subject.of(request), requireUuid(id, "id"));
    }

    /**
     * {@code POST /api/v1/carts/price-check} — the per-line {@code stale} verdict a client must show
     * before checkout (§103). A read: it reports what changed, it does not change a price.
     */
    @PostMapping("/price-check")
    public Map<String, Object> priceCheck(HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        return carts.priceCheck(tenant, CartService.Subject.of(request));
    }

    /**
     * {@code POST /api/v1/carts/checkout} — cart to order plus payment intent.
     *
     * <p>{@code Idempotency-Key} is required, not optional (§1). The header is what makes a double-tapped
     * confirm replay the recorded {@code {order, payment_intent}} instead of taking a second payment, and
     * the annotation is what makes the interceptor refuse a keyless request before
     * {@link IdempotencyService#run} is reached with a {@code null} key.
     */
    @PostMapping("/checkout")
    @RequiresAuth
    @Idempotent(scope = "checkout")
    public Map<String, Object> checkout(@RequestBody(required = false) Map<String, Object> body,
                                        HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        CartService.Subject subject = CartService.Subject.of(request);
        String key = request.getHeader("Idempotency-Key");
        Map<String, Object> payload = body == null ? Map.of() : body;
        return idempotency.run("checkout", key, subject.ownerId(),
                () -> carts.checkout(tenant, subject, key, payload));
    }

    // ==================================================================== request shape

    private static String text(Object raw) {
        return raw == null ? null : String.valueOf(raw);
    }

    private static Integer integer(Object raw, String field) {
        if (raw == null || String.valueOf(raw).isBlank()) {
            return null;
        }
        try {
            return Integer.valueOf(String.valueOf(raw).trim());
        } catch (NumberFormatException e) {
            throw ApiException.validation(field + " must be an integer", Json.map("field", field));
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> options(Object raw) {
        if (raw == null) {
            return Map.of();
        }
        if (!(raw instanceof Map<?, ?> map)) {
            throw ApiException.validation("options must be an object", Json.map("field", "options"));
        }
        return (Map<String, Object>) map;
    }

    private static UUID requireUuid(String raw, String field) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }
}
