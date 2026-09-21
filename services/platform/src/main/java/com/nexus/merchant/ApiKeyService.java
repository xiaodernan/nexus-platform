package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.ApiKeyVerifier;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Merchant API keys. Only the SHA-256 hash is stored; the plaintext is shown exactly once at creation.
 * Each granted scope is also written as a {@code permission_grants} row for
 * {@code subject_type='api_key'}, so the interceptor's check and the key's scopes can never drift apart.
 */
@Service
public class ApiKeyService implements ApiKeyVerifier {

    public static final String PREFIX = "nx_live_";

    private final TenantJdbc jdbc;
    private final PermissionService permissions;
    private final AuditService audit;

    public ApiKeyService(TenantJdbc jdbc, PermissionService permissions, AuditService audit) {
        this.jdbc = jdbc;
        this.permissions = permissions;
        this.audit = audit;
    }

    @Transactional
    public Map<String, Object> create(TenantContext tenant, UUID merchantId, String name, List<String> scopes,
                                      UUID createdBy) {
        List<String> allowed = scopes.stream().filter(MerchantPermissions.API_KEY_SCOPES::contains).toList();
        if (allowed.isEmpty()) {
            throw ApiException.validation("scopes must include at least one of " + MerchantPermissions.API_KEY_SCOPES,
                    Json.map("field", "scopes"));
        }
        if (allowed.stream().anyMatch(s -> !MerchantPermissions.API_KEY_SCOPES.contains(s))) {
            throw ApiException.validation("Unknown scope requested", Json.map("requested", scopes));
        }
        byte[] random = new byte[24];
        new java.security.SecureRandom().nextBytes(random);
        String secret = PREFIX + HexFormat.of().formatHex(random);
        String displayPrefix = secret.substring(0, Math.min(13, secret.length()));

        Map<String, Object> row = jdbc.insertForTenant(tenant, """
                insert into api_keys (merchant_id, name, key_hash, prefix, scopes)
                select m.id, :name, :key_hash, :prefix, string_to_array(:scopes, ',')
                from merchants m where m.id = :merchant_id and m.tenant_id = :tenant_id
                returning id
                """, Json.map("merchant_id", merchantId, "name", name, "key_hash", sha256(secret),
                "prefix", displayPrefix, "scopes", Json.csv(allowed)));
        UUID keyId = Json.uuid(row, "id");
        for (String scope : allowed) {
            jdbc.crossTenantUpdate("""
                    insert into permission_grants (subject_type, subject_id, merchant_id, permission, granted_by)
                    values ('api_key', :subject_id, :merchant_id, :permission, :granted_by)
                    on conflict (subject_type, subject_id, merchant_id, permission) do nothing
                    """, Json.map("subject_id", keyId, "merchant_id", merchantId, "permission", scope,
                    "granted_by", createdBy));
        }
        audit.record(tenant, "user", createdBy, "create_api_key", "api_key", keyId, merchantId, null,
                Json.map("name", name, "scopes", allowed, "prefix", displayPrefix), Json.map(), null, null);
        return Json.map("api_key_id", keyId.toString(), "name", name, "prefix", displayPrefix,
                "scopes", allowed, "api_key", secret,
                "notice", "Copy this secret now — only its SHA-256 hash is stored and it cannot be shown again.");
    }

    public List<Map<String, Object>> list(TenantContext tenant, UUID merchantId) {
        return jdbc.forTenant(tenant, """
                select k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.revoked_at, k.created_at, m.tenant_id
                from api_keys k join merchants m on m.id = k.merchant_id
                where k.merchant_id = :merchant_id and m.tenant_id = :tenant_id
                order by k.created_at desc
                """, Json.map("merchant_id", merchantId)).stream()
                .map(r -> Json.map("api_key_id", Json.str(r, "id"), "name", Json.str(r, "name"),
                        "prefix", Json.str(r, "prefix"), "scopes", Json.textArray(r, "scopes"),
                        "last_used_at", Json.ts(r, "last_used_at"), "revoked_at", Json.ts(r, "revoked_at"),
                        "created_at", Json.ts(r, "created_at"),
                        "revoked", Json.ts(r, "revoked_at") != null))
                .toList();
    }

    @Transactional
    public void revoke(TenantContext tenant, UUID keyId, UUID actorId) {
        int updated = jdbc.updateForTenant(tenant, """
                update api_keys k set revoked_at = now()
                from merchants m
                where k.id = :id and m.id = k.merchant_id and m.tenant_id = :tenant_id and k.revoked_at is null
                """, Json.map("id", keyId));
        if (updated == 0) {
            throw ApiException.notFound("api_key_not_found", "No such active api key");
        }
        jdbc.crossTenantUpdate("delete from permission_grants where subject_type = 'api_key' and subject_id = :id",
                Json.map("id", keyId));
        audit.record(tenant, "user", actorId, "revoke_api_key", "api_key", keyId, null, null, null, Json.map(),
                null, null);
    }

    @Override
    public Optional<Principal> verify(String rawKey, TenantContext tenant) {
        Optional<Map<String, Object>> row = jdbc.firstForTenant(tenant, """
                select k.id, k.merchant_id, k.scopes, m.tenant_id
                from api_keys k join merchants m on m.id = k.merchant_id
                where k.key_hash = :hash and m.tenant_id = :tenant_id and k.revoked_at is null
                """, Json.map("hash", sha256(rawKey)));
        return row.map(r -> new Principal("api_key", Json.uuid(r, "id"), null, tenant.tenantId(), "api_key",
                Json.uuid(r, "merchant_id"), null, null, "api_key"));
    }

    @Override
    public void touch(UUID keyId) {
        // api_keys has no tenant column; the id comes from a row we just tenant-verified in verify().
        jdbc.crossTenantUpdate("update api_keys set last_used_at = now() where id = :id", Json.map("id", keyId));
    }

    static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw ApiException.internal("SHA-256 unavailable", e);
        }
    }
}
