package com.nexus.admin;

import com.nexus.platform.KeyValueStore;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPlatformRole;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §9 — {@code GET /api/v1/admin/system/health}.
 *
 * <p>Every dependency is probed, none is asserted. The database state comes from a real
 * {@code select 1} issued on this call, so a database that is down reports {@code down} and the overall
 * status degrades — the opposite of a hardcoded {@code "ok"} that stays green through an outage. The
 * key/value backend reports which store is actually serving (Redis or the in-memory fallback), which is
 * the fact {@link KeyValueStore} already tracks. The AI service is reported as {@code configured} with its
 * base URL and explicitly <em>not</em> probed: this route must not turn a health check into a synchronous
 * call to another process that can hang.
 *
 * <p>Unlike {@code /api/v1/health} (a process answer that stays 200 while the database is down, §11) this
 * is the operator's view, so it carries the per-dependency truth. It is still a 200 with an honest body
 * rather than a 500: a health screen that cannot render the unhealthy state is not a health screen.
 */
@RestController
@RequestMapping("/api/v1/admin/system")
public class AdminSystemController {

    private final NamedParameterJdbcTemplate jdbc;
    private final KeyValueStore store;
    private final Environment env;
    private final String aiBaseUrl;

    public AdminSystemController(NamedParameterJdbcTemplate jdbc, KeyValueStore store, Environment env,
                                 @Value("${nexus.ai.base-url:}") String aiBaseUrl) {
        this.jdbc = jdbc;
        this.store = store;
        this.env = env;
        this.aiBaseUrl = aiBaseUrl;
    }

    @GetMapping("/health")
    @RequiresPlatformRole
    public Map<String, Object> health(HttpServletRequest request) {
        long started = System.nanoTime();
        String databaseState;
        String schemaVersion = null;
        String error = null;
        try {
            jdbc.queryForObject("select 1 as ok", new MapSqlParameterSource(), Integer.class);
            databaseState = "up";
            try {
                schemaVersion = jdbc.queryForObject(
                        "select max(version) from flyway_schema_history where success",
                        new MapSqlParameterSource(), String.class);
            } catch (Exception ignored) {
                // A database provisioned without a Flyway history (the test database) is still up; the
                // version is simply unknown, which is different from the database being unreachable.
                schemaVersion = null;
            }
        } catch (Exception e) {
            databaseState = "down";
            error = e.getClass().getSimpleName();
        }
        long latencyMs = (System.nanoTime() - started) / 1_000_000L;

        Map<String, Object> database = new LinkedHashMap<>();
        database.put("state", databaseState);
        database.put("latency_ms", latencyMs);
        database.put("error", error);

        Map<String, Object> keyValue = new LinkedHashMap<>();
        keyValue.put("state", store.usingRedis() ? "redis" : "in_memory");

        Map<String, Object> ai = new LinkedHashMap<>();
        boolean aiConfigured = aiBaseUrl != null && !aiBaseUrl.isBlank();
        ai.put("state", aiConfigured ? "configured" : "not_configured");
        ai.put("base_url", aiConfigured ? aiBaseUrl : null);
        ai.put("probed", false);

        boolean healthy = "up".equals(databaseState);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", healthy ? "ok" : "degraded");
        out.put("service", "nexus-platform");
        out.put("as_of", Instant.now().toString());
        out.put("request_id", Req.requestId(request));
        out.put("dependencies", com.nexus.platform.Json.map(
                "database", database,
                "key_value", keyValue,
                "ai_service", ai));
        out.put("schema_version", schemaVersion);
        out.put("profiles", env.getActiveProfiles());
        out.put("note", "Per-dependency state, probed on this call. The database state is a real select 1; "
                + "the AI service is reported as configured but is deliberately not probed here.");
        return out;
    }
}
