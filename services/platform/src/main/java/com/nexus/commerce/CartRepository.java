package com.nexus.commerce;

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
 * The universal cart (§41) — one cart holding products, services and reservations, owned by a user
 * <em>or</em> an anonymous {@code session_id}.
 *
 * <p>{@code cart_items} has no tenant column, so every statement reaches it through the cart that owns
 * it. That is not a style choice: {@link TenantJdbc} refuses SQL that does not carry a
 * {@code tenant_id = :tenant_id} predicate, and the join is what makes another tenant's cart item read
 * as absent (404) instead of forbidden.
 *
 * <p>Each item row is read together with the <em>live</em> offering/reservation it points at
 * ({@code ITEM_COLUMNS}), so the price assessment in {@link CartService} never needs a second query and
 * can never disagree with itself (the D24 one-projection rule, applied to commerce).
 */
@Repository
public class CartRepository {

    /**
     * An item plus everything needed to re-derive its price server-side: the offering's current price,
     * when the merchant last set it, whether it is still purchasable, and — for reservation items —
     * the reservation's own status and window.
     */
    private static final String ITEM_COLUMNS = """
            ci.id, ci.cart_id, ci.offering_id, ci.reservation_id, ci.kind, ci.quantity, ci.unit_price,
            ci.currency, ci.options, ci.price_source, ci.priced_at, ci.created_at,
            c.status as cart_status, c.user_id as cart_user_id, c.session_id as cart_session_id,
            c.tenant_id,
            o.name as offering_name, o.name_zh as offering_name_zh, o.slug as offering_slug,
            o.kind as offering_kind, o.status as offering_status, o.price_amount as offering_price_amount,
            o.currency as offering_currency, o.price_source as offering_price_source,
            o.price_updated_at as offering_price_updated_at, o.stock_quantity as offering_stock_quantity,
            om.id as offering_merchant_id, om.slug as offering_merchant_slug,
            om.display_name as offering_merchant_name, om.status as offering_merchant_status,
            om.data_origin as offering_merchant_data_origin,
            r.code as reservation_code, r.status as reservation_status, r.starts_at as reservation_starts_at,
            r.ends_at as reservation_ends_at, r.party_size as reservation_party_size,
            r.total_amount as reservation_total_amount, r.currency as reservation_currency,
            rm.id as reservation_merchant_id, rm.slug as reservation_merchant_slug,
            rm.display_name as reservation_merchant_name, rm.status as reservation_merchant_status,
            rm.data_origin as reservation_merchant_data_origin
            """;

    private static final String ITEM_FROM = """
            from cart_items ci
            join carts c on c.id = ci.cart_id
            left join offerings o on o.id = ci.offering_id
            left join merchants om on om.id = o.merchant_id
            left join reservations r on r.id = ci.reservation_id
            left join merchants rm on rm.id = r.merchant_id
            """;

    private final TenantJdbc jdbc;

    public CartRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- the cart itself -------------------------------------------------

    /** The caller's open cart. An expired cart is not "open" — it is abandoned stock nobody reaped. */
    public Optional<Map<String, Object>> openForUser(TenantContext tenant, UUID userId) {
        return jdbc.firstForTenant(tenant, """
                select c.id, c.user_id, c.session_id, c.status, c.expires_at, c.created_at, c.updated_at,
                       c.tenant_id
                from carts c
                where c.user_id = :user_id and c.status = 'open' and c.tenant_id = :tenant_id
                  and (c.expires_at is null or c.expires_at > now())
                order by c.created_at desc limit 1
                """, Json.map("user_id", userId));
    }

    public Optional<Map<String, Object>> openForSession(TenantContext tenant, String sessionId) {
        return jdbc.firstForTenant(tenant, """
                select c.id, c.user_id, c.session_id, c.status, c.expires_at, c.created_at, c.updated_at,
                       c.tenant_id
                from carts c
                where c.session_id = :session_id and c.user_id is null and c.status = 'open'
                  and c.tenant_id = :tenant_id
                  and (c.expires_at is null or c.expires_at > now())
                order by c.created_at desc limit 1
                """, Json.map("session_id", sessionId));
    }

    public Map<String, Object> insert(TenantContext tenant, UUID userId, String sessionId) {
        return jdbc.insertForTenant(tenant, """
                insert into carts (tenant_id, user_id, session_id, status, expires_at)
                values (:tenant_id, cast(:user_id as uuid), cast(:session_id as text), 'open',
                        now() + interval '30 days')
                returning id, user_id, session_id, status, expires_at, created_at, updated_at, tenant_id
                """, Json.map("user_id", userId, "session_id", sessionId));
    }

    public Optional<Map<String, Object>> find(TenantContext tenant, UUID cartId) {
        return jdbc.firstForTenant(tenant, """
                select c.id, c.user_id, c.session_id, c.status, c.expires_at, c.created_at, c.updated_at,
                       c.tenant_id
                from carts c
                where c.id = :cart_id and c.tenant_id = :tenant_id
                """, Json.map("cart_id", cartId));
    }

    public int touch(TenantContext tenant, UUID cartId) {
        return jdbc.updateForTenant(tenant, """
                update carts set updated_at = now()
                where id = :cart_id and tenant_id = :tenant_id
                """, Json.map("cart_id", cartId));
    }

    /** {@code open -> converted}. Guarded on the old status so a second checkout cannot re-convert it. */
    public int convert(TenantContext tenant, UUID cartId) {
        return jdbc.updateForTenant(tenant, """
                update carts set status = 'converted', updated_at = now()
                where id = :cart_id and status = 'open' and tenant_id = :tenant_id
                """, Json.map("cart_id", cartId));
    }

    // ---- items -----------------------------------------------------------

    public List<Map<String, Object>> items(TenantContext tenant, UUID cartId) {
        return jdbc.forTenant(tenant, "select " + ITEM_COLUMNS + ITEM_FROM
                + " where ci.cart_id = :cart_id and c.tenant_id = :tenant_id"
                + " order by ci.created_at, ci.id", Json.map("cart_id", cartId));
    }

    /**
     * The currencies already present in the cart. A cart totals one currency: adding a HK$ line to a
     * cart of US$ lines would force us either to convert at a rate nobody quoted or to print a
     * meaningless sum, so the second currency is refused instead (§19).
     */
    public List<String> currencies(TenantContext tenant, UUID cartId) {
        return jdbc.forTenant(tenant, """
                select distinct ci.currency
                from cart_items ci join carts c on c.id = ci.cart_id
                where ci.cart_id = :cart_id and c.tenant_id = :tenant_id
                """, Json.map("cart_id", cartId)).stream().map(r -> Json.str(r, "currency")).toList();
    }

    /** One line inside the caller's own cart — the only handle PATCH/DELETE accept. */
    public Optional<Map<String, Object>> item(TenantContext tenant, UUID cartId, UUID itemId) {
        return jdbc.firstForTenant(tenant, "select " + ITEM_COLUMNS + ITEM_FROM
                + " where ci.id = :item_id and ci.cart_id = :cart_id and c.tenant_id = :tenant_id",
                Json.map("item_id", itemId, "cart_id", cartId));
    }

    /** An identical line (same offering, same options) so a second add becomes a quantity, not a row. */
    public Optional<Map<String, Object>> offeringLine(TenantContext tenant, UUID cartId, UUID offeringId,
                                                      String optionsJson) {
        return jdbc.firstForTenant(tenant, "select " + ITEM_COLUMNS + ITEM_FROM
                + " where ci.cart_id = :cart_id and ci.offering_id = :offering_id"
                + " and ci.options = cast(:options as jsonb) and c.tenant_id = :tenant_id limit 1",
                Json.map("cart_id", cartId, "offering_id", offeringId, "options", optionsJson));
    }

    public Optional<Map<String, Object>> reservationLine(TenantContext tenant, UUID cartId, UUID reservationId,
                                                         String optionsJson) {
        return jdbc.firstForTenant(tenant, "select " + ITEM_COLUMNS + ITEM_FROM
                + " where ci.cart_id = :cart_id and ci.reservation_id = :reservation_id"
                + " and ci.options = cast(:options as jsonb) and c.tenant_id = :tenant_id limit 1",
                Json.map("cart_id", cartId, "reservation_id", reservationId, "options", optionsJson));
    }

    public Map<String, Object> insertItem(TenantContext tenant, UUID cartId, UUID offeringId, UUID reservationId,
                                          String kind, int quantity, BigDecimal unitPrice, String currency,
                                          String optionsJson, String priceSource) {
        // cart_items carries no tenant_id, so the row is inserted only when the owning cart is the
        // caller's — the guard lives in the statement, not in a comment (TenantJdbc's escape hatch).
        return jdbc.insertForTenant(tenant, """
                insert into cart_items (cart_id, offering_id, reservation_id, kind, quantity, unit_price,
                                        currency, options, price_source, priced_at)
                select :cart_id, cast(:offering_id as uuid), cast(:reservation_id as uuid), :kind, :quantity,
                       cast(:unit_price as numeric), :currency, cast(:options as jsonb), :price_source, now()
                 where exists (select 1 from carts c where c.id = :cart_id and c.tenant_id = :tenant_id)
                returning id, cart_id, offering_id, reservation_id, kind, quantity, unit_price, currency,
                          options, price_source, priced_at, created_at
                """, Json.map("cart_id", cartId, "offering_id", offeringId, "reservation_id", reservationId,
                "kind", kind, "quantity", quantity, "unit_price", unitPrice, "currency", currency,
                "options", optionsJson, "price_source", priceSource));
    }

    /**
     * Merge re-prices: the line keeps one price, the one derived from the offering at merge time. An
     * add is the moment the server may speak, so it speaks with a fresh price and a fresh
     * {@code priced_at} — the quote the buyer will be held to.
     */
    public int mergeQuantity(TenantContext tenant, UUID cartId, UUID itemId, int quantity, BigDecimal unitPrice,
                             String currency, String priceSource) {
        return jdbc.updateForTenant(tenant, """
                update cart_items ci
                   set quantity = :quantity, unit_price = cast(:unit_price as numeric),
                       currency = :currency, price_source = :price_source, priced_at = now()
                  from carts c
                 where ci.id = :item_id and ci.cart_id = c.id and c.id = :cart_id and c.tenant_id = :tenant_id
                """, Json.map("item_id", itemId, "cart_id", cartId, "quantity", quantity,
                "unit_price", unitPrice, "currency", currency, "price_source", priceSource));
    }

    /**
     * PATCH deliberately does <em>not</em> re-price. Adopting a changed price silently would be the
     * mirror image of charging a stale one: the buyer agreed to the number on their screen, so a new
     * number has to come back through price-check / checkout, where it is visible.
     */
    public int patchItem(TenantContext tenant, UUID cartId, UUID itemId, Integer quantity, String optionsJson) {
        return jdbc.updateForTenant(tenant, """
                update cart_items ci
                   set quantity = coalesce(cast(:quantity as integer), ci.quantity),
                       options  = coalesce(cast(:options as jsonb), ci.options)
                  from carts c
                 where ci.id = :item_id and ci.cart_id = c.id and c.id = :cart_id and c.tenant_id = :tenant_id
                """, Json.map("item_id", itemId, "cart_id", cartId, "quantity", quantity, "options", optionsJson));
    }

    public int deleteItem(TenantContext tenant, UUID cartId, UUID itemId) {
        return jdbc.updateForTenant(tenant, """
                delete from cart_items ci using carts c
                 where ci.id = :item_id and ci.cart_id = c.id and c.id = :cart_id and c.tenant_id = :tenant_id
                """, Json.map("item_id", itemId, "cart_id", cartId));
    }

    // ---- what an item may point at ---------------------------------------

    /** The offering as the cart must see it: live price, live status, and the merchant that owns it. */
    public Optional<Map<String, Object>> offering(TenantContext tenant, UUID offeringId) {
        return jdbc.firstForTenant(tenant, """
                select o.id, o.merchant_id, o.kind, o.slug, o.name, o.name_zh, o.status, o.price_amount,
                       o.currency, o.price_model, o.price_source, o.price_updated_at, o.stock_quantity,
                       o.bookable, m.slug as merchant_slug, m.display_name as merchant_name,
                       m.status as merchant_status, m.data_origin as merchant_data_origin, o.tenant_id
                from offerings o join merchants m on m.id = o.merchant_id
                where o.id = :offering_id and o.tenant_id = :tenant_id
                """, Json.map("offering_id", offeringId));
    }

    /**
     * A reservation may only enter the cart of the user who holds it: a reservation is a named person's
     * commitment, not an anonymous token (§40). A caller who is not its owner gets nothing back, and
     * nothing back is a 404.
     */
    public Optional<Map<String, Object>> reservation(TenantContext tenant, UUID reservationId, UUID userId) {
        return jdbc.firstForTenant(tenant, """
                select r.id, r.code, r.status, r.starts_at, r.ends_at, r.party_size, r.total_amount,
                       r.currency, r.merchant_id, r.user_id, r.offering_id,
                       m.slug as merchant_slug, m.display_name as merchant_name, m.status as merchant_status,
                       m.data_origin as merchant_data_origin, r.tenant_id
                from reservations r join merchants m on m.id = r.merchant_id
                where r.id = :reservation_id and r.user_id = :user_id and r.tenant_id = :tenant_id
                """, Json.map("reservation_id", reservationId, "user_id", userId));
    }
}
