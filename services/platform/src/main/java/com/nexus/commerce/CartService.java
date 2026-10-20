package com.nexus.commerce;

import com.nexus.catalog.FactRepository;
import com.nexus.platform.ApiException;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Json;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The universal cart (§41, §42) — products, services and reservations in one cart, owned by a user or
 * by an anonymous {@code session_id}.
 *
 * <p>Three rules shape this class, and each of them exists because the alternative is a lie:
 *
 * <ul>
 *   <li><b>A client never names a price.</b> {@code unit_price} is always derived here from the
 *       {@code offerings} row (or from the reservation the buyer already holds), never read from the
 *       request body (§20, §42). The request may name <em>what</em> to buy, never <em>what it costs</em>.</li>
 *   <li><b>One price assessment, two callers.</b> {@link #lines} produces the per-line verdict that
 *       both {@code price-check} and {@code checkout} act on, so the flag the buyer is shown and the
 *       flag that blocks the charge can never disagree — the same one-projection rule D24 applied to
 *       the merchant card.</li>
 *   <li><b>Nothing is charged silently.</b> {@code checkout} refuses when a line's stored price is no
 *       longer the price the offering carries, or when the line can no longer be bought at all. The
 *       buyer is sent back to the cart rather than charged a number they never saw (§103).</li>
 * </ul>
 */
@Service
public class CartService {

    /**
     * The §5 freshness class for a price quote, read from the one place that already defines it
     * ({@link FactRepository#PRICE_TTL}) so the cart and the fact writer cannot drift apart.
     */
    public static final Duration PRICE_QUOTE_TTL = FactRepository.PRICE_TTL;

    static final int MAX_QUANTITY = 99;
    private static final Set<String> OFFERING_KINDS = Set.of("product", "service", "experience");
    private static final Set<String> FULFILLMENTS =
            Set.of("pickup", "delivery", "dine_in", "reservation", "virtual");
    private static final List<String> CONTACT_FIELDS = List.of("name", "phone", "email");

    private final CartRepository carts;
    private final OrderService orders;
    private final PaymentRepository payments;

    public CartService(CartRepository carts, OrderService orders, PaymentRepository payments) {
        this.carts = carts;
        this.orders = orders;
        this.payments = payments;
    }

    /**
     * Who a cart belongs to. A signed-in caller owns it by {@code user_id}; everyone else owns it by the
     * anonymous {@code session_id} the client carries in {@code X-Session-Id} (§1, §41). The two are
     * never mixed: a cart is not silently adopted when someone signs in mid-session.
     */
    public record Subject(String type, UUID userId, String sessionId) {

        public static Subject of(HttpServletRequest request) {
            Principal principal = Req.principalOrNull(request);
            if (principal != null && principal.userId() != null) {
                return new Subject("user", principal.userId(), null);
            }
            return new Subject("session", null, Req.sessionId(request));
        }

        /** The idempotency owner binding: a signed-in buyer's key is theirs alone. */
        public UUID ownerId() {
            return userId;
        }
    }

    // ---- resolving "the current cart" ------------------------------------

    public Optional<Map<String, Object>> current(TenantContext tenant, Subject subject) {
        return subject.userId() != null
                ? carts.openForUser(tenant, subject.userId())
                : carts.openForSession(tenant, subject.sessionId());
    }

    /**
     * Resolve the caller's open cart, creating one if there is none.
     *
     * <p>// CONTRACT GAP: §6 documents {@code GET /carts/current} as a read and {@code POST /carts} as
     * the create, but the SDK's {@code addItem()} carries no cart id, so "the current cart" has to be
     * resolvable per subject. We materialise it on demand instead of answering 404, because a cart
     * with no id is a handle the client cannot use — and an empty cart row costs one tuple, with
     * {@code carts.expires_at} set so it is reapable.
     */
    public Map<String, Object> currentOrCreate(TenantContext tenant, Subject subject) {
        Optional<Map<String, Object>> existing = current(tenant, subject);
        if (existing.isPresent()) {
            return existing.get();
        }
        return carts.insert(tenant, subject.userId(), subject.sessionId());
    }

    /** The cart as the client sees it, including every line's price verdict. */
    public Map<String, Object> view(TenantContext tenant, Map<String, Object> cart) {
        return view(tenant, cart, lines(tenant, Json.uuid(cart, "id")));
    }

    private Map<String, Object> view(TenantContext tenant, Map<String, Object> cart,
                                     List<Map<String, Object>> lines) {
        String currency = lines.isEmpty() ? defaultCurrency(tenant)
                : String.valueOf(lines.get(0).get("currency"));
        BigDecimal subtotal = BigDecimal.ZERO;
        BigDecimal currentSubtotal = BigDecimal.ZERO;
        int quantityCount = 0;
        Set<String> merchantKeys = new LinkedHashSet<>();
        List<Map<String, Object>> merchants = new ArrayList<>();
        for (Map<String, Object> line : lines) {
            subtotal = subtotal.add(money(line.get("line_total")));
            currentSubtotal = currentSubtotal.add(money(line.get("current_line_total")));
            quantityCount += ((Number) line.get("quantity")).intValue();
            @SuppressWarnings("unchecked")
            Map<String, Object> merchant = (Map<String, Object>) line.get("merchant");
            if (merchant != null && merchant.get("id") != null && merchantKeys.add(String.valueOf(merchant.get("id")))) {
                merchants.add(merchant);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cart_id", Json.str(cart, "id"));
        out.put("status", Json.str(cart, "status"));
        out.put("owner", Json.map("type", Json.str(cart, "user_id") != null ? "user" : "session",
                "user_id", Json.str(cart, "user_id"), "session_id", Json.str(cart, "session_id")));
        out.put("merchant", merchants.size() == 1 ? merchants.get(0) : null);
        out.put("merchants", merchants);
        out.put("items", lines);
        out.put("item_count", lines.size());
        out.put("quantity_count", quantityCount);
        out.put("currency", currency);
        out.put("totals", Json.map("subtotal", Json.money(subtotal, currency),
                "current_subtotal", Json.money(currentSubtotal, currency),
                "currency", currency,
                "note", "subtotal is the sum of the prices the cart holds; current_subtotal re-derives "
                        + "each line from the offering as it stands now."));
        out.put("any_stale", lines.stream().anyMatch(l -> Boolean.TRUE.equals(l.get("stale"))));
        out.put("expires_at", Json.ts(cart, "expires_at"));
        out.put("created_at", Json.ts(cart, "created_at"));
        out.put("updated_at", Json.ts(cart, "updated_at"));
        return out;
    }

    private String defaultCurrency(TenantContext tenant) {
        return tenant.currency() == null || tenant.currency().isBlank() ? "HKD" : tenant.currency();
    }

    /**
     * Read an amount out of either a row column or the {@code {amount, currency}} object the wire layer
     * already emitted.
     *
     * <p>The totals loop sums the <em>view</em>'s own {@code line_total}/{@code current_line_total}, and
     * those are {@link Json#money} objects, not columns: stringifying one produced
     * {@code "{amount=200.00, currency=HKD}"}, which {@code BigDecimal} rejects at the first
     * non-digit ("Character array is missing \"e\" notation exponential mark") and turned every add-to-cart
     * into a 500. A null amount is a line the catalogue cannot price, and it contributes nothing to a sum
     * rather than stopping the read.
     */
    private static BigDecimal money(Object value) {
        Object raw = value instanceof Map<?, ?> money ? money.get("amount") : value;
        if (raw == null) {
            return BigDecimal.ZERO;
        }
        if (raw instanceof BigDecimal decimal) {
            return decimal;
        }
        return new BigDecimal(String.valueOf(raw).trim());
    }

    // ---- one projection of a line: display + price verdict ---------------

    /**
     * Every line of the cart, each carrying both what it says and whether that is still true.
     *
     * <p>{@code stale} is the checkout-blocking verdict: the price the buyer was shown is no longer the
     * price the offering carries ({@code price_changed}), or the line can no longer be bought at all
     * (archived offering, unpublished merchant, out of stock, cancelled reservation). {@code price_expired}
     * is a separate, advisory verdict: the quote is older than the §5 freshness class. It does not block
     * on its own, because checkout re-derives the live price and would have blocked on any change — so a
     * charge can never be both expired and different from what the buyer saw.
     *
     * <p>// CONTRACT GAP: §20 calls the TTL comparison "stale", and §103 says a stale price must never be
     * charged silently. Read literally the two together would block every seeded price older than six
     * hours and make the cart uncheckout-able against real data. We split the two: {@code stale} blocks,
     * {@code price_expired} is surfaced per line and again in the checkout response. Reported to the lead.
     */
    public List<Map<String, Object>> lines(TenantContext tenant, UUID cartId) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : carts.items(tenant, cartId)) {
            out.add(lineView(row));
        }
        return out;
    }

    private Map<String, Object> lineView(Map<String, Object> row) {
        UUID offeringId = Json.uuid(row, "offering_id");
        UUID reservationId = Json.uuid(row, "reservation_id");
        int quantity = Json.integer(row, "quantity") == null ? 1 : Json.integer(row, "quantity");
        BigDecimal stored = Json.dec(row, "unit_price");
        String currency = Json.str(row, "currency");
        String kind = Json.str(row, "kind");

        String name;
        Map<String, Object> merchant;
        String demoOrigin;
        BigDecimal current;
        String priceSource;
        String unavailable = null;

        if (offeringId != null) {
            name = firstNonBlank(Json.str(row, "offering_name"), Json.str(row, "offering_name_zh"));
            merchant = Json.map("id", Json.str(row, "offering_merchant_id"), "slug", Json.str(row, "offering_merchant_slug"),
                    "name", Json.str(row, "offering_merchant_name"), "status", Json.str(row, "offering_merchant_status"));
            demoOrigin = Json.str(row, "offering_merchant_data_origin");
            current = Json.dec(row, "offering_price_amount");
            priceSource = Json.str(row, "offering_price_source");
            if (Json.str(row, "offering_name") == null) {
                unavailable = "offering_missing";
            } else if (!"active".equals(Json.str(row, "offering_status"))
                    || !"published".equals(Json.str(row, "offering_merchant_status"))) {
                unavailable = "offering_unavailable";
            } else if (current == null) {
                unavailable = "offering_price_unknown";
            } else {
                Integer stock = Json.integer(row, "offering_stock_quantity");
                if (stock != null && stock < quantity) {
                    unavailable = "insufficient_stock";
                }
            }
        } else if (reservationId != null) {
            String code = Json.str(row, "reservation_code");
            name = code == null ? null : "Reservation " + code;
            merchant = Json.map("id", Json.str(row, "reservation_merchant_id"),
                    "slug", Json.str(row, "reservation_merchant_slug"),
                    "name", Json.str(row, "reservation_merchant_name"),
                    "status", Json.str(row, "reservation_merchant_status"));
            demoOrigin = Json.str(row, "reservation_merchant_data_origin");
            current = Json.dec(row, "reservation_total_amount");
            priceSource = "merchant";
            String status = Json.str(row, "reservation_status");
            Instant startsAt = instantOf(row.get("reservation_starts_at"));
            if (code == null) {
                unavailable = "reservation_missing";
            } else if (status == null || !Set.of("pending", "confirmed").contains(status)) {
                unavailable = "reservation_cancelled";
            } else if (startsAt != null && startsAt.isBefore(Instant.now())) {
                unavailable = "reservation_started";
            } else if (current == null) {
                unavailable = "reservation_price_unknown";
            }
        } else {
            // The schema CHECK forbids this; reaching it means a row was written around the constraint.
            name = null;
            merchant = null;
            demoOrigin = null;
            current = null;
            priceSource = null;
            unavailable = "item_has_no_subject";
        }

        boolean priceChanged = current != null && stored != null && current.compareTo(stored) != 0;
        String staleReason = unavailable != null ? unavailable : (priceChanged ? "price_changed" : null);
        Long quoteAgeSeconds = secondsSince(row.get("priced_at"));
        boolean priceExpired = quoteAgeSeconds != null && quoteAgeSeconds > PRICE_QUOTE_TTL.getSeconds();

        Map<String, Object> line = new LinkedHashMap<>();
        line.put("item_id", Json.str(row, "id"));
        line.put("kind", kind);
        line.put("offering_id", offeringId == null ? null : offeringId.toString());
        line.put("reservation_id", reservationId == null ? null : reservationId.toString());
        line.put("name", name);
        line.put("merchant", merchant);
        line.put("quantity", quantity);
        line.put("unit_price", Json.money(stored, currency));
        line.put("current_price", Json.money(current, currency));
        line.put("line_total", Json.money(stored == null ? null : stored.multiply(BigDecimal.valueOf(quantity)), currency));
        line.put("current_line_total",
                Json.money(current == null ? null : current.multiply(BigDecimal.valueOf(quantity)), currency));
        line.put("currency", currency);
        line.put("options", Json.jsonObject(row, "options"));
        line.put("price_source", priceSource);
        line.put("priced_at", Json.ts(row, "priced_at"));
        line.put("price_updated_at", Json.ts(row, "offering_price_updated_at"));
        line.put("price_age_seconds", quoteAgeSeconds);
        line.put("price_ttl_seconds", PRICE_QUOTE_TTL.getSeconds());
        line.put("price_expired", priceExpired);
        line.put("price_changed", priceChanged);
        line.put("available", unavailable == null);
        line.put("stale", staleReason != null);
        line.put("stale_reason", staleReason);
        if (reservationId != null) {
            line.put("reservation", Json.map("code", Json.str(row, "reservation_code"),
                    "status", Json.str(row, "reservation_status"),
                    "starts_at", Json.ts(row, "reservation_starts_at"),
                    "ends_at", Json.ts(row, "reservation_ends_at"),
                    "party_size", Json.integer(row, "reservation_party_size")));
        }
        line.put("flags", Json.map("demo", com.nexus.platform.DemoFlags.isDemo(demoOrigin)));
        return line;
    }

    // ---- item writes -----------------------------------------------------

    @Transactional
    public Map<String, Object> addItem(TenantContext tenant, Subject subject, UUID offeringId, UUID reservationId,
                                       Integer quantity, Map<String, Object> options) {
        if ((offeringId == null) == (reservationId == null)) {
            throw ApiException.validation("Send exactly one of offering_id or reservation_id",
                    Json.map("fields", List.of("offering_id", "reservation_id")));
        }
        int qty = quantity == null ? 1 : quantity;
        if (qty < 1 || qty > MAX_QUANTITY) {
            throw ApiException.validation("quantity must be between 1 and " + MAX_QUANTITY,
                    Json.map("field", "quantity", "max", MAX_QUANTITY));
        }
        Map<String, Object> cart = currentOrCreate(tenant, subject);
        UUID cartId = Json.uuid(cart, "id");
        String optionsJson = options == null || options.isEmpty() ? "{}" : Json.write(options);

        UUID merchantId;
        String kind;
        String name;
        BigDecimal unitPrice;
        String currency;
        String priceSource;
        if (offeringId != null) {
            Map<String, Object> offering = carts.offering(tenant, offeringId)
                    .orElseThrow(() -> ApiException.notFound("offering_not_found", "No such offering"));
            // A draft merchant is absent from the consumer surface, so its offerings are absent too (D24).
            if (!"active".equals(Json.str(offering, "status"))
                    || !"published".equals(Json.str(offering, "merchant_status"))) {
                throw ApiException.notFound("offering_not_found", "No such offering");
            }
            unitPrice = Json.dec(offering, "price_amount");
            if (unitPrice == null) {
                throw ApiException.conflict("offering_not_purchasable",
                        "This offering has no price, so it cannot be added to a cart",
                        Json.map("offering_id", offeringId.toString(), "price_source", Json.str(offering, "price_source")));
            }
            Integer stock = Json.integer(offering, "stock_quantity");
            if (stock != null && stock < qty) {
                throw ApiException.conflict("insufficient_stock", "There is not enough stock for this quantity",
                        Json.map("offering_id", offeringId.toString(), "stock_quantity", stock, "requested", qty));
            }
            kind = OFFERING_KINDS.contains(Json.str(offering, "kind")) ? Json.str(offering, "kind") : "product";
            name = firstNonBlank(Json.str(offering, "name"), Json.str(offering, "name_zh"));
            currency = Json.str(offering, "currency");
            priceSource = Json.str(offering, "price_source");
            merchantId = Json.uuid(offering, "merchant_id");
        } else {
            if (subject.userId() == null) {
                // A reservation is a named person's commitment (§40); an anonymous session cannot hold one.
                throw ApiException.notFound("reservation_not_found", "No such reservation");
            }
            Map<String, Object> reservation = carts.reservation(tenant, reservationId, subject.userId())
                    .orElseThrow(() -> ApiException.notFound("reservation_not_found", "No such reservation"));
            String status = Json.str(reservation, "status");
            Instant startsAt = instantOf(reservation.get("starts_at"));
            if (status == null || !Set.of("pending", "confirmed").contains(status)) {
                throw ApiException.conflict("reservation_not_addable",
                        "That reservation is " + status + " and cannot be added to a cart",
                        Json.map("reservation_id", reservationId.toString(), "status", status));
            }
            if (startsAt != null && startsAt.isBefore(Instant.now())) {
                throw ApiException.conflict("reservation_not_addable", "That reservation has already started",
                        Json.map("reservation_id", reservationId.toString(), "starts_at", startsAt.toString()));
            }
            unitPrice = Json.dec(reservation, "total_amount");
            if (unitPrice == null) {
                throw ApiException.conflict("reservation_not_addable",
                        "That reservation carries no amount, so it cannot be priced into a cart",
                        Json.map("reservation_id", reservationId.toString()));
            }
            kind = "reservation";
            name = "Reservation " + Json.str(reservation, "code");
            currency = Json.str(reservation, "currency");
            priceSource = "merchant";
            merchantId = Json.uuid(reservation, "merchant_id");
        }

        assertSingleCurrency(tenant, cartId, currency);

        Optional<Map<String, Object>> existing = offeringId != null
                ? carts.offeringLine(tenant, cartId, offeringId, optionsJson)
                : carts.reservationLine(tenant, cartId, reservationId, optionsJson);
        UUID itemId;
        if (existing.isPresent()) {
            itemId = Json.uuid(existing.get(), "id");
            int merged = (Json.integer(existing.get(), "quantity") == null ? 0 : Json.integer(existing.get(), "quantity"))
                    + qty;
            if (merged > MAX_QUANTITY) {
                throw ApiException.validation("That would take this line above " + MAX_QUANTITY + " units",
                        Json.map("item_id", itemId.toString(), "max", MAX_QUANTITY));
            }
            carts.mergeQuantity(tenant, cartId, itemId, merged, unitPrice, currency, priceSource);
        } else {
            itemId = Json.uuid(carts.insertItem(tenant, cartId, offeringId, reservationId, kind, qty, unitPrice,
                    currency, optionsJson, priceSource), "id");
        }
        carts.touch(tenant, cartId);
        Map<String, Object> out = view(tenant, carts.find(tenant, cartId).orElse(cart));
        out.put("added_item_id", itemId.toString());
        out.put("merged", existing.isPresent());
        return out;
    }

    private void assertSingleCurrency(TenantContext tenant, UUID cartId, String currency) {
        for (String present : carts.currencies(tenant, cartId)) {
            if (present != null && currency != null && !present.equals(currency)) {
                throw ApiException.conflict("cart_currency_mismatch",
                        "A cart totals one currency; this line is in " + currency + " and the cart is in " + present,
                        Json.map("cart_currency", present, "line_currency", currency));
            }
        }
    }

    /**
     * Quantity and options only. The price is deliberately left alone: silently adopting a changed
     * price here would be the mirror image of charging a stale one, so a new price has to come back
     * through price-check or a fresh add, where the buyer can see it.
     */
    @Transactional
    public Map<String, Object> updateItem(TenantContext tenant, Subject subject, UUID itemId, Integer quantity,
                                          Map<String, Object> options) {
        Map<String, Object> cart = current(tenant, subject)
                .orElseThrow(() -> ApiException.notFound("cart_not_found", "There is no open cart for this caller"));
        UUID cartId = Json.uuid(cart, "id");
        Map<String, Object> item = carts.item(tenant, cartId, itemId)
                .orElseThrow(() -> ApiException.notFound("cart_item_not_found", "No such item in this cart"));
        if (quantity != null) {
            if (quantity < 1 || quantity > MAX_QUANTITY) {
                throw ApiException.validation("quantity must be between 1 and " + MAX_QUANTITY,
                        Json.map("field", "quantity", "max", MAX_QUANTITY));
            }
            Integer stock = Json.integer(item, "offering_stock_quantity");
            if (stock != null && stock < quantity) {
                throw ApiException.conflict("insufficient_stock", "There is not enough stock for this quantity",
                        Json.map("item_id", itemId.toString(), "stock_quantity", stock, "requested", quantity));
            }
        }
        carts.patchItem(tenant, cartId, itemId, quantity,
                options == null ? null : Json.write(options));
        carts.touch(tenant, cartId);
        return view(tenant, carts.find(tenant, cartId).orElse(cart));
    }

    @Transactional
    public Map<String, Object> removeItem(TenantContext tenant, Subject subject, UUID itemId) {
        Map<String, Object> cart = current(tenant, subject)
                .orElseThrow(() -> ApiException.notFound("cart_not_found", "There is no open cart for this caller"));
        UUID cartId = Json.uuid(cart, "id");
        if (carts.deleteItem(tenant, cartId, itemId) == 0) {
            throw ApiException.notFound("cart_item_not_found", "No such item in this cart");
        }
        carts.touch(tenant, cartId);
        return view(tenant, carts.find(tenant, cartId).orElse(cart));
    }

    // ---- price check -----------------------------------------------------

    /** Read-only: the per-line verdicts before checkout, never a write and never cached (§103). */
    public Map<String, Object> priceCheck(TenantContext tenant, Subject subject) {
        Optional<Map<String, Object>> cart = current(tenant, subject);
        List<Map<String, Object>> lines = cart.map(c -> lines(tenant, Json.uuid(c, "id"))).orElse(List.of());
        String currency = cart.map(c -> c.get("currency")).map(String::valueOf).orElse(null);
        BigDecimal stored = BigDecimal.ZERO;
        BigDecimal current = BigDecimal.ZERO;
        List<Map<String, Object>> stale = new ArrayList<>();
        List<Map<String, Object>> expired = new ArrayList<>();
        for (Map<String, Object> line : lines) {
            stored = stored.add(money(line.get("line_total")));
            current = current.add(money(line.get("current_line_total")));
            if (Boolean.TRUE.equals(line.get("stale"))) {
                stale.add(Json.map("item_id", line.get("item_id"), "name", line.get("name"),
                        "stale_reason", line.get("stale_reason"), "unit_price", line.get("unit_price"),
                        "current_price", line.get("current_price")));
            }
            if (Boolean.TRUE.equals(line.get("price_expired"))) {
                expired.add(Json.map("item_id", line.get("item_id"), "name", line.get("name"),
                        "price_age_seconds", line.get("price_age_seconds")));
            }
        }
        String resolvedCurrency = lines.isEmpty()
                ? (currency == null ? defaultCurrency(tenant) : currency)
                : String.valueOf(lines.get(0).get("currency"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cart_id", cart.map(c -> Json.str(c, "id")).orElse(null));
        out.put("items", lines);
        out.put("stale_items", stale);
        out.put("expired_quotes", expired);
        // Counts, because a list length the client has to re-derive is a number the client will get
        // wrong; both the SDK's own adapter and the price-check test read `stale_count` by name.
        out.put("stale_count", stale.size());
        out.put("expired_count", expired.size());
        out.put("any_stale", !stale.isEmpty());
        out.put("any_price_expired", !expired.isEmpty());
        out.put("totals", Json.map("subtotal", Json.money(stored, resolvedCurrency),
                "current_subtotal", Json.money(current, resolvedCurrency), "currency", resolvedCurrency));
        out.put("price_ttl_seconds", PRICE_QUOTE_TTL.getSeconds());
        out.put("checked_at", Instant.now().toString());
        out.put("note", "stale=true means checkout will refuse this line: the price changed, or the line "
                + "can no longer be bought. price_expired=true is the §5 freshness class on the quote "
                + "itself and is reported, not charged around — checkout re-derives every price server-side.");
        return out;
    }

    // ---- checkout --------------------------------------------------------

    /**
     * Turn the cart into an order plus a payment intent. The caller wraps this in
     * {@link IdempotencyService#run}, so the same {@code Idempotency-Key} replays the recorded
     * {@code {order, payment_intent}} instead of creating a second order.
     *
     * <p>// CONTRACT GAP: §6 returns a single {@code {order, payment_intent}} while DATABASE §3.4 calls
     * {@code carts.merchant_id} "soft grouping; multi-merchant allowed", and {@code orders.merchant_id}
     * is NOT NULL. Rather than invent a multi-order response shape or silently drop lines, a cart
     * holding more than one merchant is refused with {@code 409 cart_multi_merchant} naming them.
     */
    @Transactional
    public Map<String, Object> checkout(TenantContext tenant, Subject subject, String idempotencyKey,
                                        Map<String, Object> body) {
        Map<String, Object> cart = currentOrCreate(tenant, subject);
        UUID cartId = Json.uuid(cart, "id");
        List<Map<String, Object>> lines = lines(tenant, cartId);
        if (lines.isEmpty()) {
            throw ApiException.conflict("cart_empty", "There is nothing to check out",
                    Json.map("cart_id", cartId.toString()));
        }
        List<Map<String, Object>> stale = lines.stream()
                .filter(l -> Boolean.TRUE.equals(l.get("stale"))).toList();
        if (!stale.isEmpty()) {
            // §103: the buyer is sent back to the cart, never charged a price they did not see.
            throw ApiException.conflict("cart_price_stale",
                    "Some lines changed since they were added; re-check the cart before paying",
                    Json.map("items", stale.stream().map(l -> Json.map("item_id", l.get("item_id"),
                                    "name", l.get("name"), "stale_reason", l.get("stale_reason"),
                                    "unit_price", l.get("unit_price"), "current_price", l.get("current_price")))
                            .toList()));
        }
        Set<String> merchantIds = new LinkedHashSet<>();
        for (Map<String, Object> line : lines) {
            @SuppressWarnings("unchecked")
            Map<String, Object> merchant = (Map<String, Object>) line.get("merchant");
            if (merchant != null && merchant.get("id") != null) {
                merchantIds.add(String.valueOf(merchant.get("id")));
            }
        }
        if (merchantIds.size() != 1) {
            throw ApiException.conflict("cart_multi_merchant",
                    "This cart holds " + merchantIds.size() + " merchants; check out one merchant at a time",
                    Json.map("merchant_ids", new ArrayList<>(merchantIds),
                            "reason", "An order belongs to exactly one merchant (orders.merchant_id is NOT NULL)."));
        }

        List<OrderService.CheckoutLine> orderLines = new ArrayList<>();
        for (Map<String, Object> line : lines) {
            BigDecimal current = line.get("current_price") == null ? null : money(line.get("current_price"));
            String optionsJson = Json.write(Json.map("cart_item_id", line.get("item_id"),
                    "options", line.get("options"), "reservation_id", line.get("reservation_id")));
            orderLines.add(new OrderService.CheckoutLine(
                    line.get("offering_id") == null ? null : UUID.fromString(String.valueOf(line.get("offering_id"))),
                    line.get("reservation_id") == null ? null : UUID.fromString(String.valueOf(line.get("reservation_id"))),
                    String.valueOf(line.get("kind")),
                    line.get("name") == null ? "Line item" : String.valueOf(line.get("name")),
                    ((Number) line.get("quantity")).intValue(),
                    current, String.valueOf(line.get("currency")), optionsJson,
                    line.get("price_source") == null ? "merchant" : String.valueOf(line.get("price_source"))));
        }

        boolean hasReservation = lines.stream().anyMatch(l -> "reservation".equals(l.get("kind")));
        String fulfillment = requestedFulfillment(body, hasReservation);
        String contactJson = Json.write(allowlistedContact(body));
        Map<String, Object> metadata = Json.map("source", "consumer", "cart_id", cartId.toString(),
                "line_count", lines.size());

        Map<String, Object> order = orders.create(tenant, subject.userId(), subject.sessionId(),
                UUID.fromString(merchantIds.iterator().next()), fulfillment, contactJson, orderLines, metadata);
        UUID orderId = Json.uuid(order, "id");
        BigDecimal total = Json.dec(order, "total");
        String currency = Json.str(order, "currency");
        // §42: the payment row is keyed by the same Idempotency-Key the caller sent, so a retried
        // checkout cannot leave two pending payments for one order.
        Map<String, Object> payment = payments.insert(tenant, orderId, "demo", null,
                IdempotencyService.headerOnly("checkout", idempotencyKey), total, currency, "pending");
        carts.convert(tenant, cartId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("order", orders.get(tenant, subject.userId(), subject.sessionId(), orderId));
        out.put("payment_intent", PaymentService.paymentIntent(payment));
        out.put("cart", view(tenant, carts.find(tenant, cartId).orElse(cart)));
        List<Map<String, Object>> expired = lines.stream()
                .filter(l -> Boolean.TRUE.equals(l.get("price_expired")))
                .map(l -> Json.map("item_id", l.get("item_id"), "name", l.get("name"),
                        "price_age_seconds", l.get("price_age_seconds")))
                .toList();
        out.put("price_warnings", expired);
        return out;
    }

    private String requestedFulfillment(Map<String, Object> body, boolean hasReservation) {
        Object requested = body == null ? null : body.get("fulfillment");
        if (requested == null) {
            return hasReservation ? "reservation" : "pickup";
        }
        String value = String.valueOf(requested);
        if (!FULFILLMENTS.contains(value)) {
            throw ApiException.validation("fulfillment must be one of " + FULFILLMENTS,
                    Json.map("field", "fulfillment", "allowed", FULFILLMENTS));
        }
        return value;
    }

    /** Same allowlist rule as a reservation (§42): only these three keys can reach {@code orders.contact}. */
    private Map<String, Object> allowlistedContact(Map<String, Object> body) {
        Map<String, Object> out = new LinkedHashMap<>();
        Object raw = body == null ? null : body.get("contact");
        if (!(raw instanceof Map<?, ?> contact)) {
            return out;
        }
        for (String field : CONTACT_FIELDS) {
            Object value = contact.get(field);
            if (value instanceof String text && !text.isBlank()) {
                out.put(field, "email".equals(field) ? text.trim().toLowerCase() : text.trim());
            }
        }
        return out;
    }

    // ---- small helpers ---------------------------------------------------

    private static String firstNonBlank(String a, String b) {
        return a != null && !a.isBlank() ? a : b;
    }

    private static Long secondsSince(Object value) {
        Instant instant = instantOf(value);
        return instant == null ? null : Math.max(0, Duration.between(instant, Instant.now()).getSeconds());
    }

    private static Instant instantOf(Object value) {
        if (value instanceof java.sql.Timestamp t) {
            return t.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime o) {
            return o.toInstant();
        }
        if (value instanceof Instant i) {
            return i;
        }
        return null;
    }
}
