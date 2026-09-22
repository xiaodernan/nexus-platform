package com.nexus.merchant;

import com.nexus.catalog.FactRepository;
import com.nexus.catalog.OfferingRepository;
import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.TenantContext;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Merchant workspace operations: onboarding, verification, and the publish workflow
 * {@code draft → pending_review → published} with explicit guard rules.
 *
 * <p>Guards are computed server-side and reported, never silently skipped — a listing that cannot be
 * published says which condition is missing (§D6 honesty).
 */
@Service
public class MerchantService {

    private final MerchantRepository merchants;
    private final OfferingRepository offerings;
    private final PermissionService permissions;
    private final FactRepository facts;
    private final AuditService audit;

    public MerchantService(MerchantRepository merchants, OfferingRepository offerings,
                           PermissionService permissions, FactRepository facts, AuditService audit) {
        this.merchants = merchants;
        this.offerings = offerings;
        this.permissions = permissions;
        this.facts = facts;
        this.audit = audit;
    }

    /** Creating a business writes the owner membership *and* the owner's grant rows (RBAC source of truth). */
    @Transactional
    public Map<String, Object> createBusiness(TenantContext tenant, Principal principal, Map<String, Object> profile,
                                              List<Map<String, Object>> locations) {
        String slug = slugify(String.valueOf(profile.getOrDefault("slug", profile.get("display_name"))));
        if (slug == null || slug.isBlank()) {
            throw ApiException.validation("slug or display_name is required", Json.map("field", "slug"));
        }
        if (merchants.slugTaken(tenant, slug)) {
            throw ApiException.conflict("slug_taken", "That slug is already used in this tenant",
                    Json.map("slug", slug));
        }
        Map<String, Object> fields = new LinkedHashMap<>(profile);
        fields.put("slug", slug);
        fields.put("status", "draft");
        UUID merchantId = merchants.insert(tenant, fields);

        merchants.addMember(tenant, merchantId, principal.userId(), "owner");
        for (String permission : MerchantPermissions.OWNER) {
            permissions.grant(tenant, "user", principal.userId(), merchantId, permission, principal.userId());
        }
        if (locations != null) {
            for (Map<String, Object> location : locations) {
                UUID locationId = merchants.insertLocation(tenant, merchantId, location);
                recordAddressFact(tenant, merchantId, locationId, location);
            }
        }
        recordProfileFacts(tenant, merchantId, fields);
        audit.record(tenant, principal.subjectType(), principal.userId(), "create_merchant", "merchant", merchantId,
                merchantId, null, Json.map("slug", slug), Json.map(), null, null);

        Map<String, Object> row = merchants.require(tenant, merchantId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant", MerchantRepository.view(row));
        out.put("membership", Json.map("role", "owner", "permissions", MerchantPermissions.OWNER));
        out.put("next_steps", List.of(
                "add at least one location (POST /api/v1/merchant/businesses/{id}/locations)",
                "add opening hours (POST /api/v1/merchant/businesses/{id}/hours)",
                "add offerings (POST /api/v1/merchant/offerings)",
                "submit verification (POST /api/v1/merchant/businesses/{id}/verification)",
                "publish (POST /api/v1/merchant/businesses/{id}/publish)"));
        return out;
    }

    public Map<String, Object> get(TenantContext tenant, UUID merchantId) {
        Map<String, Object> row = merchants.require(tenant, merchantId);
        return MerchantRepository.view(row);
    }

    @Transactional
    public Map<String, Object> updateBusiness(TenantContext tenant, UUID merchantId, Principal principal,
                                              Map<String, Object> patch) {
        Map<String, Object> before = merchants.require(tenant, merchantId);
        if ("published".equals(Json.str(before, "status")) && patch.containsKey("slug")) {
            throw ApiException.validation("slug of a published listing is immutable; unpublish first",
                    Json.map("field", "slug"));
        }
        merchants.updateProfile(tenant, merchantId, patch);
        recordProfileFacts(tenant, merchantId, patch);
        Map<String, Object> after = merchants.require(tenant, merchantId);
        audit.record(tenant, principal.subjectType(), principal.userId(), "update_merchant", "merchant", merchantId,
                merchantId, slim(before), slim(after), Json.map(), null, null);
        return MerchantRepository.view(after);
    }

    /**
     * Verification submission (§48 trust). In this build the review is automatic and *says so*: the
     * response records {@code mode:"self_attested"} and the merchant becomes eligible to publish.
     * A human/platform review queue replaces this step without changing the API shape.
     */
    @Transactional
    public Map<String, Object> verify(TenantContext tenant, UUID merchantId, Principal principal,
                                      Map<String, Object> body) {
        merchants.require(tenant, merchantId);
        String businessReg = str(body.get("business_registration_number"));
        String contactPhone = str(body.get("contact_phone"));
        if (businessReg == null || businessReg.isBlank()) {
            throw ApiException.validation("business_registration_number is required for verification",
                    Json.map("field", "business_registration_number"));
        }
        merchants.setStatus(tenant, merchantId, null2(Json.str(merchants.require(tenant, merchantId), "status")), true);
        audit.record(tenant, principal.subjectType(), principal.userId(), "verification_submit", "merchant",
                merchantId, merchantId, null,
                Json.map("ownership_verified", true, "mode", "self_attested",
                        "documents", body.get("documents") == null ? List.of() : List.of("provided")),
                Json.map("contact_phone_provided", contactPhone != null), null, null);
        return Json.map("merchant_id", merchantId.toString(), "ownership_verified", true,
                "mode", "self_attested",
                "notice", "Verification in this build is self-attested and recorded as such; it is not a human "
                        + "business-registry check.");
    }

    /** Publish workflow with guard rules; returns the resulting state instead of failing silently. */
    @Transactional
    public Map<String, Object> publish(TenantContext tenant, UUID merchantId, Principal principal) {
        Map<String, Object> row = merchants.require(tenant, merchantId);
        String from = Json.str(row, "status");
        if ("suspended".equals(from)) {
            throw ApiException.forbidden("A suspended listing cannot be published by its owner",
                    Json.map("status", from, "route", "admin console"));
        }
        List<String> guards = guards(tenant, row);
        String to = guards.isEmpty() ? "published" : "pending_review";
        if ("draft".equals(from) || "pending_review".equals(from)) {
            merchants.setStatus(tenant, merchantId, to, Boolean.TRUE.equals(Json.bool(row, "ownership_verified")));
        }
        audit.record(tenant, principal.subjectType(), principal.userId(), "publish_listing", "merchant", merchantId,
                merchantId, Json.map("status", from), Json.map("status", to, "failed_guards", guards),
                Json.map(), null, null);
        return Json.map("merchant_id", merchantId.toString(),
                "workflow", Json.map("from", from, "to", to, "failed_guards", guards,
                        "blocked_by", guards.isEmpty() ? List.of() : guards),
                "merchant", MerchantRepository.view(merchants.require(tenant, merchantId)));
    }

    /** Guard rules for public visibility. Each entry names the API step that clears it. */
    public List<String> guards(TenantContext tenant, Map<String, Object> row) {
        UUID id = Json.uuid(row, "id");
        List<String> failed = new ArrayList<>();
        if (isBlank(Json.str(row, "description"))) {
            failed.add("description");
        }
        if (isBlank(Json.str(row, "category_primary"))) {
            failed.add("category_primary");
        }
        if (!Boolean.TRUE.equals(Json.bool(row, "ownership_verified"))) {
            failed.add("ownership_verified");
        }
        if (merchants.locations(tenant, id).isEmpty()) {
            failed.add("location");
        }
        if (merchants.businessHours(tenant, id).isEmpty()) {
            failed.add("business_hours");
        }
        if (offerings.countActive(tenant, id) == 0) {
            failed.add("active_offering");
        }
        return failed;
    }

    public Map<String, Object> addLocation(TenantContext tenant, UUID merchantId, Map<String, Object> location) {
        merchants.require(tenant, merchantId);
        UUID id = merchants.insertLocation(tenant, merchantId, location);
        recordAddressFact(tenant, merchantId, id, location);
        Map<String, Object> created = merchants.locations(tenant, merchantId).stream()
                .filter(l -> id.equals(Json.uuid(l, "id"))).findFirst()
                .orElseThrow(() -> ApiException.internal("Location vanished after insert", null));
        return MerchantRepository.locationView(created);
    }

    public Map<String, Object> addHours(TenantContext tenant, UUID merchantId, Map<String, Object> body) {
        Map<String, Object> row = merchants.require(tenant, merchantId);
        Integer weekday = asInt(body.get("weekday"));
        String opens = str(body.get("opens_at"));
        String closes = str(body.get("closes_at"));
        if (weekday == null || weekday < 0 || weekday > 6) {
            throw ApiException.validation("weekday must be 0 (Mon) .. 6 (Sun)", Json.map("field", "weekday"));
        }
        if (opens == null || closes == null || !opens.matches("\\d{2}:\\d{2}(:\\d{2})?")
                || !closes.matches("\\d{2}:\\d{2}(:\\d{2})?")) {
            throw ApiException.validation("opens_at and closes_at must be HH:MM",
                    Json.map("fields", List.of("opens_at", "closes_at")));
        }
        boolean crosses = opens.compareTo(closes) > 0;
        UUID locationId = Json.uuidOrNull(str(body.get("location_id")));
        if (locationId == null) {
            locationId = merchants.locations(tenant, merchantId).stream().findFirst()
                    .map(l -> Json.uuid(l, "id")).orElse(null);
        }
        if (locationId == null) {
            throw ApiException.validation("Add a location before opening hours", Json.map("field", "location_id"));
        }
        merchants.upsertBusinessHours(tenant, merchantId, locationId, weekday, opens, closes, crosses);
        List<Map<String, Object>> rows = merchants.businessHours(tenant, merchantId);
        // D25: the mirror is the merchant's whole week, not the interval just edited — a card's `open`
        // cites this fact, so a one-row value would cite something narrower than the claim it supports.
        facts.record(tenant, "merchant", merchantId, merchantId, "opening_hours",
                Json.map("zones", rows.stream()
                        .map(h -> Json.map("weekday", Json.integer(h, "weekday"),
                                "opens", Json.time(h, "opens_at"), "closes", Json.time(h, "closes_at")))
                        .toList(),
                        "closed_weekday", null),
                null, null, "merchant", 1.0, FactRepository.HOURS_TTL);
        return Json.map("merchant_id", merchantId.toString(),
                "hours", rows.stream()
                        .map(h -> Json.map("weekday", Json.integer(h, "weekday"),
                                "opens_at", Json.time(h, "opens_at"), "closes_at", Json.time(h, "closes_at"),
                                "crosses_midnight", Json.bool(h, "crosses_midnight"),
                                "location_id", Json.str(h, "location_id")))
                        .toList(),
                "status", Json.str(row, "status"));
    }

    // ---- facts (trust layer) -------------------------------------------

    void recordProfileFacts(TenantContext tenant, UUID merchantId, Map<String, Object> fields) {
        if (fields.get("avg_price_hkd") != null) {
            facts.record(tenant, "merchant", merchantId, merchantId, "avg_price",
                    Json.map("amount", String.valueOf(fields.get("avg_price_hkd")), "currency", "HKD"),
                    null, "HKD", "merchant", 1.0, FactRepository.PRICE_TTL);
        }
        if (fields.get("description") != null) {
            facts.record(tenant, "merchant", merchantId, merchantId, "description",
                    Json.map("text", String.valueOf(fields.get("description"))), null, null, "merchant", 1.0,
                    FactRepository.DESCRIPTION_TTL);
        }
    }

    private void recordAddressFact(TenantContext tenant, UUID merchantId, UUID locationId,
                                   Map<String, Object> location) {
        facts.record(tenant, "location", locationId, merchantId, "address",
                Json.map("address_line1", location.get("address_line1"), "district", location.get("district"),
                        "lat", location.get("lat"), "lng", location.get("lng")),
                null, null, "merchant", 1.0, FactRepository.HOURS_TTL);
    }

    // ---- misc -----------------------------------------------------------

    public static String slugify(String raw) {
        if (raw == null) {
            return null;
        }
        String slug = raw.toLowerCase()
                .replaceAll("[^a-z0-9\\u4e00-\\u9fff]+", "-")
                .replaceAll("^-+|-+$", "");
        if (slug.isBlank()) {
            return null;
        }
        return slug.length() > 64 ? slug.substring(0, 64) : slug;
    }

    private static Map<String, Object> slim(Map<String, Object> row) {
        return Json.map("status", Json.str(row, "status"), "name", Json.str(row, "display_name"),
                "ownership_verified", Json.bool(row, "ownership_verified"));
    }

    private static boolean isBlank(String v) {
        return v == null || v.isBlank();
    }

    private static String null2(String v) {
        return v == null ? "draft" : v;
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static Integer asInt(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Number n) {
            return n.intValue();
        }
        try {
            return Integer.valueOf(String.valueOf(v));
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
