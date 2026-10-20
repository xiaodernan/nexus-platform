package com.nexus.commerce;

import com.nexus.platform.Json;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The payment as it is allowed to leave the service (§42). Both projections are static and read a row
 * {@link PaymentRepository} already loaded, so no path through this class can run a caller's parameters.
 *
 * <p>Field selection <em>is</em> the control, not a nicety: {@code client_secret_ref} (a pointer into a
 * provider's vault) and {@code idempotency_key} (the caller's own replay token) are never projected.
 * {@code provider_ref} <em>is</em>, and the line between the two is identity vs. credential: the ref is
 * the provider's name for the payment object ({@code demo_<paymentId>}), the same value the webhook door
 * resolves on, and knowing it authorises nothing — that route is tenant-scoped and HMAC-signed (§42), so
 * a caller without the signing secret can do no more with the ref than read it back. Suppressing it was
 * the opposite mistake: with no live provider, the confirm response was the only door by which anything
 * could ever construct a signed callback, so {@code POST /webhooks/payments/{provider}} was advertised and
 * unreachable (§155). A projection that spread the whole row would eventually ship a token in a JSON body,
 * which is the one thing §42 rules out — so the keys are written out, and adding one is a deliberate act.
 */
public final class PaymentService {

    private PaymentService() {
    }

    /** The payment block on an order read: what moved, what is still waiting, and why it failed. */
    public static Map<String, Object> paymentView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("payment_id", Json.str(row, "id"));
        out.put("order_id", Json.str(row, "order_id"));
        out.put("provider", Json.str(row, "provider"));
        out.put("provider_ref", Json.str(row, "provider_ref"));
        out.put("status", Json.str(row, "status"));
        out.put("amount", Json.money(row, "amount", "currency"));
        out.put("failure_reason", Json.str(row, "failure_reason"));
        out.put("captured_at", Json.ts(row, "captured_at"));
        out.put("created_at", Json.ts(row, "created_at"));
        return out;
    }

    /**
     * {@code payment_intent} in the {@code POST /api/v1/carts/checkout} response (§4). Called
     * "intent" because that is what it is: a row recording what the order is owed. Nothing here claims
     * money moved, and {@code captured} says so in the same object a client might otherwise read as a
     * receipt (§109 — a demo payment must not be allowed to look like a real one).
     */
    public static Map<String, Object> paymentIntent(Map<String, Object> row) {
        String status = Json.str(row, "status");
        Map<String, Object> out = new LinkedHashMap<>(paymentView(row));
        out.put("captured", "captured".equals(status) || "authorized".equals(status));
        out.put("card_data_stored", false);
        out.put("notice", "No money has moved. This deployment has no live payment provider, so the row "
                + "records what the order is owed and nothing more; no card data is held anywhere (§42).");
        return out;
    }
}
