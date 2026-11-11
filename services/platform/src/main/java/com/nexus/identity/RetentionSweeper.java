package com.nexus.identity;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import com.nexus.platform.Json;
import com.nexus.platform.TenantJdbc;

/**
 * §106 retention sweeper: the workflow behind the {@code deletion_requests} ledger door.
 *
 * <p>The erase door files a request and rewrites the person's own identifier columns; it cannot
 * erase the copies of their contact values they left on OTHER rows — a reservation's {@code contact}
 * copy, an order's, a notification's {@code payload} — without lying about what it did. This sweeper
 * is what performs that second, slower step: it reads the pending requests every so often, and for
 * each one it nulls the contact jsonb on its reservations and orders, rewrites notifications'
 * payload to {@code {}}, and deletes the person's saved search rows, then marks the request as
 * completed with a completion moment recorded.
 *
 * <p>Claim boundaries, honestly:
 * <ul>
 *   <li>The scope is explicitly the rows the person's own writes created (reservation contact, order
 *       contact, notification payload, saved searches). It does NOT scrub audit trails — those are
 *       the platform's record of who was responsible, and accountability survives erasure by design.</li>
 *   <li>It does NOT touch orders, reservations or notifications that are not linked to this user
 *       (the only thing the row carries linking it is {@code user_id}; no other anchor is queried).</li>
 *   <li>The scheduled tick is opt-in via {@code nexus.retention.enabled} (default off — never sweeps
 *       unless an operator explicitly turns it on); tests call {@link #sweep(int, long)} directly.</li>
 *   <li>A single failing user does not block the rest: each user's erasure is independent, errors
 *       are logged, and the request stays pending for the next tick.</li>
 * </ul>
 */
@Service
public class RetentionSweeper {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(RetentionSweeper.class);

    private final TenantJdbc jdbc;
    private volatile boolean enabled;

    public RetentionSweeper(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /** Per-table outcome; the caller can see exactly what the sweep reached, for audit. */
    public record SweepReport(int processed, int reservations, int orders, int notifications,
                              int savedSearches) {
    }

    @org.springframework.beans.factory.annotation.Value("${nexus.retention.enabled:false}")
    public void setEnabled(boolean v) {
        this.enabled = v;
    }

    /** The scheduled tick: a no-op unless {@code nexus.retention.enabled=true}. */
    @Scheduled(fixedDelayString = "${nexus.retention.sweep-interval-ms:3600000}",
               initialDelayString = "${nexus.retention.sweep-initial-ms:60000}")
    public void tick() {
        if (!enabled) {
            return;
        }
        SweepReport r = sweep(1000, 0L);
        if (r.processed() > 0) {
            log.info("retention_sweep processed={} reservations={} orders={} notifications={} saved_searches={}",
                    r.processed(), r.reservations(), r.orders(), r.notifications(), r.savedSearches());
        }
    }

    /**
     * Scans for pending requests filed at least {@code minAgeMs} ago and runs the erasure for each.
     * Statements run independently; a failure for one user does not touch another.
     */
    public SweepReport sweep(int batchSize, long minAgeMs) {
        return sweepPendingDeletionRequests(batchSize, minAgeMs);
    }

    public SweepReport sweepPendingDeletionRequests(int batchSize, long minAgeMs) {
        return sweepPendingDeletionRequestsForUser(null, batchSize, minAgeMs);
    }

    public SweepReport sweepPendingDeletionRequestsForUser(UUID forUser, int batchSize, long minAgeMs) {
        // One method, two entry points — the scheduled tick takes the global lane; a test that must
        // assert on exactly one user's rows takes the per-user lane so other tests' pending rows
        // are not swept out from under them.
        String predicate = forUser != null ? "and user_id = :user_id" : "";
        Map<String, Object> params = forUser != null
                ? Json.map("ageMs", (double) minAgeMs, "limit", batchSize, "user_id", forUser)
                : Json.map("ageMs", (double) minAgeMs, "limit", batchSize);
        List<Map<String, Object>> pending = jdbc.crossTenant("""
                SELECT id, user_id FROM deletion_requests
                 WHERE status = 'pending'
                   AND created_at < now() - :ageMs * interval '1 millisecond'
                   """ + predicate + """
                 ORDER BY created_at ASC
                 LIMIT :limit
                """, params);

        int reservations = 0, orders = 0, notifications = 0, savedSearches = 0;
        for (Map<String, Object> row : pending) {
            UUID id = (UUID) row.get("id");
            UUID userId = (UUID) row.get("user_id");
            try {
                reservations += this.eraseReservations(userId);
                orders += this.eraseOrders(userId);
                notifications += this.eraseNotifications(userId);
                savedSearches += this.eraseSavedSearches(userId);
                // Idempotent sweep completed for this row — mark it done.
                jdbc.crossTenantUpdate("""
                        UPDATE deletion_requests
                           SET status = 'completed', completed_at = now()
                         WHERE id = :id
                        """, Json.map("id", id));
            } catch (Exception e) {
                log.warn("retention_sweep_skipped user_id={} reason={}", userId, e.getMessage());
            }
        }
        return new SweepReport(pending.size(), reservations, orders, notifications, savedSearches);
    }

    /** Reservations made by the person — null out their stored contact copy. */
    private int eraseReservations(UUID userId) {
        return jdbc.crossTenantUpdate("""
                UPDATE reservations
                   SET contact = '{}'::jsonb
                 WHERE user_id = :user_id
                   AND contact != '{}'::jsonb
                """, Json.map("user_id", userId));
    }

    /** Orders made by the person — null out their stored contact copy. */
    private int eraseOrders(UUID userId) {
        return jdbc.crossTenantUpdate("""
                UPDATE orders
                   SET contact = '{}'::jsonb
                 WHERE user_id = :user_id
                   AND contact != '{}'::jsonb
                """, Json.map("user_id", userId));
    }

    /** Notifications addressed to the person — their payload is replaced with an empty object. */
    private int eraseNotifications(UUID userId) {
        return jdbc.crossTenantUpdate("""
                UPDATE notifications
                   SET payload = '{}'::jsonb
                 WHERE user_id = :user_id
                   AND payload != '{}'::jsonb
                """, Json.map("user_id", userId));
    }

    /** Saved searches — deleted entirely; they are personal artefacts with no aggregate value. */
    private int eraseSavedSearches(UUID userId) {
        return jdbc.crossTenantUpdate("""
                DELETE FROM saved_searches WHERE user_id = :user_id
                """, Json.map("user_id", userId));
    }
}
