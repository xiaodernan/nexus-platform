package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The §27 marketing surface: a campaign or a coupon may be <em>drafted</em> by anyone holding
 * {@code create_draft_campaign} — including the merchant's own AI agent, which is granted that
 * permission and deliberately not {@code publish_campaign} (AGENT_CONTRACT §8) — and may only be
 * published by a human holding {@code publish_campaign}, on its own route, on its own call.
 *
 * <p>That separation is the whole design. The two failure modes it prevents are both silent: an agent
 * that can publish can put a price in front of consumers with no human in the loop, and a route that
 * both drafts and publishes makes "who approved this offer" unanswerable after the fact. So the draft
 * routes ignore a caller-supplied {@code status} (refusing it rather than rewriting it), and
 * {@code approve-publish} is the only statement in the platform that can move a campaign out of
 * {@code draft} — it stamps {@code approved_by}/{@code approved_at} and writes an audit row.
 */
@RestController
@RequestMapping("/api/v1/merchant")
public class MerchantCampaignController {

    private static final List<String> COUPON_KINDS = List.of("percent", "fixed", "free_item");
    /** Who the platform will name as the author of a draft. A caller may claim neither. */
    private static final List<String> GENERATORS = List.of("ai_marketing_agent", "human", "merchant");
    private static final int MAX_CHANNELS = 8;
    private static final int MAX_COUPONS_PER_CAMPAIGN = 20;

    private final MerchantCampaignRepository campaigns;
    private final AuditService audit;
    private final TransactionTemplate tx;

    public MerchantCampaignController(MerchantCampaignRepository campaigns, AuditService audit,
                                      PlatformTransactionManager transactionManager) {
        this.campaigns = campaigns;
        this.audit = audit;
        this.tx = new TransactionTemplate(transactionManager);
    }

    /**
     * {@code POST /api/v1/merchant/campaigns} — creates a draft. The response says {@code
     * status: "draft"} because the row does, and the row does because this route writes the literal:
     * a request carrying {@code status: "live"} is refused with 422 rather than quietly ignored, so a
     * caller cannot believe it published something it did not.
     */
    @PostMapping("/campaigns")
    @RequiresPermission(value = MerchantPermissions.CREATE_DRAFT_CAMPAIGN, merchant = "body:merchant_id")
    public ResponseEntity<Map<String, Object>> createCampaign(@RequestBody Map<String, Object> body,
                                                              HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Principal principal = Req.principal(request);
        UUID merchantId = requireUuid(body.get("merchant_id"), "merchant_id");
        rejectStatusField(body);

        String title = requireText(body.get("title"), "title", 200);
        String goal = optionalText(body.get("goal"), 500);
        List<String> channel = channelList(body.get("channel"));
        List<String> couponIds = couponIdList(body.get("coupon_ids"));
        Instant startsAt = optionalInstant(body.get("starts_at"), "starts_at");
        Instant endsAt = optionalInstant(body.get("ends_at"), "ends_at");
        if (startsAt != null && endsAt != null && !endsAt.isAfter(startsAt)) {
            throw ApiException.validation("ends_at must be after starts_at", Json.map("field", "ends_at"));
        }
        Map<String, Object> audience = objectOrEmpty(body.get("audience"), "audience");
        Map<String, Object> creative = objectOrEmpty(body.get("creative"), "creative");

        // A coupon id that does not belong to this merchant would let a campaign advertise a stranger's
        // offer. Resolved here, before the write, so the failure is a 422 naming the field.
        for (String id : couponIds) {
            campaigns.couponMerchant(tenant, UUID.fromString(id), merchantId);
        }

        Map<String, Object> row = campaigns.insertCampaign(tenant, merchantId, Json.map(
                "title", title,
                "goal", goal,
                "channel", channel,
                "audience", audience,
                "creative", creative,
                "coupon_ids", couponIds,
                "generated_by", generator(body.get("generated_by"), principal),
                "starts_at", startsAt == null ? null : startsAt.toString(),
                "ends_at", endsAt == null ? null : endsAt.toString()));
        UUID campaignId = Json.uuid(row, "id");
        audit.record(request, "create_draft_campaign", "campaign", campaignId, merchantId, null,
                Json.map("status", Json.str(row, "status"), "title", title, "coupons", couponIds.size()),
                Json.map("generated_by", Json.str(row, "generated_by")));
        return ResponseEntity.status(HttpStatus.CREATED).body(Json.map(
                "campaign", view(row),
                "status", Json.str(row, "status"),
                "published", false,
                "note", "A draft is not visible to consumers until a human publishes it (§27)."));
    }

    /**
     * {@code POST /api/v1/merchant/campaigns/{id}/approve-publish} — the human authorisation §27
     * requires, and the only route that can move a campaign out of {@code draft}.
     *
     * <p>Idempotent: a second call reports {@code changed:false} and the same status instead of
     * re-stamping {@code approved_at}, so a double-click cannot rewrite when the decision was made.
     * A campaign whose {@code starts_at} is still in the future becomes {@code scheduled} rather than
     * {@code live} — approved to run is not the same claim as running.
     */
    @PostMapping("/campaigns/{id}/approve-publish")
    @RequiresPermission(value = MerchantPermissions.PUBLISH_CAMPAIGN, merchant = "campaign:id")
    public Map<String, Object> approvePublish(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Principal principal = Req.principal(request);
        UUID campaignId = uuid(id, "id");
        Instant now = Instant.now();

        Map<String, Object> before = campaigns.campaign(tenant, campaignId);
        String previous = Json.str(before, "status");
        boolean alreadyPublished = "live".equals(previous) || "scheduled".equals(previous);

        if (alreadyPublished) {
            return Json.map(
                    "campaign", view(before),
                    "changed", false,
                    "previous_status", previous,
                    "coupons_published", 0,
                    "note", "Already approved; the decision and its timestamp were left untouched.");
        }

        Instant startsAt = instantOrNull(Json.ts(before, "starts_at"));
        String next = startsAt != null && startsAt.isAfter(now) ? "scheduled" : "live";
        int draftCoupons = campaigns.countDraftCoupons(tenant, campaignId);

        // One transaction: a live campaign whose own coupon is still a draft would be advertising an
        // offer the coupon table says is not active.
        Map<String, Object> out = tx.execute(status -> {
            Map<String, Object> row = campaigns.approve(tenant, campaignId, principal.userId(), now, next);
            int published = campaigns.publishCouponsOf(tenant, campaignId, principal.userId(), now);
            audit.record(request, "publish_campaign", "campaign", campaignId, Json.uuid(row, "merchant_id"),
                    Json.map("status", previous),
                    Json.map("status", next, "coupons_published", published),
                    Json.map("draft_coupons_before", draftCoupons, "approved_by", principal.userId()));
            return Json.map("campaign", view(row), "changed", true, "previous_status", previous,
                    "coupons_published", published, "draft_coupons_before", draftCoupons);
        });
        return out == null ? Map.of() : out;
    }

    /**
     * {@code POST /api/v1/merchant/coupons} — a draft coupon. {@code code} is unique per tenant; the
     * driver's constraint violation is translated to a 409 here rather than surfacing as a 500,
     * because "this code is taken" is a decision the caller can act on.
     */
    @PostMapping("/coupons")
    @RequiresPermission(value = MerchantPermissions.CREATE_DRAFT_CAMPAIGN, merchant = "body:merchant_id")
    public ResponseEntity<Map<String, Object>> createCoupon(@RequestBody Map<String, Object> body,
                                                            HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Principal principal = Req.principal(request);
        UUID merchantId = requireUuid(body.get("merchant_id"), "merchant_id");
        rejectStatusField(body);

        String code = requireText(body.get("code"), "code", 64).trim().toUpperCase(Locale.ROOT);
        if (!code.matches("[A-Z0-9_-]{3,64}")) {
            throw ApiException.validation("code must be 3-64 characters of A-Z, 0-9, _ or -",
                    Json.map("field", "code"));
        }
        String kind = enumValue(body.get("kind"), COUPON_KINDS, "kind", "percent");
        BigDecimal value = requirePositive(body.get("value"), "value");
        BigDecimal minSpend = optionalNonNegative(body.get("min_spend"), "min_spend");
        Integer maxUses = optionalPositiveInt(body.get("max_uses"), "max_uses");
        Map<String, Object> appliesTo = objectOrEmpty(body.get("applies_to"), "applies_to");
        Instant startsAt = requireInstant(body.get("starts_at"), "starts_at");
        Instant endsAt = requireInstant(body.get("ends_at"), "ends_at");
        if (!endsAt.isAfter(startsAt)) {
            throw ApiException.validation("ends_at must be after starts_at", Json.map("field", "ends_at"));
        }
        if ("percent".equals(kind) && value.compareTo(BigDecimal.valueOf(100)) > 0) {
            throw ApiException.validation("a percent coupon cannot exceed 100", Json.map("field", "value"));
        }

        Map<String, Object> row;
        try {
            row = campaigns.insertCoupon(tenant, merchantId, Json.map(
                    "code", code, "kind", kind, "value", value, "min_spend", minSpend, "max_uses", maxUses,
                    "applies_to", appliesTo, "starts_at", startsAt.toString(), "ends_at", endsAt.toString(),
                    "created_by", principal.userId()));
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("coupon_code_taken", "Coupon code '" + code + "' already exists",
                    Json.map("code", code));
        }
        UUID couponId = Json.uuid(row, "id");
        audit.record(request, "create_draft_campaign", "coupon", couponId, merchantId, null,
                Json.map("status", Json.str(row, "status"), "code", code, "kind", kind), null);
        return ResponseEntity.status(HttpStatus.CREATED).body(Json.map(
                "coupon", couponView(row),
                "status", Json.str(row, "status"),
                "published", false,
                "note", "Drafts become active only when a human publishes the campaign that carries them."));
    }

    // ==================================================================== projection

    private static Map<String, Object> view(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("campaign_id", Json.uuid(row, "id"));
        out.put("merchant_id", Json.uuid(row, "merchant_id"));
        out.put("title", Json.str(row, "title"));
        out.put("goal", Json.str(row, "goal"));
        out.put("channel", Json.textArray(row, "channel"));
        out.put("audience", Json.jsonObject(row, "audience"));
        out.put("creative", Json.jsonObject(row, "creative"));
        out.put("coupon_ids", uuidArray(row, "coupon_ids"));
        out.put("status", Json.str(row, "status"));
        out.put("generated_by", Json.str(row, "generated_by"));
        out.put("metrics", Json.jsonObject(row, "metrics"));
        out.put("approved_by", Json.uuid(row, "approved_by"));
        out.put("approved_at", Json.ts(row, "approved_at"));
        out.put("starts_at", Json.ts(row, "starts_at"));
        out.put("ends_at", Json.ts(row, "ends_at"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        return out;
    }

    private static Map<String, Object> couponView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("coupon_id", Json.uuid(row, "id"));
        out.put("merchant_id", Json.uuid(row, "merchant_id"));
        out.put("code", Json.str(row, "code"));
        out.put("kind", Json.str(row, "kind"));
        out.put("value", Json.dec(row, "value"));
        out.put("min_spend", Json.dec(row, "min_spend"));
        out.put("max_uses", Json.integer(row, "max_uses"));
        out.put("used_count", Json.integer(row, "used_count"));
        out.put("applies_to", Json.jsonObject(row, "applies_to"));
        out.put("starts_at", Json.ts(row, "starts_at"));
        out.put("ends_at", Json.ts(row, "ends_at"));
        out.put("status", Json.str(row, "status"));
        out.put("published_at", Json.ts(row, "published_at"));
        out.put("created_at", Json.ts(row, "created_at"));
        return out;
    }

    private static List<String> uuidArray(Map<String, Object> row, String column) {
        Object raw = row.get(column);
        List<String> out = new ArrayList<>();
        if (raw instanceof java.sql.Array array) {
            try {
                for (Object element : (Object[]) array.getArray()) {
                    if (element != null) {
                        out.add(String.valueOf(element));
                    }
                }
            } catch (java.sql.SQLException e) {
                throw ApiException.internal("Could not read array column '" + column + "'", e);
            }
        }
        return out;
    }

    // ==================================================================== validation

    private static void rejectStatusField(Map<String, Object> body) {
        Object status = body.get("status");
        if (status != null && !"draft".equals(String.valueOf(status))) {
            throw ApiException.validation(
                    "This route only creates drafts; publish through POST /campaigns/{id}/approve-publish (§27)",
                    Json.map("field", "status", "received", String.valueOf(status)));
        }
    }

    private static String generator(Object raw, Principal principal) {
        if (raw == null) {
            return "human";
        }
        String value = String.valueOf(raw).trim();
        if (!GENERATORS.contains(value)) {
            throw ApiException.validation("generated_by must be one of " + GENERATORS, Json.map("field",
                    "generated_by"));
        }
        if ("human".equals(value) && principal == null) {
            throw ApiException.unauthorized("unauthorized", "A human-authored draft needs an acting user");
        }
        return value;
    }

    private static List<String> channelList(Object raw) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw ApiException.validation("channel must be an array", Json.map("field", "channel"));
        }
        List<String> out = new ArrayList<>();
        for (Object item : list) {
            String value = String.valueOf(item).trim().toLowerCase(Locale.ROOT);
            if (!List.of("push", "email", "whatsapp", "landing", "social").contains(value)) {
                throw ApiException.validation("unknown channel '" + value + "'", Json.map("field", "channel"));
            }
            out.add(value);
        }
        if (out.size() > MAX_CHANNELS) {
            throw ApiException.validation("at most " + MAX_CHANNELS + " channels", Json.map("field", "channel"));
        }
        return out;
    }

    private static List<String> couponIdList(Object raw) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw ApiException.validation("coupon_ids must be an array of uuids", Json.map("field", "coupon_ids"));
        }
        if (list.size() > MAX_COUPONS_PER_CAMPAIGN) {
            throw ApiException.validation("at most " + MAX_COUPONS_PER_CAMPAIGN + " coupons",
                    Json.map("field", "coupon_ids"));
        }
        List<String> out = new ArrayList<>();
        for (Object item : list) {
            UUID parsed = Json.uuidOrNull(item == null ? null : String.valueOf(item));
            if (parsed == null) {
                throw ApiException.validation("coupon_ids must be an array of uuids",
                        Json.map("field", "coupon_ids"));
            }
            out.add(parsed.toString());
        }
        return out;
    }

    private static Map<String, Object> objectOrEmpty(Object raw, String field) {
        if (raw == null) {
            return Map.of();
        }
        if (!(raw instanceof Map<?, ?> map)) {
            throw ApiException.validation(field + " must be an object", Json.map("field", field));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        map.forEach((k, v) -> out.put(String.valueOf(k), v));
        return out;
    }

    private static String enumValue(Object raw, List<String> allowed, String field, String fallback) {
        if (raw == null) {
            return fallback;
        }
        String value = String.valueOf(raw).trim().toLowerCase(Locale.ROOT);
        if (!allowed.contains(value)) {
            throw ApiException.validation(field + " must be one of " + allowed, Json.map("field", field));
        }
        return value;
    }

    private static String requireText(Object raw, String field, int max) {
        String value = raw == null ? null : String.valueOf(raw).trim();
        if (value == null || value.isEmpty()) {
            throw ApiException.validation(field + " is required", Json.map("field", field));
        }
        if (value.length() > max) {
            throw ApiException.validation(field + " must be at most " + max + " characters",
                    Json.map("field", field));
        }
        return value;
    }

    private static String optionalText(Object raw, int max) {
        if (raw == null) {
            return null;
        }
        String value = String.valueOf(raw).trim();
        if (value.isEmpty()) {
            return null;
        }
        if (value.length() > max) {
            throw ApiException.validation("value must be at most " + max + " characters", null);
        }
        return value;
    }

    private static BigDecimal requirePositive(Object raw, String field) {
        BigDecimal value = decimal(raw, field);
        if (value == null || value.signum() <= 0) {
            throw ApiException.validation(field + " must be a positive number", Json.map("field", field));
        }
        return value;
    }

    private static BigDecimal optionalNonNegative(Object raw, String field) {
        BigDecimal value = decimal(raw, field);
        if (value != null && value.signum() < 0) {
            throw ApiException.validation(field + " cannot be negative", Json.map("field", field));
        }
        return value;
    }

    private static BigDecimal decimal(Object raw, String field) {
        if (raw == null || String.valueOf(raw).isBlank()) {
            return null;
        }
        try {
            return new BigDecimal(String.valueOf(raw));
        } catch (NumberFormatException e) {
            throw ApiException.validation(field + " must be a number", Json.map("field", field));
        }
    }

    private static Integer optionalPositiveInt(Object raw, String field) {
        if (raw == null || String.valueOf(raw).isBlank()) {
            return null;
        }
        try {
            int value = Integer.parseInt(String.valueOf(raw));
            if (value <= 0) {
                throw ApiException.validation(field + " must be positive", Json.map("field", field));
            }
            return value;
        } catch (NumberFormatException e) {
            throw ApiException.validation(field + " must be an integer", Json.map("field", field));
        }
    }

    private static UUID requireUuid(Object raw, String field) {
        UUID parsed = Json.uuidOrNull(raw == null ? null : String.valueOf(raw));
        if (parsed == null) {
            throw ApiException.validation(field + " must be a uuid", Json.map("field", field));
        }
        return parsed;
    }

    private static UUID uuid(String raw, String field) {
        return requireUuid(raw, field);
    }

    private static Instant requireInstant(Object raw, String field) {
        Instant parsed = optionalInstant(raw, field);
        if (parsed == null) {
            throw ApiException.validation(field + " is required (ISO-8601)", Json.map("field", field));
        }
        return parsed;
    }

    private static Instant optionalInstant(Object raw, String field) {
        if (raw == null || String.valueOf(raw).isBlank()) {
            return null;
        }
        try {
            return Instant.parse(String.valueOf(raw));
        } catch (java.time.format.DateTimeParseException e) {
            throw ApiException.validation(field + " must be an ISO-8601 instant", Json.map("field", field));
        }
    }

    private static Instant instantOrNull(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(raw);
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }
}
