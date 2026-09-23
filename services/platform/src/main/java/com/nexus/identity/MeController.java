package com.nexus.identity;

import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code /api/v1/me/**} — profile, preferences memory, favorites, saved searches, my orders /
 * reservations / conversations, export and deletion (§3, §32-33, §106).
 */
@RestController
@RequestMapping("/api/v1/me")
@RequiresAuth
public class MeController {

    public record ProfilePatch(@Size(min = 1, max = 120) String displayName,
                               @Pattern(regexp = "^(en|zh-HK|zh-CN)$") String locale,
                               @Size(max = 512) String avatarUrl,
                               @Size(max = 32) String phone,
                               Boolean marketingOptIn) {
    }

    public record PreferenceBody(@NotBlank @Pattern(regexp = "^(food|budget|location|brand|style|activity|language|accessibility)$")
                                 String kind,
                                 @NotBlank @Size(max = 64) String key,
                                 @NotNull Object value,
                                 @jakarta.validation.constraints.DecimalMin("0")
                                 @jakarta.validation.constraints.DecimalMax("1")
                                 Double weight,
                                 @Pattern(regexp = "^(declared|inferred|transaction)$") String source,
                                 @Pattern(regexp = "^(session|long_term)$") String scope,
                                 Integer ttlDays) {
    }

    public record FavoriteBody(@NotBlank @Pattern(regexp = "^(merchant|offering|guide|collection)$") String subjectType,
                               @NotBlank String subjectId,
                               @Size(max = 280) String note) {
    }

    public record SavedSearchBody(@Size(max = 120) String name, @NotBlank @Size(max = 500) String query,
                                  Map<String, Object> intent,
                                  @com.fasterxml.jackson.annotation.JsonProperty("notify") Boolean notifyOnSave) {
    }

    private final IdentityRepository users;
    private final TenantJdbc jdbc;
    private final AuditService audit;
    private final PermissionService permissions;
    private final com.nexus.catalog.CollectionsRepository collections;

    public MeController(IdentityRepository users, TenantJdbc jdbc, AuditService audit,
                        PermissionService permissions, com.nexus.catalog.CollectionsRepository collections) {
        this.users = users;
        this.jdbc = jdbc;
        this.audit = audit;
        this.permissions = permissions;
        this.collections = collections;
    }

    // ---- profile --------------------------------------------------------

    @GetMapping
    public Map<String, Object> me(HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        Map<String, Object> row = users.requireUser(tenant, userId);
        Map<String, Object> out = new LinkedHashMap<>(AuthService.userView(tenant, row));
        out.put("memberships", memberships(tenant, userId));
        out.put("preferences_summary", preferencesSummary(tenant, userId));
        out.put("identities", users.identitiesOf(tenant, userId).stream().map(r -> Json.map(
                "provider", Json.str(r, "provider"),
                "verified_at", Json.ts(r, "verified_at"))).toList());
        return out;
    }

    @PatchMapping
    public Map<String, Object> patch(@Valid @RequestBody ProfilePatch body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        users.updateProfile(tenant, userId, body.displayName(), body.locale(), body.avatarUrl(),
                body.marketingOptIn(), body.phone());
        audit.record(request, "update_profile", "user", userId, null, null, null, Json.map("fields",
                List.of(nonNullFields(body))));
        return AuthService.userView(tenant, users.requireUser(tenant, userId));
    }

    /** §106: requesting deletion erases PII now and records the request for the retention job. */
    @DeleteMapping
    public Map<String, Object> delete(HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        users.createDeletionRequest(tenant, userId, "account", Json.map("requested_by", "user"));
        users.eraseUser(tenant, userId);
        audit.record(request, "delete_data", "user", userId, null, null, null,
                Json.map("kind", "account", "pii_columns", List.of("email", "phone", "password_hash", "display_name")));
        return Json.map("status", "deleted",
                "notice", "Personal identifiers were erased. Transaction records are retained for accounting; "
                        + "a deletion_request row was created for the retention job (§106).");
    }

    /** §106 export: assembled JSON of everything the platform holds about this user. */
    @GetMapping("/export")
    public Map<String, Object> export(HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        Map<String, Object> profile = AuthService.userView(tenant, users.requireUser(tenant, userId));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("exported_at", java.time.Instant.now().toString());
        out.put("tenant", tenant.slug());
        out.put("profile", profile);
        out.put("preferences", users.listPreferences(tenant, userId, null));
        out.put("favorites", users.listFavorites(tenant, userId));
        out.put("saved_searches", users.listSavedSearches(tenant, userId));
        out.put("identities", users.identitiesOf(tenant, userId));
        out.put("orders", exportRows(tenant, userId, "select o.id, o.code, o.status, o.total, o.currency, o.created_at,"
                + " o.merchant_id, u.tenant_id from orders o join users u on u.id = o.user_id"
                + " where o.user_id = :user_id and u.tenant_id = :tenant_id order by o.created_at desc limit :limit"));
        out.put("reservations", exportRows(tenant, userId, "select r.id, r.code, r.status, r.starts_at, r.party_size,"
                + " r.merchant_id, u.tenant_id from reservations r join users u on u.id = r.user_id"
                + " where r.user_id = :user_id and u.tenant_id = :tenant_id order by r.created_at desc limit :limit"));
        out.put("reviews", exportRows(tenant, userId, "select rv.id, rv.rating, rv.title, rv.body, rv.merchant_id,"
                + " u.tenant_id, rv.created_at from reviews rv join users u on u.id = rv.user_id"
                + " where rv.user_id = :user_id and u.tenant_id = :tenant_id order by rv.created_at desc limit :limit"));
        out.put("conversations", exportRows(tenant, userId, "select c.id, c.channel, c.mode, c.status, c.merchant_id,"
                + " u.tenant_id, c.created_at from conversations c join users u on u.id = c.user_id"
                + " where c.user_id = :user_id and u.tenant_id = :tenant_id order by c.created_at desc limit :limit"));
        out.put("messages", exportRows(tenant, userId, "select m.id, m.sender_type, m.role, m.content, m.created_at,"
                + " u.tenant_id from messages m join conversations c on c.id = m.conversation_id"
                + " join users u on u.id = c.user_id where c.user_id = :user_id and u.tenant_id = :tenant_id"
                + " order by m.created_at limit :limit"));
        out.put("notifications", exportRows(tenant, userId, "select n.id, n.channel, n.template, n.payload, n.read_at,"
                + " n.created_at from notifications n where n.user_id = :user_id and n.tenant_id = :tenant_id"
                + " order by n.created_at desc limit :limit"));
        out.put("events", exportRows(tenant, userId, "select e.event_id, e.name, e.subject_type, e.subject_id,"
                + " e.occurred_at from events e where e.actor_type = 'user' and e.actor_id = :user_id"
                + " and e.tenant_id = :tenant_id order by e.occurred_at desc limit :limit"));
        out.put("deletion_requests", users.deletionRequests(tenant, userId));
        audit.record(request, "export_data", "user", userId, null, null, null, Json.map("format", "json"));
        return out;
    }

    // ---- preferences (§32, §33: user-visible, editable, deletable) ------

    @GetMapping("/preferences")
    public List<Map<String, Object>> preferences(@RequestParam(required = false) String kind, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        return preferenceViews(users.listPreferences(tenant, Req.userId(request), kind));
    }

    @PostMapping("/preferences")
    public Map<String, Object> putPreference(@Valid @RequestBody PreferenceBody body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        UUID id = users.upsertPreference(tenant, userId, body.kind(), body.key(),
                body.value() == null ? "null" : Json.write(body.value()), body.weight(),
                body.source() == null ? "declared" : body.source(),
                body.scope() == null ? "long_term" : body.scope(), body.ttlDays());
        audit.record(request, "set_preference", "user_preference", id, null, null, null,
                Json.map("kind", body.kind(), "key", body.key()));
        return preferenceView(users.findPreference(tenant, userId, id)
                .orElseThrow(() -> com.nexus.platform.ApiException.internal("Preference vanished", null)));
    }

    @PatchMapping("/preferences/{id}")
    public Map<String, Object> patchPreference(@PathVariable UUID id, @Valid @RequestBody PreferenceBody body,
                                               HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        users.updatePreference(tenant, userId, id,
                body.value() == null ? null : Json.write(body.value()), body.weight(), body.scope());
        audit.record(request, "update_preference", "user_preference", id, null, null, null, Json.map());
        return preferenceView(users.findPreference(tenant, userId, id)
                .orElseThrow(() -> com.nexus.platform.ApiException.notFound("preference_not_found", "No such preference")));
    }

    @DeleteMapping("/preferences/{id}")
    public Map<String, Object> deletePreference(@PathVariable UUID id, HttpServletRequest request) {
        users.deletePreference(Req.tenant(request), Req.userId(request), id);
        audit.record(request, "delete_preference", "user_preference", id, null, null, null, Json.map());
        return Json.map("status", "deleted", "id", id.toString());
    }

    @PostMapping("/personalization/reset")
    public Map<String, Object> resetPersonalization(HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        int removed = users.deleteInferredPreferences(tenant, userId);
        audit.record(request, "reset_personalization", "user", userId, null, null, null,
                Json.map("removed_inferred", removed));
        return Json.map("removed_inferred_preferences", removed,
                "notice", "Declared preferences you typed yourself are kept; only inferred memory was wiped (§33).");
    }

    // ---- favorites ------------------------------------------------------

    @GetMapping("/favorites")
    public List<Map<String, Object>> favorites(HttpServletRequest request) {
        return users.listFavorites(Req.tenant(request), Req.userId(request)).stream()
                .map(r -> Json.map("id", Json.str(r, "id"), "subject_type", Json.str(r, "subject_type"),
                        "subject_id", Json.str(r, "subject_id"), "note", Json.str(r, "note"),
                        "created_at", Json.ts(r, "created_at")))
                .toList();
    }

    @PostMapping("/favorites")
    public Map<String, Object> addFavorite(@Valid @RequestBody FavoriteBody body, HttpServletRequest request) {
        UUID subjectId = Json.uuidOrNull(body.subjectId());
        if (subjectId == null) {
            throw com.nexus.platform.ApiException.validation("subject_id must be a uuid",
                    Json.map("field", "subject_id"));
        }
        TenantContext tenant = Req.tenant(request);
        // A favorite may only point at something in the caller's tenant.
        assertSubjectInTenant(tenant, body.subjectType(), subjectId);
        UUID id = users.addFavorite(tenant, Req.userId(request), body.subjectType(), subjectId, body.note());
        audit.record(request, "favorite", body.subjectType(), subjectId, null, null, null,
                Json.map("subject_type", body.subjectType()));
        return Json.map("id", id.toString(), "subject_type", body.subjectType(), "subject_id", subjectId.toString(),
                "status", "saved");
    }

    @DeleteMapping("/favorites/{type}/{id}")
    public Map<String, Object> removeFavorite(@PathVariable String type, @PathVariable UUID id,
                                              HttpServletRequest request) {
        users.removeFavorite(Req.tenant(request), Req.userId(request), type, id);
        return Json.map("status", "removed");
    }

    // ---- saved searches -------------------------------------------------

    @GetMapping("/saved-searches")
    public List<Map<String, Object>> savedSearches(HttpServletRequest request) {
        return users.listSavedSearches(Req.tenant(request), Req.userId(request)).stream()
                .map(r -> Json.map("id", Json.str(r, "id"), "name", Json.str(r, "name"), "query", Json.str(r, "query"),
                        "intent", Json.json(r, "intent"), "notify", Json.bool(r, "notify"),
                        "created_at", Json.ts(r, "created_at")))
                .toList();
    }

    @PostMapping("/saved-searches")
    public Map<String, Object> saveSearch(@Valid @RequestBody SavedSearchBody body, HttpServletRequest request) {
        UUID id = users.saveSearch(Req.tenant(request), Req.userId(request), body.name(), body.query(),
                body.intent() == null ? Map.of() : Json.write(body.intent()),
                Boolean.TRUE.equals(body.notifyOnSave()));
        return Json.map("id", id.toString(), "status", "saved");
    }

    @DeleteMapping("/saved-searches/{id}")
    public Map<String, Object> deleteSavedSearch(@PathVariable UUID id, HttpServletRequest request) {
        users.deleteSavedSearch(Req.tenant(request), Req.userId(request), id);
        return Json.map("status", "removed");
    }

    // ---- my orders / reservations / conversations ----------------------

    @GetMapping("/orders")
    public List<Map<String, Object>> myOrders(HttpServletRequest request) {
        return jdbc.forTenant(Req.tenant(request), """
                select o.id, o.code, o.status, o.fulfillment, o.subtotal, o.discount_total, o.total, o.currency,
                       o.created_at, m.display_name as merchant_name, m.slug as merchant_slug, u.tenant_id
                from orders o join users u on u.id = o.user_id join merchants m on m.id = o.merchant_id
                where o.user_id = :user_id and u.tenant_id = :tenant_id
                order by o.created_at desc limit 100
                """, Json.map("user_id", Req.userId(request))).stream()
                .map(r -> orderSummary(r)).toList();
    }

    @GetMapping("/reservations")
    public List<Map<String, Object>> myReservations(HttpServletRequest request) {
        return jdbc.forTenant(Req.tenant(request), """
                select r.id, r.code, r.status, r.starts_at, r.ends_at, r.party_size, r.total_amount, r.currency,
                       r.created_at, m.display_name as merchant_name, u.tenant_id
                from reservations r join users u on u.id = r.user_id join merchants m on m.id = r.merchant_id
                where r.user_id = :user_id and u.tenant_id = :tenant_id
                order by r.created_at desc limit 100
                """, Json.map("user_id", Req.userId(request))).stream()
                .map(r -> Json.map("id", Json.str(r, "id"), "code", Json.str(r, "code"),
                        "status", Json.str(r, "status"), "starts_at", Json.ts(r, "starts_at"),
                        "ends_at", Json.ts(r, "ends_at"), "party_size", Json.integer(r, "party_size"),
                        "price", Json.money(r, "total_amount", "currency"),
                        "merchant", Json.map("name", Json.str(r, "merchant_name")),
                        "created_at", Json.ts(r, "created_at")))
                .toList();
    }

    @GetMapping("/conversations")
    public List<Map<String, Object>> myConversations(HttpServletRequest request) {
        return jdbc.forTenant(Req.tenant(request), """
                select c.id, c.channel, c.mode, c.status, c.subject, c.last_message_at, c.created_at,
                       m.display_name as merchant_name, u.tenant_id
                from conversations c join users u on u.id = c.user_id
                left join merchants m on m.id = c.merchant_id
                where c.user_id = :user_id and u.tenant_id = :tenant_id
                order by coalesce(c.last_message_at, c.created_at) desc limit 100
                """, Json.map("user_id", Req.userId(request))).stream()
                .map(r -> Json.map("id", Json.str(r, "id"), "channel", Json.str(r, "channel"),
                        "mode", Json.str(r, "mode"), "status", Json.str(r, "status"),
                        "subject", Json.str(r, "subject"), "merchant_name", Json.str(r, "merchant_name"),
                        "last_message_at", Json.ts(r, "last_message_at")))
                .toList();
    }

    // ---- helpers --------------------------------------------------------

    private List<Map<String, Object>> memberships(TenantContext tenant, UUID userId) {
        return jdbc.forTenant(tenant, """
                select mu.id, mu.role, mu.status, mu.created_at, m.id as merchant_id, m.slug, m.display_name,
                       m.status as merchant_status, m.tenant_id
                from merchant_users mu join merchants m on m.id = mu.merchant_id
                where mu.user_id = :user_id and m.tenant_id = :tenant_id
                order by mu.created_at
                """, Json.map("user_id", userId)).stream()
                .map(r -> Json.map("member_id", Json.str(r, "id"), "role", Json.str(r, "role"),
                        "status", Json.str(r, "status"),
                        "merchant", Json.map("id", Json.str(r, "merchant_id"), "slug", Json.str(r, "slug"),
                                "display_name", Json.str(r, "display_name"), "status", Json.str(r, "merchant_status")),
                        // Read from the grant rows, not from the role string (D40, D42). This used to answer a
                        // hard-coded empty list, which is worse than omitting the field: a console that
                        // trusted it rendered an owner with no capabilities, and nothing about the payload
                        // said the list was a placeholder. Same source and same spelling union as
                        // `GET /members`, so the two doors cannot describe one person differently.
                        "permissions", "active".equals(Json.str(r, "status"))
                                ? permissions.grantedToHuman(tenant, userId, Json.uuid(r, "merchant_id"))
                                : List.of()))
                .toList();
    }

    private Map<String, Object> preferencesSummary(TenantContext tenant, UUID userId) {
        List<Map<String, Object>> prefs = users.listPreferences(tenant, userId, null);
        Map<String, Long> byKind = new LinkedHashMap<>();
        prefs.forEach(p -> byKind.merge(Json.requiredStr(p, "kind"), 1L, Long::sum));
        return Json.map("count", prefs.size(), "by_kind", byKind,
                "declared", prefs.stream().filter(p -> "declared".equals(Json.str(p, "source"))).count());
    }

    private List<Map<String, Object>> preferenceViews(List<Map<String, Object>> rows) {
        List<Map<String, Object>> out = new ArrayList<>();
        rows.forEach(r -> out.add(preferenceView(r)));
        return out;
    }

    private Map<String, Object> preferenceView(Map<String, Object> r) {
        return Json.map("id", Json.str(r, "id"), "kind", Json.str(r, "kind"), "key", Json.str(r, "key"),
                "value", Json.json(r, "value"), "weight", Json.dec(r, "weight"), "source", Json.str(r, "source"),
                "scope", Json.str(r, "scope"), "expires_at", Json.ts(r, "expires_at"),
                "created_at", Json.ts(r, "created_at"), "updated_at", Json.ts(r, "updated_at"));
    }

    private Map<String, Object> orderSummary(Map<String, Object> r) {
        return Json.map("id", Json.str(r, "id"), "code", Json.str(r, "code"), "status", Json.str(r, "status"),
                "fulfillment", Json.str(r, "fulfillment"),
                "subtotal", Json.money(r, "subtotal", "currency"),
                "discount_total", Json.money(r, "discount_total", "currency"),
                "total", Json.money(r, "total", "currency"),
                "merchant", Json.map("id", Json.str(r, "merchant_id"), "name", Json.str(r, "merchant_name")),
                "created_at", Json.ts(r, "created_at"));
    }

    private List<Map<String, Object>> exportRows(TenantContext tenant, UUID userId, String sql) {
        return users.exportRows(tenant, userId, sql, 500);
    }

    private void assertSubjectInTenant(TenantContext tenant, String subjectType, UUID subjectId) {
        if ("collection".equals(subjectType) || "guide".equals(subjectType)) {
            // §8's rule, asked rather than copied: a draft, an unattributable row or another tenant's collection
            // is something the directory will not show, so saving it would be saving a link to a 404 (D50). The
            // subject is also pinned to its kind, because {@code guide} is a row of this table labelled
            // otherwise — and the request pattern has advertised that type since §7, so an id saved under the
            // wrong label has to be refused rather than resolve later as something else. The refusal is the
            // same code and message the merchant branch gives, because D5 says an unreadable thing reads absent.
            if (!collections.isPublishable(tenant, subjectId, subjectType)) {
                throw com.nexus.platform.ApiException.notFound("subject_not_found", "No such record");
            }
            return;
        }
        String sql = switch (subjectType) {
            case "merchant" -> "select id from merchants where id = :id and tenant_id = :tenant_id";
            case "offering" -> """
                    select o.id from offerings o join merchants m on m.id = o.merchant_id
                    where o.id = :id and m.tenant_id = :tenant_id""";
            default -> throw com.nexus.platform.ApiException.validation("Unsupported subject_type",
                    Json.map("field", "subject_type"));
        };
        jdbc.oneForTenant(tenant, sql, Json.map("id", subjectId), "subject_not_found");
    }

    private static String[] nonNullFields(ProfilePatch body) {
        List<String> fields = new ArrayList<>();
        if (body.displayName() != null) {
            fields.add("display_name");
        }
        if (body.locale() != null) {
            fields.add("locale");
        }
        if (body.avatarUrl() != null) {
            fields.add("avatar_url");
        }
        if (body.phone() != null) {
            fields.add("phone");
        }
        if (body.marketingOptIn() != null) {
            fields.add("marketing_opt_in");
        }
        return fields.toArray(new String[0]);
    }
}
