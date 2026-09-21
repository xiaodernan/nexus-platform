package com.nexus.notification;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Writes the in-app inbox and fans out to the channels a subject opted into (§123-125).
 *
 * <p>Channel policy, stated once here:
 * <ul>
 *   <li>{@code in_app} is always written — it is the durable record and the only channel that cannot
 *       fail.</li>
 *   <li>{@code email} / {@code push} are written only when the subject's declared preference enables
 *       them, and only when a reachable address actually exists on the subject's own row.</li>
 *   <li>Merchant-addressed notifications (leads, handoffs, reviews, bookings) are one {@code in_app}
 *       row visible to every active staff member of that merchant, plus one {@code email} row per
 *       staff member who enabled email — delivery status is per recipient, never per merchant.</li>
 *   <li>Out-of-band send failures are recorded as {@code status='failed'}; they never fail the request
 *       that produced the domain event.</li>
 * </ul>
 */
@Service
public class NotificationService {

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);

    /** Channels a subject can opt into. {@code whatsapp} is schema-legal but has no transport yet. */
    public static final Set<String> CHANNELS = Set.of("in_app", "email", "push");
    private static final Map<String, Boolean> DEFAULTS = Map.of("in_app", true, "email", true, "push", false);

    private final NotificationRepository notifications;
    private final TenantJdbc jdbc;
    private final Paging paging;
    private final EmailProvider email;
    private final PushProvider push;

    public NotificationService(NotificationRepository notifications, TenantJdbc jdbc, Paging paging,
                               EmailProvider email, PushProvider push) {
        this.notifications = notifications;
        this.jdbc = jdbc;
        this.paging = paging;
        this.email = email;
        this.push = push;
    }

    /** Tenant resolution outside a request: the {@code tenants} row is the tenant's definition. */
    public TenantContext tenantById(UUID tenantId) {
        if (tenantId == null) {
            return null;
        }
        return jdbc.crossTenantFirst("select id, slug, currency, timezone, country_code from tenants "
                        + "where id = :id and status = 'active'", Json.map("id", tenantId))
                .map(r -> new TenantContext(Json.uuid(r, "id"), Json.str(r, "slug"), Json.str(r, "currency"),
                        Json.str(r, "timezone"), Json.str(r, "country_code")))
                .orElse(null);
    }

    // ---- generation ------------------------------------------------------

    /** Notify a consumer. Returns the in-app row id (the other channels get their own rows). */
    public UUID notifyUser(TenantContext tenant, UUID userId, String template, Map<String, Object> payload) {
        if (userId == null) {
            log.info("notification_skipped template={} reason=no_user", template);
            return null;
        }
        Map<String, Object> body = payload == null ? Map.of() : payload;
        UUID inApp = insert(tenant, "consumer", userId, merchantOf(template, body), "in_app", template, body, "sent");
        Map<String, Boolean> prefs = effectivePreferences(tenant, userId);
        String emailTo = userEmail(userId);
        if (Boolean.TRUE.equals(prefs.get("email")) && emailTo != null && !emailTo.isBlank()) {
            deliverEmail(tenant, "consumer", userId, null, template, body, emailTo);
        }
        if (Boolean.TRUE.equals(prefs.get("push"))) {
            deliverPush(tenant, "consumer", userId, null, template, body);
        }
        return inApp;
    }

    /** Notify a merchant workspace (in-app for its staff, email to the staff members who want it). */
    public UUID notifyMerchant(TenantContext tenant, UUID merchantId, String template, Map<String, Object> payload) {
        if (merchantId == null) {
            log.info("notification_skipped template={} reason=no_merchant", template);
            return null;
        }
        Map<String, Object> body = payload == null ? Map.of() : payload;
        UUID inApp = insert(tenant, "merchant", null, merchantId, "in_app", template, body, "sent");
        for (Map<String, Object> staff : activeStaff(tenant, merchantId)) {
            UUID userId = Json.uuid(staff, "user_id");
            String address = Json.str(staff, "email");
            if (userId == null || address == null || address.isBlank()) {
                continue;
            }
            if (!Boolean.TRUE.equals(effectivePreferences(tenant, userId).get("email"))) {
                continue;
            }
            deliverEmail(tenant, "merchant", userId, merchantId, template, body, address);
        }
        return inApp;
    }

    private void deliverEmail(TenantContext tenant, String audience, UUID userId, UUID merchantId,
                              String template, Map<String, Object> payload, String address) {
        UUID id = insert(tenant, audience, userId, merchantId, "email", template, payload, "pending");
        Rendered r = render(template, payload);
        boolean accepted = false;
        try {
            accepted = email.send(id, address, template, r.subject(), r.body(), payload);
        } catch (RuntimeException e) {
            log.warn("email_delivery_error notification_id={} type={}", id, e.getClass().getSimpleName());
        }
        notifications.markDelivery(tenant, id, accepted ? "sent" : "failed");
    }

    private void deliverPush(TenantContext tenant, String audience, UUID userId, UUID merchantId,
                             String template, Map<String, Object> payload) {
        UUID id = insert(tenant, audience, userId, merchantId, "push", template, payload, "pending");
        // No device registry exists in the fixed V1 schema, so a token cannot be resolved honestly.
        Rendered r = render(template, payload);
        boolean accepted = false;
        try {
            accepted = push.send(id, "", template, r.subject(), r.body(), payload);
        } catch (RuntimeException e) {
            log.warn("push_delivery_error notification_id={} type={}", id, e.getClass().getSimpleName());
        }
        notifications.markDelivery(tenant, id, accepted ? "sent" : "failed");
    }

    private UUID insert(TenantContext tenant, String audience, UUID userId, UUID merchantId, String channel,
                        String template, Map<String, Object> payload, String status) {
        Map<String, Object> row = notifications.insert(tenant, audience, userId, merchantId, channel, template,
                Json.write(payload), status);
        return Json.uuid(row, "id");
    }

    // ---- reading ---------------------------------------------------------

    public Map<String, Object> list(TenantContext tenant, UUID userId, boolean unreadOnly, int limit, int offset) {
        List<Map<String, Object>> items = notifications.list(tenant, userId, unreadOnly, limit, offset).stream()
                .map(NotificationService::view).toList();
        long total = notifications.count(tenant, userId, unreadOnly);
        return paging.page(items, offset, limit, total);
    }

    public long unreadCount(TenantContext tenant, UUID userId) {
        return notifications.count(tenant, userId, true);
    }

    public Map<String, Object> markRead(TenantContext tenant, UUID id, UUID userId) {
        Map<String, Object> row = notifications.findVisible(tenant, id, userId)
                .orElseThrow(() -> ApiException.notFound("notification_not_found", "No such notification"));
        notifications.markRead(tenant, id, userId);
        Map<String, Object> out = new LinkedHashMap<>(view(row));
        out.put("read_at", java.time.OffsetDateTime.now().toInstant().toString());
        return out;
    }

    public int markAllRead(TenantContext tenant, UUID userId) {
        return notifications.markAllRead(tenant, userId);
    }

    public Map<String, Object> preferences(TenantContext tenant, UUID userId) {
        Map<String, Boolean> declared = notifications.declaredPreferences(tenant, userId);
        Map<String, Object> out = new LinkedHashMap<>();
        for (String channel : List.of("in_app", "email", "push")) {
            out.put(channel, declared.getOrDefault(channel, DEFAULTS.get(channel)));
        }
        out.put("editable_channels", List.copyOf(CHANNELS));
        return out;
    }

    public Map<String, Object> setPreferences(TenantContext tenant, UUID userId, Map<String, Object> body) {
        if (body == null || body.isEmpty()) {
            throw ApiException.validation("At least one channel is required", Json.map("channels", List.copyOf(CHANNELS)));
        }
        for (String key : body.keySet()) {
            if (!CHANNELS.contains(key)) {
                throw ApiException.validation("Unknown notification channel '" + key + "'",
                        Json.map("allowed", List.copyOf(CHANNELS)));
            }
            if (!(body.get(key) instanceof Boolean)) {
                throw ApiException.validation("Preference '" + key + "' must be a boolean",
                        Json.map("field", key));
            }
        }
        body.forEach((k, v) -> notifications.setPreference(tenant, userId, k, (Boolean) v));
        return preferences(tenant, userId);
    }

    public Map<String, Boolean> effectivePreferences(TenantContext tenant, UUID userId) {
        Map<String, Boolean> declared = notifications.declaredPreferences(tenant, userId);
        Map<String, Boolean> out = new LinkedHashMap<>(DEFAULTS);
        declared.forEach((k, v) -> {
            if (CHANNELS.contains(k)) {
                out.put(k, v);
            }
        });
        return out;
    }

    // ---- helpers ---------------------------------------------------------

    private static Map<String, Object> view(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", String.valueOf(Json.uuid(row, "id")));
        out.put("audience", Json.str(row, "audience"));
        out.put("channel", Json.str(row, "channel"));
        out.put("template", Json.str(row, "template"));
        out.put("payload", Json.jsonObject(row, "payload"));
        out.put("status", Json.str(row, "status"));
        out.put("read_at", Json.ts(row, "read_at"));
        out.put("sent_at", Json.ts(row, "sent_at"));
        out.put("created_at", Json.ts(row, "created_at"));
        Object merchant = Json.uuid(row, "merchant_id");
        out.put("merchant_id", merchant == null ? null : String.valueOf(merchant));
        return out;
    }

    /** A consumer notification about a specific merchant is stamped with it so the inbox can link. */
    private static UUID merchantOf(String template, Map<String, Object> payload) {
        Object v = payload.get("merchant_id");
        return v instanceof UUID u ? u : Json.uuidOrNull(v == null ? null : String.valueOf(v));
    }

    private String userEmail(UUID userId) {
        // users has no tenant column of its own; this is a profile lookup for the already-authenticated
        // subject id taken from their verified token, not a query a client can steer.
        return jdbc.crossTenantFirst("select email from users where id = :id", Json.map("id", userId))
                .map(r -> Json.str(r, "email")).orElse(null);
    }

    private List<Map<String, Object>> activeStaff(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, """
                select mu.user_id as user_id, u.email as email
                from merchant_users mu
                join users u on u.id = mu.user_id
                join merchants m on m.id = mu.merchant_id
                where m.tenant_id = :tenant_id and mu.merchant_id = :merchant_id
                  and mu.status = 'active' and u.status = 'active'
                """, Json.map("merchant_id", merchantId));
    }

    // ---- rendering -------------------------------------------------------

    record Rendered(String subject, String body) {
    }

    /**
     * Server-side templates. Text is assembled only from payload values the emitter actually put
     * there; an unknown template renders its own key plus the payload rather than invented copy.
     */
    public static Rendered render(String template, Map<String, Object> payload) {
        Map<String, Object> p = payload == null ? Map.of() : payload;
        String title = str(p.get("title"));
        return switch (template == null ? "" : template) {
            case "lead_new" -> new Rendered("New lead in your workspace",
                    title == null ? "A consumer started a conversation with you." : title);
            case "handoff_requested" -> new Rendered("A question needs a human",
                    title == null ? "The AI agent could not answer and handed the conversation to you." : title);
            case "handoff_resolved" -> new Rendered("Your question was answered",
                    title == null ? "A team member picked up your conversation." : title);
            case "review_new" -> new Rendered("New review",
                    title == null ? "A customer left you a review." : title);
            default -> {
                if (template != null && template.startsWith("reservation_")) {
                    yield new Rendered("Reservation update",
                            title == null ? "One of your reservations is now "
                                    + template.substring("reservation_".length()) + "." : title);
                }
                if (template != null && template.startsWith("order_")) {
                    yield new Rendered("Order update",
                            title == null ? "An order moved to " + template.substring("order_".length()) + "." : title);
                }
                yield new Rendered(title == null ? template : title,
                        title == null ? String.valueOf(p) : title);
            }
        };
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }
}
