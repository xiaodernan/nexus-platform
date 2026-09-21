package com.nexus.platform;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Stores and replays idempotent operations in {@code idempotency_keys} (§1). The interceptor only
 * proves the header exists; the handler knows the response shape, so it wraps its work here:
 * first caller executes and records the response, a replay returns the recorded response without
 * re-executing (no double charge).
 */
@Service
public class IdempotencyService {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyService.class);

    private final NamedParameterJdbcTemplate jdbc;
    private final long ttlSeconds;

    public IdempotencyService(NamedParameterJdbcTemplate jdbc,
                              @Value("${nexus.idempotency.ttl-seconds:86400}") long ttlSeconds) {
        this.jdbc = jdbc;
        this.ttlSeconds = ttlSeconds;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> run(String scope, String key, UUID ownerId,
                                   java.util.function.Supplier<Map<String, Object>> work) {
        MapSqlParameterSource claim = new MapSqlParameterSource()
                .addValue("key", scope + "|" + key)
                .addValue("scope", scope)
                .addValue("owner_id", ownerId)
                .addValue("ttl", ttlSeconds);
        // NOTE: idempotency_keys is keyed by (scope|key) + owner and has no tenant column in V1 — the
        // owner binding below is what stops cross-account replays. Cross-tenant statement by design.
        int inserted = jdbc.update("""
                insert into idempotency_keys (key, scope, owner_id, status, response, expires_at)
                values (:key, :scope, :owner_id, 'in_progress', null, now() + make_interval(secs => :ttl))
                on conflict (key) do nothing
                """, claim);

        if (inserted == 0) {
            Map<String, Object> existing = jdbc.queryForMap("""
                    select scope, owner_id, status, response from idempotency_keys where key = :key
                    """, new MapSqlParameterSource("key", scope + "|" + key));
            Object owner = existing.get("owner_id");
            if (ownerId != null && (owner == null || !String.valueOf(owner).equals(ownerId.toString()))) {
                throw ApiException.conflict("idempotency_key_conflict",
                        "This Idempotency-Key was already used by a different account", Map.of("scope", scope));
            }
            if (!String.valueOf(existing.get("scope")).equals(scope)) {
                throw ApiException.conflict("idempotency_key_conflict",
                        "This Idempotency-Key was already used for a different operation", Map.of("scope", scope));
            }
            String status = String.valueOf(existing.get("status"));
            if ("completed".equals(status)) {
                Object response = existing.get("response");
                String raw = response == null ? null
                        : (response instanceof org.postgresql.util.PGobject p ? p.getValue() : String.valueOf(response));
                log.info("idempotency_replay scope={} key={}", scope, key);
                Map<String, Object> body = raw == null ? new LinkedHashMap<>() : Json.parseObject(raw);
                body = new LinkedHashMap<>(body);
                body.put("idempotent_replay", true);
                return body;
            }
            throw ApiException.conflict("request_in_progress",
                    "A request with this Idempotency-Key is still being processed", Map.of("scope", scope));
        }

        try {
            Map<String, Object> response = work.get();
            jdbc.update("""
                    update idempotency_keys set status = 'completed', response = cast(:response as jsonb)
                    where key = :key
                    """, new MapSqlParameterSource("key", scope + "|" + key)
                    .addValue("response", Json.write(response)));
            return response;
        } catch (RuntimeException e) {
            // Release the claim so the caller may retry the same key after a genuine failure.
            jdbc.update("delete from idempotency_keys where key = :key and status = 'in_progress'",
                    new MapSqlParameterSource("key", scope + "|" + key));
            throw e;
        }
    }

    /** Keys are stored as {@code scope|key}; the raw header value is what clients send. */
    public static String headerOnly(String scope, String key) {
        return scope + "|" + key;
    }
}
