package com.nexus.platform;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * {@code permission_grants} is the single source of truth for authorisation (D5, AGENT_CONTRACT §8) —
 * for humans, merchant API keys and AI agents alike. Roles in {@code merchant_users} are a
 * convenience for *assigning* grants; nothing is authorised from a role string.
 */
@Service
public class PermissionService {

    /**
     * The two spellings a human being's grants are filed under. A membership can be recorded either way —
     * {@code 'user'} is what the owner-seed and D40's writes use, {@code 'merchant_user'} is what the seed
     * and older callers use — and authorisation accepts both, so any read that answers for a person has to
     * union them or it will report a different access depending on who wrote the row.
     */
    public static final List<String> HUMAN_SUBJECT_TYPES = List.of("user", "merchant_user");

    private final TenantJdbc jdbc;

    public PermissionService(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Everything this person holds at this merchant, under either spelling — the answer {@code /me} and
     * {@code GET /members} both give, so two doors cannot describe one subject's access differently.
     * Expired rows are excluded here as they are by every other read: a lapsed grant authorises nothing,
     * and listing it would advertise an access the caller has already lost.
     */
    public List<String> grantedToHuman(TenantContext tenant, UUID userId, UUID merchantId) {
        Set<String> all = new LinkedHashSet<>();
        for (String subjectType : HUMAN_SUBJECT_TYPES) {
            all.addAll(grantedPermissions(tenant, subjectType, userId, merchantId));
        }
        return List.copyOf(all);
    }

    /** Merchant-scoped grant: joined through {@code merchants} so another tenant's grant can never match. */
    public boolean hasMerchantGrant(TenantContext tenant, String subjectType, UUID subjectId,
                                     UUID merchantId, String permission) {
        String sql = """
                select g.id
                from permission_grants g
                join merchants m on m.id = g.merchant_id
                where g.subject_type = :subject_type
                  and g.subject_id = :subject_id
                  and g.permission = :permission
                  and g.merchant_id = :merchant_id
                  and m.tenant_id = :tenant_id
                  and (g.expires_at is null or g.expires_at > now())
                """;
        return !jdbc.forTenant(tenant, sql, Json.map(
                "subject_type", subjectType, "subject_id", subjectId,
                "permission", permission, "merchant_id", merchantId)).isEmpty();
    }

    /**
     * Tenant/platform-scoped grant ({@code merchant_id is null}). The subject row must live in the
     * caller's tenant — that join is the tenant predicate here, since grants themselves are
     * tenant-free by schema (see V1: {@code permission_grants} has no tenant_id column).
     */
    public boolean hasTenantGrant(TenantContext tenant, String subjectType, UUID subjectId, String permission) {
        String sql = """
                select g.id
                from permission_grants g
                join users u on u.id = g.subject_id
                where u.tenant_id = :tenant_id
                  and g.subject_type = :subject_type
                  and g.subject_id = :subject_id
                  and g.permission = :permission
                  and g.merchant_id is null
                  and (g.expires_at is null or g.expires_at > now())
                """;
        return !jdbc.forTenant(tenant, sql, Json.map(
                "subject_type", subjectType, "subject_id", subjectId, "permission", permission)).isEmpty();
    }

    public boolean has(TenantContext tenant, String subjectType, UUID subjectId, UUID merchantId, String permission) {
        if (subjectId == null || permission == null) {
            return false;
        }
        return merchantId == null
                ? hasTenantGrant(tenant, subjectType, subjectId, permission)
                : hasMerchantGrant(tenant, subjectType, subjectId, merchantId, permission);
    }

    public List<String> grantedPermissions(TenantContext tenant, String subjectType, UUID subjectId, UUID merchantId) {
        String sql = merchantId == null ? """
                select g.permission from permission_grants g
                join users u on u.id = g.subject_id
                where u.tenant_id = :tenant_id
                  and g.subject_type = :subject_type and g.subject_id = :subject_id and g.merchant_id is null
                  and (g.expires_at is null or g.expires_at > now())
                order by g.permission
                """ : """
                select g.permission from permission_grants g
                join merchants m on m.id = g.merchant_id
                where g.subject_type = :subject_type and g.subject_id = :subject_id and g.merchant_id = :merchant_id
                  and m.tenant_id = :tenant_id
                  and (g.expires_at is null or g.expires_at > now())
                order by g.permission
                """;
        Map<String, Object> params = merchantId == null
                ? Json.map("subject_type", subjectType, "subject_id", subjectId)
                : Json.map("subject_type", subjectType, "subject_id", subjectId, "merchant_id", merchantId);
        return jdbc.forTenant(tenant, sql, params).stream().map(r -> Json.str(r, "permission")).toList();
    }

    public void grant(TenantContext tenant, String subjectType, UUID subjectId, UUID merchantId,
                      String permission, UUID grantedBy) {
        // permission_grants has no tenant column; merchant-scoped rows are anchored through merchants,
        // tenant-scoped rows are written with the tenant implicit in the caller's TenantContext.
        if (merchantId == null) {
            jdbc.crossTenantUpdate("""
                    insert into permission_grants (subject_type, subject_id, merchant_id, permission, granted_by)
                    values (:subject_type, :subject_id, null, :permission, :granted_by)
                    on conflict (subject_type, subject_id, merchant_id, permission) do nothing
                    """, Json.map("subject_type", subjectType, "subject_id", subjectId,
                    "permission", permission, "granted_by", grantedBy));
            return;
        }
        if (!hasMerchantGrant(tenant, "user", grantedBy, merchantId, "admin_members")
                && !hasMerchantGrant(tenant, "merchant_user", grantedBy, merchantId, "admin_members")
                && grantedBy != null && !grantedBy.equals(subjectId)) {
            // Guard rail: granting inside a merchant requires the *operator* to hold admin_members there,
            // unless it is the self-seeding owner path (grantedBy == subjectId) performed at business
            // creation. Reading this as a check on the *subject* asks the person being granted to already
            // hold the permission that lets them be granted — which no new member ever does, so every real
            // second-person grant would be refused and no first one had happened yet to reveal it.
            throw ApiException.forbidden("Granting workspace permissions requires admin_members",
                    Json.map("permission", "admin_members", "operator", grantedBy));
        }
        jdbc.crossTenantUpdate("""
                insert into permission_grants (subject_type, subject_id, merchant_id, permission, granted_by)
                values (:subject_type, :subject_id, :merchant_id, :permission, :granted_by)
                on conflict (subject_type, subject_id, merchant_id, permission) do nothing
                """, Json.map("subject_type", subjectType, "subject_id", subjectId, "merchant_id", merchantId,
                "permission", permission, "granted_by", grantedBy));
    }

    public int revoke(TenantContext tenant, String subjectType, UUID subjectId, UUID merchantId, String permission) {
        String sql = """
                delete from permission_grants g
                using merchants m
                where g.merchant_id = m.id
                  and m.tenant_id = :tenant_id
                  and g.subject_type = :subject_type
                  and g.subject_id = :subject_id
                  and g.merchant_id = :merchant_id
                  and g.permission = :permission
                """;
        return jdbc.updateForTenant(tenant, sql, Json.map("subject_type", subjectType, "subject_id", subjectId,
                "merchant_id", merchantId, "permission", permission));
    }

    /**
     * Every grant a subject holds inside one merchant. Leaving a workspace has to be this, and not only a
     * deleted membership row: {@code permission_grants} carries no foreign key to {@code merchant_users}, so
     * an untouched grant keeps answering {@link #has} for a person who is no longer anybody's staff.
     */
    public int revokeAll(TenantContext tenant, String subjectType, UUID subjectId, UUID merchantId) {
        return jdbc.updateForTenant(tenant, """
                delete from permission_grants g
                using merchants m
                where g.merchant_id = m.id
                  and m.tenant_id = :tenant_id
                  and g.subject_type = :subject_type
                  and g.subject_id = :subject_id
                  and g.merchant_id = :merchant_id
                """, Json.map("subject_type", subjectType, "subject_id", subjectId, "merchant_id", merchantId));
    }
}
