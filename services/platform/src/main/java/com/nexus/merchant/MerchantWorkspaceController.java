package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Json;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The workspace doors of API_CONTRACT §5: who is in a business, what keys it has issued, and whether its AI
 * agent is on. Every route here is declared against {@code permission_grants} — {@code admin_members} for
 * people and keys, {@code configure_ai} for the switch — because "is this person a member" is not an
 * authorisation question this codebase asks of the membership table (D5).
 *
 * <p>These are the highest-consequence reads and writes a merchant has: adding a member is handing somebody
 * the ability to read orders and publish listings, and creating an API key is handing them a secret that
 * outlives the session that made it. So each one is audited with its before-state and its resulting grant
 * list, and the key's plaintext appears exactly once, in the response that created it.
 */
@RestController
@RequestMapping("/api/v1/merchant")
public class MerchantWorkspaceController {

    private final MerchantWorkspaceService workspace;
    private final ApiKeyService apiKeys;
    private final AuditService audit;
    private final IdempotencyService idempotency;

    public MerchantWorkspaceController(MerchantWorkspaceService workspace, ApiKeyService apiKeys,
                                       AuditService audit, IdempotencyService idempotency) {
        this.workspace = workspace;
        this.apiKeys = apiKeys;
        this.audit = audit;
        this.idempotency = idempotency;
    }

    // ---- members ---------------------------------------------------------

    @GetMapping("/members")
    @RequiresPermission(value = "admin_members", merchant = "param:merchant_id")
    public Map<String, Object> members(@RequestParam(required = false) String merchant_id,
                                       HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = merchantUuid(merchant_id);
        List<Map<String, Object>> roster = workspace.roster(tenant, merchantId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("members", roster);
        out.put("count", roster.size());
        out.put("roles", roleDefinitions());
        out.put("definition", Json.map(
                "permissions", "the subject's live rows in permission_grants for this merchant — what the "
                        + "interceptor checks, and the only thing it checks",
                "role", "the preset that those grants were derived from; stored on the membership row, never "
                        + "consulted for authorisation",
                "status", "active members hold their role's grants; a disabled member holds none"));
        out.put("note", "A membership row and its grants are written together, so nothing here can show a "
                + "person as removed while they can still sign in.");
        return out;
    }

    @PostMapping("/members")
    @RequiresPermission(value = "admin_members", merchant = "body:merchant_id")
    @com.nexus.platform.Idempotent(scope = "member")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> addMember(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID operatorId = Req.userId(request);
        UUID merchantId = merchantUuid(str(body, "merchant_id"));
        UUID userId = uuidOr422(str(body, "user_id"), "user_id");
        String role = requireRole(str(body, "role"));
        // Inside the work block, not after it: a replay returns the stored response without running this body,
        // so the audit trail cannot grow a second "member added" row for one act (§127).
        Map<String, Object> result = idempotency.run("member", request.getHeader("Idempotency-Key"), operatorId,
                () -> {
                    Map<String, Object> added = workspace.addMember(tenant, operatorId, merchantId, userId, role);
                    audit.record(request, "add_workspace_member", "merchant_user",
                            Json.uuid(added, "member_id"), merchantId, Json.map(), Json.map(
                                    "user_id", userId.toString(), "role", role,
                                    "permissions", added.get("permissions")),
                            Json.map("path", request.getRequestURI()));
                    return added;
                });
        return withBasis(result, merchantId);
    }

    @PatchMapping("/members/{id}")
    @RequiresPermission(value = "admin_members", merchant = "member:id")
    public Map<String, Object> patchMember(@PathVariable String id, @RequestBody Map<String, Object> body,
                                           HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID operatorId = Req.userId(request);
        UUID memberId = uuidOr422(id, "id");
        String role = body.containsKey("role") ? requireRole(str(body, "role")) : null;
        String status = body.containsKey("status") ? requireStatus(str(body, "status")) : null;
        if (role == null && status == null) {
            throw ApiException.validation("Send at least one of 'role' or 'status'",
                    Json.map("allowed_fields", List.of("role", "status")));
        }
        Map<String, Object> result = workspace.updateMember(tenant, operatorId, memberId, role, status);
        UUID merchantId = Json.uuid(result, "merchant_id");
        audit.record(request, "update_workspace_member", "merchant_user", memberId, merchantId,
                mapOrEmpty(result.get("before")), Json.map(
                        "role", result.get("role"), "status", result.get("status"),
                        "permissions", result.get("permissions")),
                Json.map("grants_added", result.get("grants_added"),
                        "grants_removed", result.get("grants_removed")));
        return withBasis(result, merchantId);
    }

    @DeleteMapping("/members/{id}")
    @RequiresPermission(value = "admin_members", merchant = "member:id")
    public Map<String, Object> removeMember(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID operatorId = Req.userId(request);
        UUID memberId = uuidOr422(id, "id");
        Map<String, Object> result = workspace.removeMember(tenant, operatorId, memberId);
        UUID merchantId = Json.uuid(result, "merchant_id");
        audit.record(request, "remove_workspace_member", "merchant_user", memberId, merchantId,
                mapOrEmpty(result.get("before")), Json.map(
                        "removed", true, "grants_revoked", result.get("grants_revoked")), Json.map());
        Map<String, Object> out = new LinkedHashMap<>(result);
        out.put("note", "The membership row and every grant it carried are gone. A person who also holds "
                + "another business in this tenant can still sign in there.");
        if (Json.uuid(result, "user_id").equals(operatorId)) {
            out.put("self_removed", true);
            out.put("self_removed_note", "You removed your own access; this is the last response you can "
                    + "get from this workspace.");
        }
        return out;
    }

    // ---- api keys --------------------------------------------------------

    @GetMapping("/api-keys")
    @RequiresPermission(value = "admin_members", merchant = "param:merchant_id")
    public Map<String, Object> keys(@RequestParam(required = false) String merchant_id,
                                    HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = merchantUuid(merchant_id);
        List<Map<String, Object>> rows = apiKeys.list(tenant, merchantId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("api_keys", rows);
        out.put("count", rows.size());
        out.put("allowed_scopes", MerchantPermissions.API_KEY_SCOPES);
        out.put("note", "Only the SHA-256 of a secret is stored, so a key that was not copied when it was "
                + "created cannot be shown again — revoke it and issue another.");
        return out;
    }

    @PostMapping("/api-keys")
    @RequiresPermission(value = "admin_members", merchant = "body:merchant_id")
    @com.nexus.platform.Idempotent(scope = "api_key")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> createKey(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID operatorId = Req.userId(request);
        UUID merchantId = merchantUuid(str(body, "merchant_id"));
        String name = requireName(str(body, "name"));
        List<String> scopes = requireScopes(body.get("scopes"));
        Map<String, Object> result = idempotency.run("api_key", request.getHeader("Idempotency-Key"), operatorId,
                () -> apiKeys.create(tenant, merchantId, name, scopes, operatorId));
        // No audit here on purpose: ApiKeyService.create already writes `create_api_key` with the name, the
        // prefix and the scopes — and never the secret, which is the point of storing only a hash. A second
        // row for the same act would make the trail read as two keys issued.
        return result;
    }

    @DeleteMapping("/api-keys/{id}")
    @RequiresPermission(value = "admin_members", merchant = "apikey:id")
    public Map<String, Object> revokeKey(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID keyId = uuidOr422(id, "id");
        apiKeys.revoke(tenant, keyId, Req.userId(request));
        return Json.map("api_key_id", keyId.toString(), "revoked", true,
                "note", "The key stops authenticating on its next call, and the permission_grants rows that "
                        + "carried its scopes are deleted with it.");
    }

    // ---- ai agent --------------------------------------------------------

    @PostMapping("/ai-agent/config")
    @RequiresPermission(value = "configure_ai", merchant = "body:merchant_id")
    public Map<String, Object> aiAgent(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = merchantUuid(str(body, "merchant_id"));
        Object raw = body.get("enabled");
        if (!(raw instanceof Boolean enabled)) {
            throw ApiException.validation("'enabled' must be true or false",
                    Json.map("field", "enabled", "received", raw == null ? "missing" : raw));
        }
        Map<String, Object> result = workspace.setAiAgent(tenant, merchantId, enabled);
        audit.record(request, "configure_ai_agent", "merchant", merchantId, merchantId,
                mapOrEmpty(result.get("before")), Json.map("ai_agent_enabled", enabled),
                Json.map());
        Map<String, Object> out = new LinkedHashMap<>(result);
        out.put("scope_note", "ai_agent_enabled is the only AI setting this schema stores. Turning it on lets "
                + "the agent answer for this business; it does not change what the agent is allowed to do, "
                + "which stays a permission_grants question.");
        return out;
    }

    // ---- validation and small helpers ------------------------------------

    private static String str(Map<String, Object> body, String field) {
        Object value = body.get(field);
        return value == null ? null : String.valueOf(value);
    }

    private static UUID uuidOr422(String raw, String field) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation("Field '" + field + "' must be a uuid",
                    Json.map("field", field, "received", raw));
        }
        return parsed;
    }

    private UUID merchantUuid(String raw) {
        UUID merchantId = Json.uuidOrNull(raw);
        if (merchantId == null) {
            throw ApiException.validation("Field 'merchant_id' must be a uuid",
                    Json.map("field", "merchant_id", "received", raw));
        }
        return merchantId;
    }

    private static String requireRole(String raw) {
        String role = raw == null ? null : raw.trim();
        if (role == null || !MerchantPermissions.ROLES.contains(role)) {
            throw ApiException.validation("role must be one of " + MerchantPermissions.ROLES,
                    Json.map("field", "role", "allowed", MerchantPermissions.ROLES, "received", raw));
        }
        return role;
    }

    private static String requireStatus(String raw) {
        String status = raw == null ? null : raw.trim();
        if (status == null || !MerchantWorkspaceService.MEMBER_STATUSES.contains(status)) {
            throw ApiException.validation("status must be one of " + MerchantWorkspaceService.MEMBER_STATUSES,
                    Json.map("field", "status", "allowed", MerchantWorkspaceService.MEMBER_STATUSES,
                            "received", raw));
        }
        return status;
    }

    private static String requireName(String raw) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) {
            throw ApiException.validation("'name' is required — an unnamed key cannot be recognised when it "
                    + "has to be revoked", Json.map("field", "name"));
        }
        if (name.length() > 80) {
            throw ApiException.validation("'name' must be at most 80 characters",
                    Json.map("field", "name", "max_length", 80, "received", name.length()));
        }
        return name;
    }

    private static List<String> requireScopes(Object raw) {
        List<String> scopes;
        if (raw instanceof List<?> list) {
            scopes = list.stream().map(String::valueOf).toList();
        } else if (raw instanceof String s && !s.isBlank()) {
            scopes = List.of(s.split(","));
        } else {
            throw ApiException.validation("'scopes' must be a non-empty list of "
                    + MerchantPermissions.API_KEY_SCOPES, Json.map("field", "scopes",
                    "allowed", MerchantPermissions.API_KEY_SCOPES));
        }
        List<String> trimmed = scopes.stream().map(String::trim).filter(s -> !s.isBlank()).toList();
        if (trimmed.isEmpty()) {
            throw ApiException.validation("'scopes' must name at least one scope",
                    Json.map("field", "scopes", "allowed", MerchantPermissions.API_KEY_SCOPES));
        }
        return trimmed;
    }

    /** The role presets, spelled out from the same table the writes use, so the screen cannot invent one. */
    private static Map<String, Object> roleDefinitions() {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String role : MerchantPermissions.ROLES) {
            out.put(role, MerchantPermissions.defaultsForRole(role));
        }
        return out;
    }

    private Map<String, Object> withBasis(Map<String, Object> result, UUID merchantId) {
        Map<String, Object> out = new LinkedHashMap<>(result);
        out.put("merchant_id", merchantId.toString());
        out.put("authorisation_basis", "permission_grants (admin_members checked against the caller before "
                + "this write ran); roles only choose which grant rows exist");
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOrEmpty(Object value) {
        return value instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }
}
