package com.nexus.admin;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPlatformRole;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §9 — {@code POST /api/v1/admin/merchants/{id}/suspend}.
 *
 * <p>Suspension is the one admin write that must be visible to consumers the instant it lands: the
 * consumer reads in {@code com.nexus.catalog} serve {@code status = 'published'} merchants only, so
 * flipping the row to {@code 'suspended'} removes the shop's page and every listing under it without a
 * second write. That is the observable effect this route is responsible for, and it is stated in the
 * response rather than left for the operator to infer.
 *
 * <p>The write is one guarded statement ({@code where id = :id and tenant_id = :tenant_id}) so a
 * cross-tenant id is simply absent — a 404, never a 403 that would confirm the row exists elsewhere
 * (D5, no enumeration). The decision is recorded in {@code audit_logs} with the actor, the merchant, and
 * the before/after status; the audit call is not best-effort here in spirit, even though
 * {@link AuditService} is written not to fail the request.
 *
 * <p>Permission comes from {@link RequiresPlatformRole}: a consumer is a 403 in the §1 envelope, an
 * anonymous caller a 401. Merchant staff have no route here — a shop suspending itself is not a control.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminMerchantOpsController {

    private static final String SUSPENDED = "suspended";
    private static final int MAX_REASON = 500;

    public record SuspendBody(String reason) {
    }

    private final TenantJdbc jdbc;
    private final AuditService audit;

    public AdminMerchantOpsController(TenantJdbc jdbc, AuditService audit) {
        this.jdbc = jdbc;
        this.audit = audit;
    }

    @PostMapping("/merchants/{id}/suspend")
    @RequiresPlatformRole
    public Map<String, Object> suspend(@PathVariable String id,
                                       @RequestBody(required = false) SuspendBody body,
                                       HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = Json.uuidOrNull(id);
        if (merchantId == null) {
            throw ApiException.validation("id must be a uuid", Json.map("field", "id", "received", id));
        }
        String reason = body == null || body.reason() == null || body.reason().isBlank()
                ? null : body.reason().trim();
        if (reason != null && reason.length() > MAX_REASON) {
            throw ApiException.validation("reason must be at most " + MAX_REASON + " characters",
                    Json.map("field", "reason", "max_length", MAX_REASON, "received", reason.length()));
        }

        Map<String, Object> merchant = find(tenant, merchantId)
                .orElseThrow(() -> ApiException.notFound("merchant_not_found",
                        "No such merchant in this tenant"));
        String previous = Json.str(merchant, "status");
        String slug = Json.str(merchant, "slug");

        int updated = jdbc.updateForTenant(tenant, """
                update merchants m
                   set status = :status, updated_at = now()
                 where m.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", merchantId, "status", SUSPENDED));
        if (updated == 0) {
            // The row was there a statement ago; losing it now means another writer removed it, which is
            // a conflict, not a success we can report.
            throw ApiException.conflict("conflict",
                    "The merchant disappeared before it could be suspended",
                    Json.map("merchant_id", merchantId.toString()));
        }
        boolean changed = !SUSPENDED.equals(previous);

        audit.record(request, "merchant_suspend", "merchant", merchantId, merchantId,
                Json.map("status", previous), Json.map("status", SUSPENDED),
                Json.map("reason", reason == null ? "" : reason, "changed", changed,
                        "consumer_effect", "consumer reads serve published merchants only; the profile and "
                                + "its listings stop being served"));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("slug", slug);
        out.put("status", SUSPENDED);
        out.put("previous_status", previous);
        out.put("changed", changed);
        out.put("reason", reason);
        out.put("suspended_at", Instant.now().toString());
        out.put("consumer_effect", "The merchant is no longer published: GET /api/v1/merchants/" + slug
                + " answers 404 merchant_not_found and it is absent from the directory until it is "
                + "republished.");
        return out;
    }

    private Optional<Map<String, Object>> find(TenantContext tenant, UUID merchantId) {
        return jdbc.firstForTenant(tenant, """
                select m.id, m.slug, m.status, m.tenant_id
                from merchants m
                where m.id = :id and m.tenant_id = :tenant_id
                """, Json.map("id", merchantId));
    }
}
