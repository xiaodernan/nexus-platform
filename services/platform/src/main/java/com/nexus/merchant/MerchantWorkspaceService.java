package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
import com.nexus.platform.TenantContext;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Membership and AI-switch operations for the merchant workspace (API_CONTRACT §5).
 *
 * <p>The rule that shapes every method here is D5: {@code permission_grants} is what authorises, and a role
 * string in {@code merchant_users} is only a convenient way of <em>choosing</em> a set of grant rows. So
 * assigning a role writes those rows, changing a role moves them, and disabling or removing a member deletes
 * them. A membership row that says {@code disabled} while its grants still answer authorisation checks would
 * be a screen lying about who can walk in — and because {@code permission_grants} has no foreign key to
 * {@code merchant_users}, nothing in the schema notices that; only these methods do.
 *
 * <p>Two writes happen together or not at all, hence {@code @Transactional} on each: the membership row and
 * its grants are one decision. The owner guard is checked against the row count in the same transaction, so
 * the last administrator of a business cannot be demoted, disabled or deleted into a workspace nobody can
 * administer.
 */
@Service
public class MerchantWorkspaceService {

    public static final List<String> MEMBER_STATUSES = List.of("active", "disabled");

    private final MerchantRepository merchants;
    private final PermissionService permissions;

    public MerchantWorkspaceService(MerchantRepository merchants, PermissionService permissions) {
        this.merchants = merchants;
        this.permissions = permissions;
    }

    /** The people who can administer this workspace, each with the permissions they actually hold. */
    public List<Map<String, Object>> roster(TenantContext tenant, UUID merchantId) {
        return merchants.members(tenant, merchantId).stream().map(r -> {
            UUID userId = Json.uuid(r, "user_id");
            Map<String, Object> out = new java.util.LinkedHashMap<>();
            out.put("member_id", Json.str(r, "id"));
            out.put("user_id", userId.toString());
            out.put("display_name", Json.str(r, "display_name"));
            out.put("email", Json.str(r, "email"));
            out.put("role", Json.str(r, "role"));
            out.put("status", Json.str(r, "status"));
            out.put("joined_at", Json.ts(r, "created_at"));
            out.put("permissions", permissions.grantedToHuman(tenant, userId, merchantId));
            return out;
        }).toList();
    }

    @Transactional
    public Map<String, Object> addMember(TenantContext tenant, UUID operatorId, UUID merchantId, UUID userId,
                                         String role) {
        if (!merchants.userInTenant(tenant, userId)) {
            // 404, not a membership row: an id from another tenant must not be answerable at all, and the
            // merchant_users table has no tenant column to catch the mistake behind us.
            throw ApiException.notFound("user_not_found", "No such user in this tenant: " + userId);
        }
        Map<String, Object> existing = merchants.membership(tenant, merchantId, userId).orElse(null);
        if (existing != null) {
            throw ApiException.conflict("member_exists",
                    "That person is already a member of this business; change their role instead",
                    Json.map("member_id", Json.str(existing, "id"), "role", Json.str(existing, "role")));
        }
        UUID memberId = merchants.addMember(tenant, merchantId, userId, role);
        List<String> effective = reconcileGrants(tenant, operatorId, merchantId, userId, role, "active");
        return Json.map("member_id", memberId.toString(), "merchant_id", merchantId.toString(),
                "user_id", userId.toString(), "role", role,
                "status", "active", "permissions", effective, "grants_added", effective,
                "grants_removed", List.of());
    }

    @Transactional
    public Map<String, Object> updateMember(TenantContext tenant, UUID operatorId, UUID memberId, String role,
                                            String status) {
        Map<String, Object> before = merchants.memberRow(tenant, memberId)
                .orElseThrow(() -> ApiException.notFound("member_not_found", "No such membership"));
        String nextRole = role == null ? Json.str(before, "role") : role;
        String nextStatus = status == null ? Json.str(before, "status") : status;
        UUID merchantId = Json.uuid(before, "merchant_id");
        UUID userId = Json.uuid(before, "user_id");

        boolean losesAdmin = isAdmin(Json.str(before, "role"), Json.str(before, "status"))
                && !isAdmin(nextRole, nextStatus);
        if (losesAdmin && merchants.activeAdmins(tenant, merchantId) <= 1) {
            throw ApiException.conflict("last_admin",
                    "This is the only active owner/admin of the business; moving it would leave nobody able to "
                            + "manage the workspace",
                    Json.map("member_id", memberId.toString(), "merchant_id", merchantId.toString()));
        }
        merchants.updateMember(tenant, memberId, role, status);

        List<String> current = permissions.grantedToHuman(tenant, userId, merchantId);
        List<String> effective = reconcileGrants(tenant, operatorId, merchantId, userId, nextRole, nextStatus);
        List<String> removed = new ArrayList<>(current);
        removed.removeAll(effective);
        List<String> added = new ArrayList<>(effective);
        added.removeAll(current);
        return Json.map("member_id", memberId.toString(), "merchant_id", merchantId.toString(),
                "user_id", userId.toString(),
                "role", nextRole, "status", nextStatus, "permissions", effective,
                "grants_added", added, "grants_removed", removed,
                "before", Json.map("role", Json.str(before, "role"), "status", Json.str(before, "status"),
                        "permissions", current));
    }

    @Transactional
    public Map<String, Object> removeMember(TenantContext tenant, UUID operatorId, UUID memberId) {
        Map<String, Object> before = merchants.memberRow(tenant, memberId)
                .orElseThrow(() -> ApiException.notFound("member_not_found", "No such membership"));
        UUID merchantId = Json.uuid(before, "merchant_id");
        UUID userId = Json.uuid(before, "user_id");
        if (isAdmin(Json.str(before, "role"), Json.str(before, "status"))
                && merchants.activeAdmins(tenant, merchantId) <= 1) {
            throw ApiException.conflict("last_admin",
                    "This is the only active owner/admin of the business; removing it would leave the workspace "
                            + "with nobody who can administer it",
                    Json.map("member_id", memberId.toString(), "merchant_id", merchantId.toString()));
        }
        List<String> current = permissions.grantedToHuman(tenant, userId, merchantId);
        int revoked = 0;
        for (String subjectType : PermissionService.HUMAN_SUBJECT_TYPES) {
            revoked += permissions.revokeAll(tenant, subjectType, userId, merchantId);
        }
        merchants.removeMember(tenant, memberId);
        return Json.map("member_id", memberId.toString(), "user_id", userId.toString(),
                "merchant_id", merchantId.toString(), "role_removed", Json.str(before, "role"),
                "grants_revoked", revoked, "was_able_to", current,
                "before", Json.map("role", Json.str(before, "role"), "status", Json.str(before, "status"),
                        "permissions", current));
    }

    /**
     * The merchant's AI-agent switch. {@code merchants.ai_agent_enabled} is the only AI setting this schema
     * carries, so this route sets that one column and says so — it does not accept a persona, a model or a
     * temperature that nowhere stores.
     */
    @Transactional
    public Map<String, Object> setAiAgent(TenantContext tenant, UUID merchantId, boolean enabled) {
        Map<String, Object> before = merchants.require(tenant, merchantId);
        int updated = merchants.setAiAgentEnabled(tenant, merchantId, enabled);
        if (updated == 0) {
            throw ApiException.notFound("merchant_not_found", "No such merchant in this tenant");
        }
        return Json.map("merchant_id", merchantId.toString(), "ai_agent_enabled", enabled,
                "slug", Json.str(before, "slug"),
                "before", Json.map("ai_agent_enabled", Json.bool(before, "ai_agent_enabled")));
    }

    // ---- grant reconciliation --------------------------------------------

    /**
     * Make the subject's grants in this merchant equal the role's default set, and return that set. An empty
     * set is what {@code disabled} means: the membership row stays for the audit trail, the access goes.
     *
     * <p>New rows are written under {@code 'user'} (the spelling the owner path uses, D31); a permission being
     * taken away is deleted under both spellings, so a row an earlier write filed as {@code merchant_user}
     * cannot outlive the role change that removed it.
     */
    private List<String> reconcileGrants(TenantContext tenant, UUID operatorId, UUID merchantId, UUID userId,
                                         String role, String status) {
        List<String> wanted = "active".equals(status) ? MerchantPermissions.defaultsForRole(role) : List.of();
        List<String> current = permissions.grantedToHuman(tenant, userId, merchantId);
        Set<String> wantedSet = new LinkedHashSet<>(wanted);
        for (String permission : wantedSet) {
            if (!current.contains(permission)) {
                permissions.grant(tenant, "user", userId, merchantId, permission, operatorId);
            }
        }
        for (String permission : current) {
            if (!wantedSet.contains(permission)) {
                for (String subjectType : PermissionService.HUMAN_SUBJECT_TYPES) {
                    permissions.revoke(tenant, subjectType, userId, merchantId, permission);
                }
            }
        }
        return List.copyOf(wantedSet);
    }

    /** Both role spellings that carry {@code admin_members} by default — see {@link MerchantPermissions#OWNER}. */
    private static boolean isAdmin(String role, String status) {
        return "active".equals(status) && ("owner".equals(role) || "admin".equals(role));
    }
}
