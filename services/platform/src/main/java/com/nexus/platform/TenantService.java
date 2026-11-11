package com.nexus.platform;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Resolves the request tenant from {@code X-Tenant} (else hostname, else the configured default) and
 * caches the tiny tenants table. Lookups here are the only legitimate cross-tenant queries in the
 * codebase: they read the {@code tenants} row itself, which is the definition of the tenant, not a
 * tenant-owned record.
 *
 * <p>D902: a slug the table does not know is remembered in a bounded, expiring negative tier.
 * Without it, {@code computeIfAbsent} stores no null result, so every request carrying a bogus
 * {@code X-Tenant} ran the SELECT again — unauthenticated and ahead of the rate limiter
 * (TenantFilter order 20 &lt; RateLimitFilter order 50). The tier is an access-order LRU so slug
 * rotation cannot grow it without bound, and a TTL so a tenant created later is not masked
 * forever. A failed SELECT propagates and is never cached: an outage must not read as "no such
 * tenant" once the database returns.
 */
@Component
public class TenantService {

    private final NamedParameterJdbcTemplate jdbc;
    private final Map<String, TenantContext> bySlug = new ConcurrentHashMap<>();
    private final long negativeTtlMs;
    /** slug -> expiry epoch ms; access-order LRU, every touch under the map's monitor. */
    private final Map<String, Long> unknown;

    public TenantService(NamedParameterJdbcTemplate jdbc,
                         @Value("${nexus.tenant.negative-ttl-ms:30000}") long negativeTtlMs,
                         @Value("${nexus.tenant.negative-cache-max:1024}") int negativeCacheMax) {
        this.jdbc = jdbc;
        this.negativeTtlMs = negativeTtlMs;
        this.unknown = Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) {
                return size() > negativeCacheMax;
            }
        });
    }

    public TenantContext resolve(String rawSlug) {
        if (rawSlug == null || rawSlug.isBlank()) {
            return null;
        }
        String slug = rawSlug.trim().toLowerCase();
        if (!slug.matches("[a-z0-9][a-z0-9-]{0,62}")) {
            return null;
        }
        TenantContext cached = bySlug.get(slug);
        if (cached != null) {
            return cached;
        }
        if (negativeHit(slug)) {
            return null;
        }
        TenantContext ctx = bySlug.computeIfAbsent(slug, this::load);
        if (ctx == null && negativeTtlMs > 0) {
            synchronized (unknown) {
                unknown.put(slug, System.currentTimeMillis() + negativeTtlMs);
            }
        }
        return ctx;
    }

    private boolean negativeHit(String slug) {
        if (negativeTtlMs <= 0) {
            return false;
        }
        synchronized (unknown) {
            Long expiry = unknown.get(slug);
            if (expiry == null) {
                return false;
            }
            if (expiry > System.currentTimeMillis()) {
                return true;
            }
            unknown.remove(slug);
            return false;
        }
    }

    private TenantContext load(String slug) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "select id, slug, currency, timezone, country_code from tenants where slug = :slug and status = 'active'",
                new MapSqlParameterSource("slug", slug));
        if (rows.isEmpty()) {
            return null;
        }
        Map<String, Object> row = rows.get(0);
        return new TenantContext(Json.uuid(row, "id"), Json.str(row, "slug"), Json.str(row, "currency"),
                Json.str(row, "timezone"), Json.str(row, "country_code"));
    }

    public void evict(String slug) {
        bySlug.remove(slug);
        synchronized (unknown) {
            unknown.remove(slug);
        }
    }

    public boolean exists(UUID tenantId) {
        Integer n = jdbc.queryForObject("select count(*) from tenants where id = :id",
                new MapSqlParameterSource("id", tenantId), Integer.class);
        return n != null && n > 0;
    }
}
