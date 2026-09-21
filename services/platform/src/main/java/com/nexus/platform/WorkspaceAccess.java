package com.nexus.platform;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Resolves the merchant a workspace request acts on, always tenant-checked. Missing/foreign merchant
 * → 404 (D5: never 403, no enumeration).
 */
@Component
public class WorkspaceAccess {

    private final TenantJdbc jdbc;

    public WorkspaceAccess(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    public UUID resolveMerchantId(TenantContext tenant, HttpServletRequest request, HandlerMethod handler,
                                  String source) {
        if (source == null || source.isBlank()) {
            return null;
        }
        int colon = source.indexOf(':');
        String kind = colon < 0 ? source : source.substring(0, colon);
        String arg = colon < 0 ? "" : source.substring(colon + 1);
        switch (kind) {
            case "param":
            case "business":
                return merchantById(tenant, uuidParam(request, handler, arg));
            case "body":
                return merchantById(tenant, uuidFromBody(request, arg));
            case "offering":
                return childMerchant(tenant, "offerings", uuidParam(request, handler, arg), "offering_not_found");
            case "order":
                return childMerchant(tenant, "orders", uuidParam(request, handler, arg), "order_not_found");
            case "campaign":
                return childMerchant(tenant, "campaigns", uuidParam(request, handler, arg), "campaign_not_found");
            case "coupon":
                return childMerchant(tenant, "coupons", uuidParam(request, handler, arg), "coupon_not_found");
            case "conversation":
                return childMerchant(tenant, "conversations", uuidParam(request, handler, arg), "conversation_not_found");
            case "reservation":
                return childMerchant(tenant, "reservations", uuidParam(request, handler, arg),
                        "reservation_not_found");
            case "apikey":
                return childMerchant(tenant, "api_keys", uuidParam(request, handler, arg), "api_key_not_found");
            case "importjob":
                return childMerchant(tenant, "documents", uuidParam(request, handler, arg), "import_job_not_found");
            case "member":
                return memberMerchant(tenant, uuidParam(request, handler, arg));
            default:
                throw ApiException.internal("Unknown @RequiresPermission merchant source: " + source, null);
        }
    }

    /** Path variable wins over query parameter; both must parse as a uuid. */
    private static UUID uuidParam(HttpServletRequest request, HandlerMethod handler, String name) {
        Object pathVar = pathVars(request).get(name);
        String raw = pathVar != null ? String.valueOf(pathVar) : request.getParameter(name);
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation("Parameter '" + name + "' must be a uuid", Json.map("field", name));
        }
        return parsed;
    }

    private static Map<String, String> pathVars(HttpServletRequest request) {
        Map<String, String> out = new HashMap<>();
        Object attrs = request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        if (attrs instanceof Map<?, ?> m) {
            m.forEach((k, v) -> out.put(String.valueOf(k), String.valueOf(v)));
        }
        return out;
    }

    private UUID uuidFromBody(HttpServletRequest request, String field) {
        try {
            JsonNode node = Json.MAPPER.readTree(request.getInputStream());
            JsonNode value = node.path(field);
            UUID parsed = Json.uuidOrNull(value.isTextual() ? value.asText() : null);
            if (parsed == null) {
                throw ApiException.validation("Body field '" + field + "' must be a uuid", Json.map("field", field));
            }
            return parsed;
        } catch (IOException e) {
            throw ApiException.validation("Request body could not be read for authorisation", Json.map("field", field));
        }
    }

    private UUID merchantById(TenantContext tenant, UUID merchantId) {
        jdbc.oneForTenant(tenant, "select id from merchants where id = :id and tenant_id = :tenant_id",
                Json.map("id", merchantId), "merchant_not_found");
        return merchantId;
    }

    /** Child rows have no tenant_id of their own, so the predicate rides on the joined merchant. */
    private UUID childMerchant(TenantContext tenant, String table, UUID childId, String notFoundCode) {
        String sql = "select c.merchant_id as merchant_id from " + table + " c join merchants m on m.id = c.merchant_id "
                + "where c.id = :id and m.tenant_id = :tenant_id";
        Map<String, Object> row = jdbc.oneForTenant(tenant, sql, Json.map("id", childId), notFoundCode);
        Object merchant = row.get("merchant_id");
        if (merchant == null) {
            throw ApiException.notFound(notFoundCode, "Record has no merchant");
        }
        return UUID.fromString(String.valueOf(merchant));
    }

    private UUID memberMerchant(TenantContext tenant, UUID memberId) {
        Map<String, Object> row = jdbc.oneForTenant(tenant, """
                select mu.merchant_id as merchant_id
                from merchant_users mu join merchants m on m.id = mu.merchant_id
                where mu.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", memberId), "member_not_found");
        return UUID.fromString(String.valueOf(row.get("merchant_id")));
    }
}
