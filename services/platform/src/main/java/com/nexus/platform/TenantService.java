package com.nexus.platform;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Resolves the request tenant from {@code X-Tenant} (else hostname, else the configured default) and
 * caches the tiny tenants table. Lookups here are the only legitimate cross-tenant queries in the
 * codebase: they read the {@code tenants} row itself, which is the definition of the tenant, not a
 * tenant-owned record.
 */
@Component
public class TenantService {

    private final NamedParameterJdbcTemplate jdbc;
    private final Map<String, TenantContext> bySlug = new ConcurrentHashMap<>();

    public TenantService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public TenantContext resolve(String rawSlug) {
        if (rawSlug == null || rawSlug.isBlank()) {
            return null;
        }
        String slug = rawSlug.trim().toLowerCase();
        if (!slug.matches("[a-z0-9][a-z0-9-]{0,62}")) {
            return null;
        }
        return bySlug.computeIfAbsent(slug, this::load);
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
    }

    public boolean exists(UUID tenantId) {
        Integer n = jdbc.queryForObject("select count(*) from tenants where id = :id",
                new MapSqlParameterSource("id", tenantId), Integer.class);
        return n != null && n > 0;
    }
}
