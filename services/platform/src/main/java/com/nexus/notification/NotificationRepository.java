package com.nexus.notification;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Repository;

/**
 * Data access for the in-app inbox.
 *
 * <p>Visibility rule (API_CONTRACT §3: "merchant notifications are read through the same route with
 * the merchant membership"): a subject sees rows addressed to them personally, plus rows addressed to
 * a merchant they are an <em>active</em> member of <em>in their own tenant</em>. That rule is written
 * once, as {@link #VISIBLE}, so every read path shares it — a notification can never leak across
 * tenants or to a staff member whose membership was revoked.
 *
 * <p>{@code notifications} carries {@code tenant_id}; {@code user_preferences} (where per-user channel
 * preferences live) does not, so preference statements join through {@code users} for the predicate.
 */
@Repository
public class NotificationRepository {

    /**
     * One tenant predicate for the whole inbox. {@code :user_id} is the acting subject's user id,
     * taken from the verified JWT — never from a request parameter.
     */
    private static final String VISIBLE = """
            n.user_id = :user_id
            or (n.audience = 'merchant' and n.merchant_id in (
                  select mu.merchant_id from merchant_users mu
                  join merchants m on m.id = mu.merchant_id
                  where m.tenant_id = :tenant_id and mu.user_id = :user_id and mu.status = 'active'))
            """;

    private static final String COLUMNS = """
            n.id, n.audience, n.channel, n.template, n.payload, n.status, n.read_at, n.sent_at,
            n.created_at, n.user_id, n.merchant_id
            """;

    private final TenantJdbc jdbc;

    public NotificationRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    public Map<String, Object> insert(TenantContext tenant, String audience, UUID userId, UUID merchantId,
                                      String channel, String template, String payloadJson, String status) {
        return jdbc.insertForTenant(tenant, """
                insert into notifications (tenant_id, audience, user_id, merchant_id, channel, template,
                                          payload, status)
                values (:tenant_id, :audience, :user_id, :merchant_id, :channel, :template,
                        cast(:payload as jsonb), :status)
                returning id, created_at
                """, Json.map("audience", audience, "user_id", userId, "merchant_id", merchantId,
                "channel", channel, "template", template, "payload", payloadJson, "status", status));
    }

    public List<Map<String, Object>> list(TenantContext tenant, UUID userId, boolean unreadOnly,
                                          int limit, int offset) {
        return jdbc.forTenant(tenant, "select " + COLUMNS + """
                from notifications n
                where n.tenant_id = :tenant_id
                  and (""" + VISIBLE + ") "
                + (unreadOnly ? "and n.read_at is null " : "")
                + "order by n.created_at desc, n.id desc limit :limit offset :offset",
                Json.map("user_id", userId, "limit", limit, "offset", offset));
    }

    public long count(TenantContext tenant, UUID userId, boolean unreadOnly) {
        return jdbc.countForTenant(tenant, """
                select count(*)
                from notifications n
                where n.tenant_id = :tenant_id
                  and (""" + VISIBLE + ") "
                + (unreadOnly ? "and n.read_at is null" : ""),
                Json.map("user_id", userId));
    }

    /** Not visible to this subject → empty, which the service renders as a 404 (D5: no enumeration). */
    public Optional<Map<String, Object>> findVisible(TenantContext tenant, UUID id, UUID userId) {
        return jdbc.firstForTenant(tenant, "select " + COLUMNS + """
                from notifications n
                where n.tenant_id = :tenant_id and n.id = :id
                  and (""" + VISIBLE + ")",
                Json.map("id", id, "user_id", userId));
    }

    public int markRead(TenantContext tenant, UUID id, UUID userId) {
        return jdbc.updateForTenant(tenant, """
                update notifications n set read_at = now(), status = 'sent'
                where n.tenant_id = :tenant_id and n.id = :id and n.read_at is null
                  and (""" + VISIBLE + ")",
                Json.map("id", id, "user_id", userId));
    }

    public int markAllRead(TenantContext tenant, UUID userId) {
        return jdbc.updateForTenant(tenant, """
                update notifications n set read_at = now(), status = 'sent'
                where n.tenant_id = :tenant_id and n.read_at is null
                  and (""" + VISIBLE + ")",
                Json.map("user_id", userId));
    }

    /** Only ever moves a push/email row; in-app rows have no delivery lifecycle. */
    public int markDelivery(TenantContext tenant, UUID id, String status) {
        return jdbc.updateForTenant(tenant, """
                update notifications set status = :status, sent_at = now()
                where id = :id and tenant_id = :tenant_id and channel in ('email','push','whatsapp')
                """, Json.map("id", id, "status", status));
    }

    // ---- per-user channel preferences (stored in user_preferences, kind='notification_channel') ----

    /** Declared preferences only; absent keys mean "use {@link ChannelPreferences#defaultFor}". */
    public Map<String, Boolean> declaredPreferences(TenantContext tenant, UUID userId) {
        List<Map<String, Object>> rows = jdbc.forTenant(tenant, """
                select p.key, p.value
                from user_preferences p join users u on u.id = p.user_id
                where u.tenant_id = :tenant_id and p.user_id = :user_id and p.kind = 'notification_channel'
                order by p.key
                """, Json.map("user_id", userId));
        Map<String, Boolean> out = new LinkedHashMap<>();
        for (Map<String, Object> row : rows) {
            Boolean enabled = Json.bool(Json.jsonObject(row, "value"), "enabled");
            out.put(Json.str(row, "key"), enabled != null && enabled);
        }
        return out;
    }

    /**
     * {@code user_preferences} has no tenant column, so ownership is proven by the {@code users} join
     * after the upsert — a foreign user id surfaces as 404 instead of writing an orphan row.
     */
    public void setPreference(TenantContext tenant, UUID userId, String channel, boolean enabled) {
        int written = jdbc.raw().update("""
                insert into user_preferences (user_id, kind, key, value, source, scope)
                select u.id, 'notification_channel', :key, cast(:value as jsonb), 'declared', 'long_term'
                from users u
                where u.id = :user_id and u.tenant_id = :tenant_id
                on conflict (user_id, kind, key) do update set value = excluded.value, updated_at = now()
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource()
                .addValue("user_id", userId).addValue("key", channel)
                .addValue("value", Json.write(Json.map("enabled", enabled)))
                .addValue("tenant_id", tenant.tenantId()));
        if (written == 0) {
            throw ApiException.notFound("user_not_found", "No such user in this tenant");
        }
    }

    /** Merchant ids the subject actively belongs to in this tenant — used to address merchant mail. */
    public List<UUID> merchantIds(TenantContext tenant, UUID userId) {
        return jdbc.forTenant(tenant, """
                select mu.merchant_id
                from merchant_users mu join merchants m on m.id = mu.merchant_id
                where m.tenant_id = :tenant_id and mu.user_id = :user_id and mu.status = 'active'
                order by mu.created_at
                """, Json.map("user_id", userId)).stream()
                .map(r -> Json.uuid(r, "merchant_id")).filter(java.util.Objects::nonNull)
                .collect(Collectors.toList());
    }
}
