package com.nexus.admin;

import com.nexus.identity.AuthService;
import com.nexus.identity.IdentityRepository;
import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPlatformRole;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §3 — {@code GET /api/v1/users/{id}}, the platform support read (§68).
 *
 * <p>This is the one user read that is neither self-service nor merchant-scoped, and §3 is explicit about
 * who may call it: <b>platform_admin / platform_ops only</b>. Merchant staff must never reach it — a
 * merchant's view of a customer goes through {@code /api/v1/merchant/customers}, which is RBAC-scoped to
 * the merchant and deliberately omits {@code user_id} (§46/§47). The guard is
 * {@link RequiresPlatformRole}, so a merchant-staff token is a 403 in the §1 envelope and an anonymous
 * caller a 401.
 *
 * <p>The core of the payload is {@link AuthService#userView}, the same projection {@code /me} and the
 * auth routes use, because a second description of the same person is how "the same user" starts meaning
 * two things (D24 §1). What this route adds is support context: the caller's memberships and their
 * activity counts, both tenant-scoped.
 */
@RestController
@RequestMapping("/api/v1/users")
public class AdminUsersController {

    private final IdentityRepository users;
    private final TenantJdbc jdbc;

    public AdminUsersController(IdentityRepository users, TenantJdbc jdbc) {
        this.users = users;
        this.jdbc = jdbc;
    }

    @GetMapping("/{id}")
    @RequiresPlatformRole
    public Map<String, Object> user(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Json.uuidOrNull(id);
        if (userId == null) {
            throw ApiException.validation("id must be a uuid", Json.map("field", "id", "received", id));
        }
        // IdentityRepository owns the user projection; a cross-tenant id is absent here (404), never a 403.
        Map<String, Object> row = users.findUser(tenant, userId)
                .orElseThrow(() -> ApiException.notFound("user_not_found", "No such user in this tenant"));

        List<Map<String, Object>> memberships = new ArrayList<>();
        for (Map<String, Object> m : jdbc.forTenant(tenant, """
                select mu.id, mu.role, mu.status, m.id as merchant_id, m.slug, m.display_name as merchant_name,
                       m.status as merchant_status
                from merchant_users mu
                join merchants m on m.id = mu.merchant_id
                where mu.user_id = :user_id and m.tenant_id = :tenant_id
                order by m.display_name asc, m.id asc
                """, Json.map("user_id", userId))) {
            memberships.add(Json.map(
                    "member_id", Json.str(m, "id"),
                    "role", Json.str(m, "role"),
                    "status", Json.str(m, "status"),
                    "merchant", Json.map(
                            "id", Json.str(m, "merchant_id"),
                            "slug", Json.str(m, "slug"),
                            "display_name", Json.str(m, "merchant_name"),
                            "status", Json.str(m, "merchant_status"))));
        }

        Map<String, Object> activity = jdbc.firstForTenant(tenant, """
                select
                  (select count(*) from orders o where o.user_id = :user_id and o.tenant_id = :tenant_id) as orders,
                  (select count(*) from reservations r
                    where r.user_id = :user_id and r.tenant_id = :tenant_id) as reservations
                """, Json.map("user_id", userId)).orElse(new LinkedHashMap<>());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("user", AuthService.userView(tenant, row));
        out.put("support", Json.map(
                "phone", Json.str(row, "phone"),
                "last_login_at", Json.ts(row, "last_login_at"),
                "memberships", memberships,
                "activity", Json.map(
                        "orders", Json.longOf(activity, "orders"),
                        "reservations", Json.longOf(activity, "reservations"))));
        out.put("as_of", Instant.now().toString());
        out.put("scope", "Platform support tooling (§68). platform_admin/platform_ops only. Merchant staff "
                + "must never reach this route; merchant-side customer data is RBAC-scoped through "
                + "/api/v1/merchant/customers (§46/§47).");
        return out;
    }
}
