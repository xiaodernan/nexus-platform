package com.nexus.platform;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Liveness/readiness for the container plus the raw inputs the admin health screen renders.
 * Deliberately tenant-free (the tenant filter does not cover these paths).
 */
@RestController
@RequestMapping("/api/v1")
public class SystemController {

    private final NamedParameterJdbcTemplate jdbc;
    private final KeyValueStore store;
    private final org.springframework.core.env.Environment env;

    public SystemController(NamedParameterJdbcTemplate jdbc, KeyValueStore store,
                            org.springframework.core.env.Environment env) {
        this.jdbc = jdbc;
        this.store = store;
        this.env = env;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        out.put("service", "nexus-platform");
        out.put("profiles", env.getActiveProfiles());
        out.put("request_id", RequestIds.current());
        return out;
    }

    @GetMapping("/ready")
    public Map<String, Object> ready() {
        Map<String, Object> out = new LinkedHashMap<>();
        boolean dbUp;
        String flywayVersion = null;
        try {
            jdbc.queryForObject("select 1 as ok", new MapSqlParameterSource(), Integer.class);
            dbUp = true;
            flywayVersion = jdbc.queryForObject(
                    "select max(version) from flyway_schema_history where success", new MapSqlParameterSource(),
                    String.class);
        } catch (Exception e) {
            dbUp = false;
        }
        out.put("status", dbUp ? "ready" : "not_ready");
        out.put("database", dbUp ? "up" : "down");
        out.put("schema_version", flywayVersion);
        out.put("key_value_backend", store.usingRedis() ? "redis" : "in_memory");
        return out;
    }

    /** Shared with the admin console (§9 {@code /admin/system/health}). */
    public Map<String, Object> snapshot() {
        return ready();
    }
}
