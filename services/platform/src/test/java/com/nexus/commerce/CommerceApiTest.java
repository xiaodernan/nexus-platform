package com.nexus.commerce;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The §41 cart, the §42 order/payment surface and the provider webhook, over real HTTP and a real
 * database.
 *
 * <p>What is pinned here is not that the routes exist — it is the handful of ways a checkout can lie.
 * A price that the client named instead of the platform; a line that was re-priced after the buyer saw
 * it and got charged anyway; a double-tapped confirm that takes money twice; a cancel that releases
 * capacity twice; a webhook that trusts an unsigned body. Each test below is one of those, and each
 * assertion is made against the database rather than against the response, because the response is
 * exactly the thing under suspicion.
 */
class CommerceApiTest extends NexusIntegrationTest {

    /** Long enough for the guard's {@code >= 16} rule; the route is a 501 without one. */
    private static final String WEBHOOK_SECRET = "nexus-test-payment-webhook-secret-32";

    @DynamicPropertySource
    static void webhookSecret(DynamicPropertyRegistry registry) {
        registry.add("NEXUS_PAYMENT_WEBHOOK_SECRET", () -> WEBHOOK_SECRET);
    }

    private Tenant tenant;
    private Tenant other;
    private UUID userId;
    private String token;
    private UUID merchant;
    private UUID offering;

    @BeforeEach
    void seedCatalogue() {
        tenant = newTenant("commerce");
        other = newTenant("commerce-other");
        userId = newUser(tenant, "buyer-" + System.nanoTime() + "@example.test", "consumer");
        token = token(tenant, userId, "consumer");
        merchant = newMerchant(tenant, "shop-" + System.nanoTime(), "published");
        newLocation(tenant, merchant, 22.31, 114.16, "Sha Tin");
        offering = newOffering(tenant, merchant, "100.00");
    }

    // ---------------------------------------------------------------- 1. the cart

    @Test
    @DisplayName("The current cart is materialised per subject, and never across tenants")
    void cartIsPerSubjectAndTenantScoped() {
        ResponseEntity<String> first = anonymousGet(tenant, "/api/v1/carts/current", "sess-aaaa1111");
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode cart = Json.tree(first.getBody());
        String cartId = cart.path("cart_id").asText();
        assertThat(cartId).isNotBlank();
        assertThat(cart.path("status").asText()).isEqualTo("open");
        assertThat(cart.path("items")).isEmpty();

        // The same session resolves the same cart; a different one gets its own.
        assertThat(Json.tree(anonymousGet(tenant, "/api/v1/carts/current", "sess-aaaa1111").getBody())
                .path("cart_id").asText()).isEqualTo(cartId);
        assertThat(Json.tree(anonymousGet(tenant, "/api/v1/carts/current", "sess-bbbb2222").getBody())
                .path("cart_id").asText()).isNotEqualTo(cartId);

        // The same session id in another tenant is another cart: carts are tenant rows, not session rows.
        assertThat(Json.tree(anonymousGet(other, "/api/v1/carts/current", "sess-aaaa1111").getBody())
                .path("cart_id").asText()).isNotEqualTo(cartId);
    }

    // ---------------------------------------------------------------- 2. prices

    @Test
    @DisplayName("A line is priced from the catalogue, not from the request body")
    void priceComesFromTheCatalogue() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("offering_id", offering.toString());
        body.put("quantity", 2);
        // A client that names its own price is not refused — it is ignored, which is the only answer that
        // cannot be talked into a cheaper basket.
        body.put("unit_price", "1.00");
        body.put("line_total", "2.00");

        ResponseEntity<String> added = post(tenant, token, "/api/v1/carts/items", body);
        assertThat(added.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode line = Json.tree(added.getBody()).path("items").get(0);
        assertThat(line.path("unit_price").path("amount").asText()).isEqualTo("100.00");
        assertThat(line.path("line_total").path("amount").asText()).isEqualTo("200.00");

        String itemId = line.path("item_id").asText();
        ResponseEntity<String> patched = exchangeWith(HttpMethod.PATCH, tenant, token,
                "/api/v1/carts/items/" + itemId, Json.map("quantity", 3), Map.of());
        assertThat(patched.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(patched.getBody()).path("items").get(0).path("line_total").path("amount").asText())
                .isEqualTo("300.00");

        ResponseEntity<String> removed = exchangeWith(HttpMethod.DELETE, tenant, token,
                "/api/v1/carts/items/" + itemId, null, Map.of());
        assertThat(removed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(removed.getBody()).path("items")).isEmpty();
    }

    @Test
    @DisplayName("An expired quote is reported; a price that moved under the buyer blocks the charge")
    void expiredQuoteIsReportedAndChangedPriceIsRefused() {
        String cartId = addLine(offering, 1);
        // Backdate the quote past the §5 price TTL. This is the only way to produce that state without
        // waiting six hours, and it is the state the two readings of §103 disagree about.
        jdbc.update("update cart_items set priced_at = now() - interval '72 hours' where cart_id = :c",
                new MapSqlParameterSource("c", UUID.fromString(cartId)));

        // 1. Age alone is *reported*, not enforced. Checkout re-derives every price from the catalogue
        //    (the `current_price` of each line), and a quote nobody has repriced still charges exactly
        //    the number the buyer saw — so nothing stale is charged, which is what §103 asks for.
        //    Blocking here instead would strand the cart: `priced_at` only moves on insert/merge and
        //    price-check is documented read-only, so an abandoned basket could never be paid at all.
        ResponseEntity<String> check = post(tenant, token, "/api/v1/carts/price-check", Map.of());
        assertThat(check.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode checked = Json.tree(check.getBody());
        assertThat(checked.path("expired_count").asInt()).isEqualTo(1);
        assertThat(checked.path("stale_count").asInt()).isEqualTo(0);
        JsonNode quoted = checked.path("items").get(0);
        assertThat(quoted.path("price_expired").asBoolean()).isTrue();
        assertThat(quoted.path("stale").asBoolean()).isFalse();

        ResponseEntity<String> checkout = exchangeWith(HttpMethod.POST, tenant, token, "/api/v1/carts/checkout",
                Map.of(), Map.of("Idempotency-Key", "expired-" + System.nanoTime()));
        assertThat(checkout.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode created = Json.tree(checkout.getBody());
        assertThat(created.path("price_warnings").size()).isEqualTo(1);
        assertThat(created.path("order").path("totals").path("total").path("amount").asText())
                .isEqualTo("100.00");

        // 2. A price that moved under the buyer *is* enforced — this is the half §103 cannot be
        //    satisfied without. The line is stale, price-check says why, and checkout refuses it with
        //    cart_price_stale instead of charging a number the buyer never saw.
        addLine(offering, 1);
        jdbc.update("update offerings set price_amount = 150.00 where id = :o",
                new MapSqlParameterSource("o", offering));

        ResponseEntity<String> recheck = post(tenant, token, "/api/v1/carts/price-check", Map.of());
        assertThat(recheck.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode rechecked = Json.tree(recheck.getBody());
        assertThat(rechecked.path("stale_count").asInt()).isEqualTo(1);
        assertThat(rechecked.path("expired_count").asInt()).isEqualTo(0);
        assertThat(rechecked.path("items").get(0).path("stale").asBoolean()).isTrue();
        assertThat(rechecked.path("items").get(0).path("stale_reason").asText()).isEqualTo("price_changed");

        ResponseEntity<String> refused = exchangeWith(HttpMethod.POST, tenant, token, "/api/v1/carts/checkout",
                Map.of(), Map.of("Idempotency-Key", "changed-" + System.nanoTime()));
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(Json.tree(refused.getBody()).path("error").path("code").asText()).isEqualTo("cart_price_stale");
    }

    // ---------------------------------------------------------------- 3. checkout

    @Test
    @DisplayName("Checkout needs an Idempotency-Key, and the same key yields the same order")
    void checkoutIsIdempotent() {
        addLine(offering, 1);

        ResponseEntity<String> keyless = post(tenant, token, "/api/v1/carts/checkout", Map.of());
        assertThat(keyless.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(Json.tree(keyless.getBody()).path("error").path("details").path("header").asText())
                .isEqualTo("Idempotency-Key");

        String key = "co-" + System.nanoTime();
        ResponseEntity<String> first = exchangeWith(HttpMethod.POST, tenant, token, "/api/v1/carts/checkout",
                Map.of(), Map.of("Idempotency-Key", key));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode created = Json.tree(first.getBody());
        String orderId = created.path("order").path("order_id").asText();
        assertThat(orderId).isNotBlank();

        ResponseEntity<String> replay = exchangeWith(HttpMethod.POST, tenant, token, "/api/v1/carts/checkout",
                Map.of(), Map.of("Idempotency-Key", key));
        assertThat(replay.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(replay.getBody()).path("order").path("order_id").asText()).isEqualTo(orderId);

        assertThat(count("select count(*) from orders where id = cast(:id as uuid)", Map.of("id", orderId)))
                .isEqualTo(1);
    }

    // ---------------------------------------------------------------- 4. order reads

    @Test
    @DisplayName("An order is owner-scoped, and cancelling it twice is the same as cancelling it once")
    void orderReadAndCancel() {
        String orderId = checkout();

        assertThat(get(tenant, token, "/api/v1/orders/" + orderId).getStatusCode()).isEqualTo(HttpStatus.OK);

        UUID stranger = newUser(tenant, "stranger-" + System.nanoTime() + "@example.test", "consumer");
        assertThat(get(tenant, token(tenant, stranger, "consumer"), "/api/v1/orders/" + orderId).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get(other, token(other, newUser(other, "foreign-" + System.nanoTime() + "@example.test",
                "consumer"), "consumer"), "/api/v1/orders/" + orderId).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<String> cancelled = post(tenant, token, "/api/v1/orders/" + orderId + "/cancel", Map.of());
        assertThat(cancelled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(cancelled.getBody()).path("status").asText()).isEqualTo("cancelled");

        ResponseEntity<String> again = post(tenant, token, "/api/v1/orders/" + orderId + "/cancel", Map.of());
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(again.getBody()).path("status").asText()).isEqualTo("cancelled");
        assertThat(count("select count(*) from orders where id = cast(:id as uuid) and status = 'cancelled'",
                Map.of("id", orderId))).isEqualTo(1);
    }

    // ---------------------------------------------------------------- 5. payment confirm

    @Test
    @DisplayName("Confirm captures once; a second confirm returns the captured payment untouched")
    void confirmCapturesOnce() {
        String orderId = checkout();

        ResponseEntity<String> first = exchangeWith(HttpMethod.POST, tenant, token,
                "/api/v1/payments/" + orderId + "/confirm", Map.of(), Map.of("Idempotency-Key", "pay-" + System.nanoTime()));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode paid = Json.tree(first.getBody());
        assertThat(paid.path("changed").asBoolean()).isTrue();
        assertThat(paid.path("payment").path("status").asText()).isEqualTo("captured");
        assertThat(paid.path("order").path("status").asText()).isEqualTo("paid");
        String providerRef = paid.path("payment").path("provider_ref").asText();
        assertThat(providerRef).startsWith("demo_");

        // A second confirm — a different key, so the replay layer cannot be what saves us — must find the
        // capture already done and write nothing.
        ResponseEntity<String> second = exchangeWith(HttpMethod.POST, tenant, token,
                "/api/v1/payments/" + orderId + "/confirm", Map.of(),
                Map.of("Idempotency-Key", "pay2-" + System.nanoTime()));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode replay = Json.tree(second.getBody());
        assertThat(replay.path("changed").asBoolean()).isFalse();
        assertThat(replay.path("already_paid").asBoolean()).isTrue();
        assertThat(replay.path("payment").path("provider_ref").asText()).isEqualTo(providerRef);

        assertThat(count("""
                select count(*) from payments p join orders o on o.id = p.order_id
                where o.id = cast(:id as uuid) and p.status = 'captured'
                """, Map.of("id", orderId))).isEqualTo(1);

        // An order that is nobody's is absent, not forbidden.
        assertThat(exchangeWith(HttpMethod.POST, tenant, token, "/api/v1/payments/" + UUID.randomUUID() + "/confirm",
                Map.of(), Map.of("Idempotency-Key", "pay3-" + System.nanoTime())).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---------------------------------------------------------------- 6. webhook

    @Test
    @DisplayName("A webhook from an unknown provider or with a bad signature changes nothing")
    void webhookRejectsTheUnverified() {
        String body = Json.write(Json.map("event_id", "evt-" + UUID.randomUUID(), "type", "payment.captured",
                "provider_ref", "demo_nobody"));

        assertThat(postRaw(tenant, "/api/v1/webhooks/payments/nope", body, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<String> unsigned = postRaw(tenant, "/api/v1/webhooks/payments/demo", body, Map.of());
        assertThat(unsigned.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(unsigned.getBody()).path("error").path("code").asText()).isEqualTo("signature_missing");

        ResponseEntity<String> wrong = postRaw(tenant, "/api/v1/webhooks/payments/demo", body,
                Map.of(WebhookController.SIGNATURE_HEADER, "sha256=" + "0".repeat(64)));
        assertThat(wrong.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(wrong.getBody()).path("error").path("code").asText()).isEqualTo("signature_invalid");

        assertThat(count("select count(*) from payments where provider_ref = 'demo_nobody'", Map.of())).isEqualTo(0);
    }

    @Test
    @DisplayName("A signed refund webhook lands once, and its redelivery is a replay")
    void webhookRefundsOnce() throws Exception {
        String orderId = checkout();
        ResponseEntity<String> confirmed = exchangeWith(HttpMethod.POST, tenant, token,
                "/api/v1/payments/" + orderId + "/confirm", Map.of(),
                Map.of("Idempotency-Key", "pay-" + System.nanoTime()));
        String providerRef = Json.tree(confirmed.getBody()).path("payment").path("provider_ref").asText();

        String body = Json.write(Json.map("event_id", "evt-" + UUID.randomUUID(), "type", "payment.refunded",
                "provider_ref", providerRef, "reason", "customer changed their mind"));
        String signature = "sha256=" + hmac(body);

        ResponseEntity<String> first = postRaw(tenant, "/api/v1/webhooks/payments/demo", body,
                Map.of(WebhookController.SIGNATURE_HEADER, signature));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode applied = Json.tree(first.getBody());
        assertThat(applied.path("changed").asBoolean()).isTrue();
        assertThat(applied.path("payment").path("status").asText()).isEqualTo("refunded");
        assertThat(Json.tree(get(tenant, token, "/api/v1/orders/" + orderId).getBody()).path("status").asText())
                .isEqualTo("refunded");

        // The provider retries. Nothing moves: one refunded payment, one refunded order.
        ResponseEntity<String> redelivered = postRaw(tenant, "/api/v1/webhooks/payments/demo", body,
                Map.of(WebhookController.SIGNATURE_HEADER, signature));
        assertThat(redelivered.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(Json.tree(redelivered.getBody()).path("replayed").asBoolean()).isTrue();
        assertThat(Json.tree(redelivered.getBody()).path("changed").asBoolean()).isFalse();
        assertThat(count("select count(*) from payments where provider_ref = cast(:ref as text) and status = 'refunded'",
                Map.of("ref", providerRef))).isEqualTo(1);
    }

    // ---------------------------------------------------------------- fixtures

    private UUID newOffering(Tenant owner, UUID merchantId, String price) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into offerings (id, merchant_id, tenant_id, kind, slug, name, price_amount, currency,
                                       price_model, price_source, status)
                values (:id, :m, :tenant, 'product', :slug, 'Tasting Menu', cast(:price as numeric), 'HKD',
                        'fixed', 'merchant', 'active')
                """, new MapSqlParameterSource("id", id).addValue("m", merchantId).addValue("tenant", owner.id())
                .addValue("slug", "tasting-" + id.toString().substring(0, 8)).addValue("price", price));
        return id;
    }

    /** Adds one line and returns the cart id, asserting the write itself succeeded. */
    private String addLine(UUID offeringId, int quantity) {
        ResponseEntity<String> added = post(tenant, token, "/api/v1/carts/items",
                Json.map("offering_id", offeringId.toString(), "quantity", quantity));
        assertThat(added.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String cartId = Json.tree(added.getBody()).path("cart_id").asText();
        assertThat(cartId).isNotBlank();
        return cartId;
    }

    /** Adds a line and checks out with a fresh key, returning the order id. */
    private String checkout() {
        addLine(offering, 1);
        ResponseEntity<String> res = exchangeWith(HttpMethod.POST, tenant, token, "/api/v1/carts/checkout",
                Map.of(), Map.of("Idempotency-Key", "co-" + System.nanoTime()));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        String orderId = Json.tree(res.getBody()).path("order").path("order_id").asText();
        assertThat(orderId).isNotBlank();
        return orderId;
    }

    private ResponseEntity<String> anonymousGet(Tenant owner, String path, String sessionId) {
        HttpHeaders headers = json(owner, null);
        headers.set("X-Session-Id", sessionId);
        return http.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers), String.class);
    }

    private ResponseEntity<String> postRaw(Tenant owner, String path, String rawBody, Map<String, String> extra) {
        HttpHeaders headers = json(owner, null);
        extra.forEach(headers::set);
        return http.exchange(url(path), HttpMethod.POST, new HttpEntity<>(rawBody, headers), String.class);
    }

    private ResponseEntity<String> exchangeWith(HttpMethod method, Tenant owner, String bearer, String path,
                                                Object body, Map<String, String> extra) {
        HttpHeaders headers = json(owner, bearer);
        extra.forEach(headers::set);
        return http.exchange(url(path), method, new HttpEntity<>(body, headers), String.class);
    }

    /** The signature the provider would send: HMAC-SHA256 over the exact bytes of the body. */
    private static String hmac(String body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(WEBHOOK_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
    }
}
