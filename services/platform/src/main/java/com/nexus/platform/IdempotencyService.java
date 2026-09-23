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
 *
 * <p>That guarantee has a window, and the window is enforced on the read side rather than by a sweeper:
 * {@code expires_at} is compared against {@code now()} every time an insert loses to an existing row, so
 * a claim outside its window stops answering and the key becomes available again. The trade is the one
 * §1 describes — after {@code nexus.idempotency.ttl-seconds} a retried key runs the work again, and what
 * keeps the second run honest is the resource's own integrity rules, not this table. The other thing an
 * expired claim used to do was nothing: an {@code in_progress} row left by a process that died mid-request
 * had no deadline anyone read, so every later retry was a 409 forever (D46).
 *
 * <p>The two halves are one promise: a handler that calls {@link #run} must also carry
 * {@code @Idempotent(scope = <the same string>)}, because {@code run} is what makes the header
 * meaningful and {@code @Idempotent} is what makes it arrive. {@link #run} refuses a null or blank key
 * rather than deriving one — see the guard there for what a shared {@code <scope>|null} row would do to
 * the second caller. {@code IdempotencyPairingTest} checks the pairs against the source; both exist
 * because neither half is visible from the other.
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
        if (key == null || key.isBlank()) {
            // The claim row is keyed by scope + '|' + key, so a missing header is not "no key" — it is the
            // literal '<scope>|null', one row every keyless caller of this route shares. The first caller's
            // stored answer then replays onto a second, unrelated operation of the same account, and a
            // different account is locked out with idempotency_key_conflict until the claim's window ends and
            // someone next reaches for that literal reclaims it (D46). Reaching this line means the handler
            // wrapped its work here without declaring @Idempotent, so the interceptor never demanded the
            // header; fix it there rather than relaxing this check.
            throw ApiException.internal("IdempotencyService.run(\"" + scope + "\", ...) reached a caller with no "
                    + "Idempotency-Key, so the claim row would be the literal '" + scope + "|null'; declare "
                    + "@Idempotent(scope = '" + scope + "') on the handler so the interceptor refuses the "
                    + "request before this runs", null);
        }
        MapSqlParameterSource claim = new MapSqlParameterSource()
                .addValue("key", scope + "|" + key)
                .addValue("scope", scope)
                .addValue("owner_id", ownerId)
                .addValue("ttl", ttlSeconds);
        // NOTE: idempotency_keys is keyed by (scope|key) + owner and has no tenant column in V1 — the
        // owner binding below is what stops cross-account replays. Cross-tenant statement by design.
        int inserted = insertClaim(claim);
        if (inserted == 0 && jdbc.update("""
                delete from idempotency_keys where key = :key and expires_at < now()
                """, claim) > 0) {
            // The row that held this key is outside its window, so it answers no one: an expired `completed`
            // claim is past the period §1 promises it for, and an expired `in_progress` claim is the shape a
            // killed process leaves behind — a request that never finished and never released its key. Without
            // this the second reads `in_progress` and returns request_in_progress on every retry forever.
            // Dropping it costs nothing the window had not already taken, and the re-insert below decides who
            // runs next: a concurrent retrier that loses the insert falls through to the replay/refuse branch,
            // where the fresh row is `in_progress` again (D46).
            inserted = insertClaim(claim);
        }

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

    /**
     * Claims {@code scope|key} for this caller, or returns 0 when a row already holds it. The claim carries
     * {@code expires_at = now() + ttl}: the window is what makes a replay an answer rather than an
     * archive, so {@link #run} reads that column as well as writing it (D46).
     */
    private int insertClaim(MapSqlParameterSource claim) {
        return jdbc.update("""
                insert into idempotency_keys (key, scope, owner_id, status, response, expires_at)
                values (:key, :scope, :owner_id, 'in_progress', null, now() + make_interval(secs => :ttl))
                on conflict (key) do nothing
                """, claim);
    }
}
