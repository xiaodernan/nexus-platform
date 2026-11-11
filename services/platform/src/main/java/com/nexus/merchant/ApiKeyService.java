package com.nexus.merchant;

import com.nexus.platform.ApiException;
import com.nexus.platform.ApiKeyVerifier;
import com.nexus.platform.AuditService;
import com.nexus.platform.Json;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.Singleflight;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
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

    /**
     * D933: one bound answer for a key-hash lookup (valid / invalid) until its TTL expires. The
     * empty principal is cached too, so a client stuck in a bad-secret retry loop stops asking
     * the database on every attempt — bounded by {@code verifyCacheMax}.
     */
    private static final class VerifyEntry {
        final Optional<Principal> principal;
        final long expiresAt;

        VerifyEntry(Optional<Principal> principal, long expiresAt) {
            this.principal = principal;
            this.expiresAt = expiresAt;
        }
    }

    /**
     * D933: `verify()` is the hot pre-auth path for every `nx_`-keyed caller — raw-SQL JOIN per
     * authenticated request with no cache anywhere. A bounded access-order LRU (same shape as the
     * D912/D909 caches) capped at {@code verifyCacheMax} and valid for {@code verifyCacheTtlMs}
     * (`<=0` bypasses entirely). Writes that invalidate a key — {@link #revoke} — flush the whole
     * map synchronously, so this process never answers stale for a revoked key after the revoke
     * returns. A failed lookup is never cached. Cross-instance invalidation is absent: a peer
     * process' cached entry may outlive a revoke by at most the TTL (the same staleness
     * D912/D902 already accept on this same auth path).
     */
    private final LinkedHashMap<String, VerifyEntry> verifyCache;
    private final long verifyCacheTtlMs;
    private final int verifyCacheMax;

    /**
     * D933: `touch()` wrote `api_keys.last_used_at = now()` on EVERY authenticated request — a
     * one-row UPDATE with zero reads piggy-backing dispatch order. The hook now emits at most one
     * UPDATE per key per {@code touchThrottleMs} (`<=0` bypasses, restoring old per-request write
     * amplification). The access-order LRU caps the tracked ids at {@code touchThrottleMax}; a
     * freshly evicted id simply touches again. last_used_at may therefore lag reality by up to the
     * throttle window — document, don't hide.
     */
    private final LinkedHashMap<UUID, Long> touchSeen;
    private final long touchThrottleMs;
    private final int touchThrottleMax;

    /**
     * D944: opt-in singleflight over the D933 LRU's MISS path. The LRU remembers a finished answer but does
     * nothing about N concurrent misses for the same cold key — each left the map lock and ran its own SELECT
     * (the check-then-load window). When enabled, misses for one cache key coalesce into ONE load; peers join
     * the in-flight future and share its result or its failure. Default OFF preserves D933 byte-for-byte.
     */
    private final Singleflight<String, Optional<Principal>> verifySingleflight;
    private final boolean verifySingleflightEnabled;

    /**
     * D944 — Spring-primary constructor. Marked {@code @Autowired} because the 7-arg compatibility
     * constructor below also exists (D931's lesson: two public constructors need an explicit primary).
     */
    @Autowired
    public ApiKeyService(TenantJdbc jdbc, PermissionService permissions, AuditService audit,
                         @Value("${nexus.api_key.verify-cache-ttl-ms:15000}") long verifyCacheTtlMs,
                         @Value("${nexus.api_key.verify-cache-max:512}") int verifyCacheMax,
                         @Value("${nexus.api_key.touch-throttle-ms:60000}") long touchThrottleMs,
                         @Value("${nexus.api_key.touch-throttle-max:1024}") int touchThrottleMax,
                         @Value("${nexus.api_key.verify-singleflight-enabled:false}") boolean verifySingleflightEnabled) {
        this.jdbc = jdbc;
        this.permissions = permissions;
        this.audit = audit;
        this.verifyCacheTtlMs = verifyCacheTtlMs;
        this.verifyCacheMax = verifyCacheMax;
        this.touchThrottleMs = touchThrottleMs;
        this.touchThrottleMax = touchThrottleMax;
        this.verifySingleflightEnabled = verifySingleflightEnabled;
        this.verifySingleflight = new Singleflight<>();
        this.verifyCache = new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, VerifyEntry> eldest) {
                return size() > verifyCacheMax;
            }
        };
        this.touchSeen = new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<UUID, Long> eldest) {
                return size() > touchThrottleMax;
            }
        };
    }

    /** D944 compatibility constructor (singleflight OFF) — keeps every D933 test and programmatic caller working. */
    public ApiKeyService(TenantJdbc jdbc, PermissionService permissions, AuditService audit,
                         long verifyCacheTtlMs, int verifyCacheMax, long touchThrottleMs, int touchThrottleMax) {
        this(jdbc, permissions, audit, verifyCacheTtlMs, verifyCacheMax, touchThrottleMs, touchThrottleMax, false);
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
        flushVerifyCache();
        audit.record(tenant, "user", actorId, "revoke_api_key", "api_key", keyId, null, null, null, Json.map(),
                null, null);
    }

    @Override
    public Optional<Principal> verify(String rawKey, TenantContext tenant) {
        String hash = sha256(rawKey);
        if (verifyCacheTtlMs > 0) {
            String cacheKey = tenant.tenantId() + ":" + hash;
            long now = System.currentTimeMillis();
            synchronized (verifyCache) {
                VerifyEntry hit = verifyCache.get(cacheKey);
                if (hit != null && hit.expiresAt > now) {
                    return hit.principal;
                }
                if (hit != null) {
                    verifyCache.remove(cacheKey);
                }
            }
            // D944: coalesce concurrent misses for THIS cache key into one DB load. The D933 lock above only
            // guarded the cache MAP lookup and was released before the query — N cold-key callers each ran the
            // SELECT. When enabled, the first miss loads and the rest join its future (same value or same
            // failure); a failed load clears the in-flight entry so the next request retries. OFF (default)
            // calls loadForTenant directly, byte-for-byte the D933 path.
            Optional<Principal> loaded = verifySingleflightEnabled
                    ? verifySingleflight.run(cacheKey, () -> loadForTenant(tenant, hash))
                    : loadForTenant(tenant, hash);
            synchronized (verifyCache) {
                verifyCache.put(cacheKey, new VerifyEntry(loaded, System.currentTimeMillis() + verifyCacheTtlMs));
            }
            return loaded;
        }
        return loadForTenant(tenant, hash);
    }

    private Optional<Principal> loadForTenant(TenantContext tenant, String hash) {
        Optional<Map<String, Object>> row = jdbc.firstForTenant(tenant, """
                select k.id, k.merchant_id, k.scopes, m.tenant_id
                from api_keys k join merchants m on m.id = k.merchant_id
                where k.key_hash = :hash and m.tenant_id = :tenant_id and k.revoked_at is null
                """, Json.map("hash", hash));
        return row.map(r -> new Principal("api_key", Json.uuid(r, "id"), null, tenant.tenantId(), "api_key",
                Json.uuid(r, "merchant_id"), null, null, "api_key"));
    }

    @Override
    public void touch(UUID keyId) {
        // api_keys has no tenant column; the id comes from a row we just tenant-verified in verify().
        if (touchThrottleMs > 0) {
            long now = System.currentTimeMillis();
            synchronized (touchSeen) {
                Long last = touchSeen.get(keyId);  // access-order map: the get re-pins the entry's recency
                if (last != null && now - last < touchThrottleMs) {
                    return;
                }
            }
        }
        jdbc.crossTenantUpdate("update api_keys set last_used_at = now() where id = :id", Json.map("id", keyId));
        if (touchThrottleMs > 0) {
            synchronized (touchSeen) {
                touchSeen.put(keyId, System.currentTimeMillis());
            }
        }
    }

    /**
     * Flush every cached verify answer. Called by {@link #revoke} after a key dies so this process
     * never answers stale for it afterwards — the same discipline {@code PermissionService} applies
     * to grant writes (D912).
     */
    private void flushVerifyCache() {
        synchronized (verifyCache) {
            verifyCache.clear();
        }
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
