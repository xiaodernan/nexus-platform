package com.nexus.platform;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * THE tenancy convention of this codebase, stated once and enforced here:
 *
 * <ol>
 *   <li>Every repository method that touches a tenant-owned table takes {@link TenantContext} as its
 *       first argument and routes its SQL through {@link #forTenant}. (ArchUnit rule:
 *       {@code TenantConventionArchitectureTest#repositoriesThreadTenantContext}.)</li>
 *   <li>{@link #forTenant} refuses to run SQL that does not predicate on {@code tenant_id} and does
 *       not bind the caller's tenant — so a missing filter is a runtime failure, not a review comment.</li>
 *   <li>Statements that legitimately have no tenant (the {@code tenants} table, the analytics views'
 *       tenant rollups, health probes) must go through {@link #crossTenant}; the method name is the
 *       review flag. Every such call site is commented with the reason.</li>
 * </ol>
 *
 * <p>Tables without their own {@code tenant_id} column (cart_items, order_items, messages,
 * permission_grants, ...) are always reached through a JOIN to their tenant-owned parent, so the
 * predicate is still present.
 */
@Component
public class TenantJdbc {

    /** e.g. {@code m.tenant_id = :tenant_id} / {@code tenant_id = :tenant_id}. */
    private static final Pattern PREDICATE = Pattern.compile("(?i)\\btenant_id\\s*(=|in)\\s*(\\w+\\.)?:tenant_id\\b");
    private static final Pattern INSERT_TENANT = Pattern.compile("(?i)\\btenant_id\\b");
    private static final Pattern WRITING = Pattern.compile("(?is)^\\s*(update|delete)\\b");

    private final NamedParameterJdbcTemplate jdbc;

    public TenantJdbc(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public NamedParameterJdbcTemplate raw() {
        return jdbc;
    }

    // ---- guarded, tenant-scoped -----------------------------------------

    public List<Map<String, Object>> forTenant(TenantContext t, String sql, Map<String, Object> params) {
        return jdbc.queryForList(sql, source(bindTenant(t, sql, params)));
    }

    public Optional<Map<String, Object>> firstForTenant(TenantContext t, String sql, Map<String, Object> params) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, source(bindTenant(t, sql, params)));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** Single row or a 404 built from {@code notFoundCode} — cross-tenant reads must look like absent rows. */
    public Map<String, Object> oneForTenant(TenantContext t, String sql, Map<String, Object> params, String notFoundCode) {
        return firstForTenant(t, sql, params).orElseThrow(() -> ApiException.notFound(notFoundCode, "No such record"));
    }

    public int updateForTenant(TenantContext t, String sql, Map<String, Object> params) {
        return jdbc.update(sql, source(bindTenant(t, sql, params)));
    }

    /** Guarded {@code insert ... returning}: the statement must write {@code tenant_id} and bind it. */
    public Map<String, Object> insertForTenant(TenantContext t, String sql, Map<String, Object> params) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, source(bindTenant(t, sql, params)));
        if (rows.isEmpty()) {
            throw ApiException.internal("Insert returned no row", null);
        }
        return rows.get(0);
    }

    public long countForTenant(TenantContext t, String sql, Map<String, Object> params) {
        Long n = jdbc.queryForObject(sql, source(bindTenant(t, sql, params)), Long.class);
        return n == null ? 0 : n;
    }

    // ---- explicit escape hatch ------------------------------------------

    public List<Map<String, Object>> crossTenant(String sql, Map<String, Object> params) {
        return jdbc.queryForList(sql, source(params));
    }

    public Optional<Map<String, Object>> crossTenantFirst(String sql, Map<String, Object> params) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, source(params));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public int crossTenantUpdate(String sql, Map<String, Object> params) {
        return jdbc.update(sql, source(params));
    }

    /** {@code insert ... returning} for a table with no tenant column. Callers must have already
     *  verified the parent anchor (user / merchant) belongs to {@code tenant} — say why in a comment. */
    public Map<String, Object> crossTenantReturning(String sql, Map<String, Object> params) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, source(params));
        if (rows.isEmpty()) {
            throw ApiException.internal("Insert returned no row", null);
        }
        return rows.get(0);
    }

    public long crossTenantCount(String sql, Map<String, Object> params) {
        Long n = jdbc.queryForObject(sql, source(params), Long.class);
        return n == null ? 0 : n;
    }

    public long insertReturningId(String sql, Map<String, Object> params, String column) {
        Number n = jdbc.queryForObject(sql, source(params), Number.class);
        return n == null ? 0 : n.longValue();
    }

    // ---- the rule -------------------------------------------------------

    static void requireTenantFilter(TenantContext t, String sql, Map<String, Object> params) {
        if (t == null || t.tenantId() == null) {
            throw ApiException.internal("TenantContext missing — cannot run a tenant-scoped query", null);
        }
        String trimmed = sql.strip();
        String verb = trimmed.split("\\s+", 2)[0].toLowerCase();
        boolean bound = params != null && t.tenantId().equals(params.get("tenant_id"));
        if (!bound) {
            throw new IllegalStateException(
                    "Tenant convention violated: query bound no :tenant_id param matching the caller's tenant ("
                            + snippet(trimmed) + ")");
        }
        if ("select".equals(verb) || "update".equals(verb) || "delete".equals(verb)) {
            if (!PREDICATE.matcher(trimmed).find()) {
                throw new IllegalStateException(
                        "Tenant convention violated: statement has no `tenant_id = :tenant_id` predicate ("
                                + snippet(trimmed) + ")");
            }
        } else if (!INSERT_TENANT.matcher(trimmed).find()) {
            throw new IllegalStateException("Tenant convention violated: insert does not write tenant_id ("
                    + snippet(trimmed) + ")");
        }
    }

    private static String snippet(String sql) {
        String flat = sql.replaceAll("\\s+", " ");
        return flat.length() <= 140 ? flat : flat.substring(0, 140) + "...";
    }

    /**
     * Validates a statement and returns a parameter map whose {@code tenant_id} is always the
     * caller's tenant: a caller can neither forget the bind nor substitute another tenant's id.
     */
    static Map<String, Object> bindTenant(TenantContext t, String sql, Map<String, Object> params) {
        Map<String, Object> out = new java.util.LinkedHashMap<>(params == null ? Map.of() : params);
        out.put("tenant_id", t == null ? null : t.tenantId());
        requireTenantFilter(t, sql, out);
        return out;
    }

    static boolean looksLikeTenantScoped(String sql) {
        return PREDICATE.matcher(sql).find();
    }

    private static MapSqlParameterSource source(Map<String, Object> params) {
        MapSqlParameterSource src = new MapSqlParameterSource();
        if (params != null) {
            params.forEach((k, v) -> src.addValue(k, v));
        }
        return src;
    }

    /** Convenience for {@code params} maps: {@code P.of("id", uuid, "limit", 20)}. */
    public static Map<String, Object> p(Object... kv) {
        return Json.map(kv);
    }

    public boolean exists(Map<String, Object> params, String sql) {
        Long n = jdbc.queryForObject(sql, source(params), Long.class);
        return n != null && n > 0;
    }

    public Optional<Map<String, Object>> tryFirst(String sql, Map<String, Object> params) {
        try {
            return Optional.ofNullable(jdbc.queryForMap(sql, source(params)));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }
}
