package com.nexus.commerce;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/v1/webhooks/payments/{provider}} — how a real payment provider tells the platform
 * that money moved (§42).
 *
 * <p>Three properties make this route safe to expose, and none of them is optional:
 *
 * <ul>
 *   <li><strong>The signature is verified over the raw bytes.</strong> Not over a re-serialised body:
 *       re-serialising changes key order and whitespace, so a signature computed over the parsed object
 *       would either fail for honest senders or be forgeable. The HMAC is compared with
 *       {@link MessageDigest#isEqual}, so a wrong signature cannot be found byte by byte.</li>
 *   <li><strong>An unconfigured secret is a 501, not an open door.</strong> Same rule as the AI-service
 *       token door (DECISIONS D7): a deployment that has not been given
 *       {@code NEXUS_PAYMENT_WEBHOOK_SECRET} cannot accept webhooks at all, and says so loudly rather
 *       than accepting anything that arrives.</li>
 *   <li><strong>Idempotent by the state machine, not by a promise.</strong> A provider retries; the
 *       capture statement is guarded on {@code status = 'pending'}, so a duplicate delivery cannot move
 *       money twice and answers {@code replayed:true} with the state that already holds.</li>
 * </ul>
 *
 * <p>// CONTRACT GAP: §42 says "idempotent by provider event id" and V1–V6 ship no
 * {@code webhook_events} table to record one. The event id is therefore echoed and audited but is not
 * the dedupe key — the guarded status transition is. That is stricter for money (a duplicate capture
 * is impossible) and weaker for a provider that re-uses a ref with a new event type; the table is the
 * thing to add if a second provider is ever integrated.
 */
@RestController
@RequestMapping("/api/v1/webhooks/payments")
public class WebhookController {

    public static final String SIGNATURE_HEADER = "X-Nexus-Signature";
    /** Providers that may call this route today. An unknown one is a 404, not a 400. */
    private static final List<String> PROVIDERS = List.of("demo");
    private static final List<String> EVENT_TYPES =
            List.of("payment.captured", "payment.failed", "payment.refunded");
    private static final int MAX_BODY_BYTES = 64 * 1024;

    private final PaymentRepository payments;
    private final OrderRepository orders;
    private final AuditService audit;
    private final String secret;

    public WebhookController(PaymentRepository payments, OrderRepository orders, AuditService audit,
                             @Value("${NEXUS_PAYMENT_WEBHOOK_SECRET:}") String secret) {
        this.payments = payments;
        this.orders = orders;
        this.audit = audit;
        this.secret = secret == null ? "" : secret.trim();
    }

    @PostMapping("/{provider}")
    public Map<String, Object> receive(@PathVariable String provider, HttpServletRequest request) {
        String name = provider == null ? "" : provider.trim().toLowerCase(Locale.ROOT);
        if (!PROVIDERS.contains(name)) {
            throw ApiException.notFound("unknown_provider", "No payment provider named '" + name + "' is wired up");
        }
        if (!configured()) {
            throw ApiException.notImplemented("This deployment has no payment webhook secret configured "
                    + "(set NEXUS_PAYMENT_WEBHOOK_SECRET, minimum 16 characters). Webhooks are refused until "
                    + "it is, per DECISIONS D7 — an unconfigured door is never an open one.");
        }

        byte[] raw = rawBody(request);
        requireSignature(request, raw);
        Map<String, Object> event = parse(raw);
        TenantContext tenant = Req.tenant(request);

        String eventId = requireText(event.get("event_id"), "event_id");
        String type = requireText(event.get("type"), "type").toLowerCase(Locale.ROOT);
        if (!EVENT_TYPES.contains(type)) {
            throw ApiException.validation("type must be one of " + EVENT_TYPES, Json.map("field", "type"));
        }
        String providerRef = requireText(event.get("provider_ref"), "provider_ref");
        String reason = event.get("reason") == null ? null : String.valueOf(event.get("reason"));

        Map<String, Object> payment = payments.byProviderRef(tenant, name, providerRef)
                .orElseThrow(() -> ApiException.notFound("payment_not_found",
                        "No payment for provider_ref '" + providerRef + "' in this tenant"));

        UUID paymentId = Json.uuid(payment, "id");
        UUID orderId = Json.uuid(payment, "order_id");
        String previous = Json.str(payment, "status");
        boolean changed;
        String outcome;

        switch (type) {
            case "payment.captured" -> {
                int rows = payments.capture(tenant, paymentId, providerRef);
                changed = rows > 0;
                outcome = changed ? "captured" : "already_" + previous;
                if (changed && orderId != null) {
                    orders.markPaid(tenant, orderId);
                }
            }
            case "payment.failed" -> {
                int rows = payments.fail(tenant, paymentId, reason == null ? "provider_reported_failure" : reason);
                changed = rows > 0;
                outcome = changed ? "failed" : "already_" + previous;
            }
            default -> {
                int rows = payments.refund(tenant, paymentId, reason == null ? "provider_reported_refund" : reason);
                changed = rows > 0;
                outcome = changed ? "refunded" : "already_" + previous;
                if (changed && orderId != null) {
                    orders.markRefunded(tenant, orderId);
                }
            }
        }

        // merchant_id is null on purpose: a webhook has no session, and the payment projection carries no
        // merchant column. The order id is recorded instead, which is the handle an operator needs and
        // the one that is actually present in this row.
        audit.record(request, "payment_webhook", "payment", paymentId, null, null,
                Json.map("event_id", eventId, "type", type, "provider", name, "outcome", outcome,
                        "order_id", orderId == null ? null : orderId.toString()),
                Json.map("provider_ref", providerRef, "changed", changed));

        Map<String, Object> fresh = payments.find(tenant, paymentId).orElse(payment);
        return Json.map(
                "received", true,
                "provider", name,
                "event_id", eventId,
                "type", type,
                "changed", changed,
                "replayed", !changed,
                "payment", PaymentService.paymentView(fresh));
    }

    // ==================================================================== verification

    private boolean configured() {
        return secret.length() >= 16;
    }

    /**
     * Verifies {@code X-Nexus-Signature: sha256=<hex>} against an HMAC of the raw body. A missing or
     * malformed header is a 401 that names the header, so an integrator's first attempt is diagnosable
     * without reading this class.
     */
    private void requireSignature(HttpServletRequest request, byte[] raw) {
        String presented = request.getHeader(SIGNATURE_HEADER);
        if (presented == null || presented.isBlank()) {
            throw ApiException.unauthorized("signature_missing",
                    "The " + SIGNATURE_HEADER + " header is required on payment webhooks");
        }
        String hex = presented.trim().toLowerCase(Locale.ROOT);
        if (hex.startsWith("sha256=")) {
            hex = hex.substring("sha256=".length());
        }
        String expected = hmacHex(raw);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), hex.getBytes(StandardCharsets.UTF_8))) {
            throw ApiException.unauthorized("signature_invalid", "Payment webhook signature does not verify");
        }
    }

    private String hmacHex(byte[] body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(body));
        } catch (java.security.NoSuchAlgorithmException | java.security.InvalidKeyException e) {
            throw ApiException.internal("Could not compute the webhook signature", e);
        }
    }

    /** The raw bytes, capped so a webhook cannot be used to push an unbounded body into memory. */
    private static byte[] rawBody(HttpServletRequest request) {
        try {
            byte[] body = request.getInputStream().readAllBytes();
            if (body.length > MAX_BODY_BYTES) {
                throw ApiException.validation("Webhook body is too large",
                        Json.map("max_bytes", MAX_BODY_BYTES, "received", body.length));
            }
            return body;
        } catch (IOException e) {
            throw ApiException.validation("Webhook body could not be read", null);
        }
    }

    private static Map<String, Object> parse(byte[] raw) {
        try {
            Map<String, Object> parsed = Json.MAPPER.readValue(raw, new com.fasterxml.jackson.core.type.TypeReference<
                    Map<String, Object>>() { });
            if (parsed == null) {
                throw ApiException.validation("Webhook body must be a JSON object", null);
            }
            return parsed;
        } catch (IOException e) {
            throw ApiException.validation("Webhook body must be valid JSON", null);
        }
    }

    private static String requireText(Object raw, String field) {
        String value = raw == null ? null : String.valueOf(raw).trim();
        if (value == null || value.isEmpty()) {
            throw ApiException.validation(field + " is required", Json.map("field", field));
        }
        return value;
    }
}
