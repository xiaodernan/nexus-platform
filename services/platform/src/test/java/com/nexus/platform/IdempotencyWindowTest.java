package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nexus.testsupport.NexusIntegrationTest;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * §1 gives a stored replay a window — {@code nexus.idempotency.ttl-seconds}, 24 hours by default — and D45
 * repeated it in prose: a colliding claim is refused "until the TTL ends". Writing {@code expires_at} on the
 * claim is the easy half. Until something compares that column with {@code now()} the sentence describes a
 * promise no code keeps, and the failure that follows is not cosmetic: the only exit from an
 * {@code in_progress} row is the delete in {@code run}'s own catch block, which needs the process to survive
 * long enough to reach it, so a request killed between claim and completion left every later retry of that
 * key a 409 forever.
 *
 * <p>The tests age a claim by setting {@code expires_at} in the past, because the window is a fact about that
 * column: sleeping for the TTL is not a test, and configuring the TTL to one second would measure the property
 * binding rather than the read. Rows are inserted in the shape {@code run} inserts them, which is what makes
 * the abandoned-claim witness faithful — {@code run} is the only thing in this build that writes an
 * {@code in_progress} row, so a hand-written one and a crashed request leave the same database behind.
 *
 * <p>Each test also asserts the case that must <em>not</em> change: a claim still inside its window keeps
 * replaying, and keeps refusing a second caller. Without those, "expiry now works" would be satisfiable by
 * deleting the whole conflict branch.
 */
class IdempotencyWindowTest extends NexusIntegrationTest {

    @Autowired
    IdempotencyService idempotency;

    @Test
    @DisplayName("A recorded answer replays inside its window and stops replaying once the window ends")
    void aCompletedClaimAnswersOnlyInsideItsWindow() {
        String scope = "in-window-" + System.nanoTime();
        String key = scope + "|k1";
        UUID owner = UUID.randomUUID();
        AtomicInteger runs = new AtomicInteger();

        Map<String, Object> first =
                idempotency.run(scope, "k1", owner, () -> Map.of("attempt", runs.incrementAndGet()));
        Map<String, Object> replay =
                idempotency.run(scope, "k1", owner, () -> Map.of("attempt", runs.incrementAndGet()));

        assertThat(first).containsEntry("attempt", 1).doesNotContainKey("idempotent_replay");
        assertThat(replay).as("inside the window the stored answer comes back instead of the work")
                .containsEntry("attempt", 1).containsEntry("idempotent_replay", true);
        assertThat(runs).as("two calls, one execution").hasValue(1);

        age(key);
        Map<String, Object> after =
                idempotency.run(scope, "k1", owner, () -> Map.of("attempt", runs.incrementAndGet()));

        assertThat(after).as("outside the window the key is just a string again — what §1's TTL buys")
                .containsEntry("attempt", 2).doesNotContainKey("idempotent_replay");
        assertThat(runs).as("the second execution is the documented price of retrying an expired key").hasValue(2);
        assertThat(count("select count(*) from idempotency_keys where key = :k", Map.of("k", key)))
                .as("the expired claim was taken over, not accumulated beside a row for the same key")
                .isEqualTo(1);
        assertThat(row("select status, response ->> 'attempt' as attempt from idempotency_keys where key = :k",
                Map.of("k", key)))
                .containsEntry("status", "completed").containsEntry("attempt", "2");
        cleanup(scope);
    }

    @Test
    @DisplayName("A claim abandoned in_progress stops blocking retries at the window; a live one still blocks")
    void anAbandonedClaimIsReclaimableAndALiveOneIsNot() {
        String scope = "abandoned-" + System.nanoTime();
        String key = scope + "|k1";
        UUID owner = UUID.randomUUID();
        insertClaim(key, scope, owner, "in_progress");

        AtomicBoolean ranWhileLive = new AtomicBoolean(false);
        assertThatThrownBy(() -> idempotency.run(scope, "k1", owner, () -> {
            ranWhileLive.set(true);
            return Map.of("executed", true);
        })).isInstanceOfSatisfying(ApiException.class, failure -> {
            assertThat(failure.status()).as("a live claim is still a concurrent request").isEqualTo(409);
            assertThat(failure.code()).isEqualTo("request_in_progress");
        });
        assertThat(ranWhileLive)
                .as("the fix must not steal a live claim — that is the double execution it exists to prevent")
                .isFalse();
        assertThat(row("select status from idempotency_keys where key = :k", Map.of("k", key)))
                .as("a refused retry leaves the original claim untouched").containsEntry("status", "in_progress");

        age(key);
        AtomicBoolean ranAfterExpiry = new AtomicBoolean(false);
        Map<String, Object> taken = idempotency.run(scope, "k1", owner, () -> {
            ranAfterExpiry.set(true);
            return Map.of("executed", true);
        });

        assertThat(ranAfterExpiry).as("the deadline, not a hand-delete, is what frees the key").isTrue();
        assertThat(taken).doesNotContainKey("idempotent_replay");
        assertThat(row("select status, response ->> 'executed' as executed from idempotency_keys where key = :k",
                Map.of("k", key)))
                .as("the reclaimed claim completes normally, so the next retry replays this answer")
                .containsEntry("status", "completed").containsEntry("executed", "true");
        cleanup(scope);
    }

    @Test
    @DisplayName("Another account's key is refused inside the window and free outside it")
    void aCrossAccountCollisionEndsAtTheWindow() {
        String scope = "cross-account-" + System.nanoTime();
        String key = scope + "|k1";
        UUID alice = UUID.randomUUID();
        UUID bob = UUID.randomUUID();
        idempotency.run(scope, "k1", alice, () -> Map.of("by", "alice"));

        AtomicBoolean bobRan = new AtomicBoolean(false);
        assertThatThrownBy(() -> idempotency.run(scope, "k1", bob, () -> {
            bobRan.set(true);
            return Map.of("by", "bob");
        })).isInstanceOfSatisfying(ApiException.class, failure -> {
            assertThat(failure.status()).isEqualTo(409);
            assertThat(failure.code()).isEqualTo("idempotency_key_conflict");
        });
        assertThat(bobRan).as("a key Alice used is not Bob's to replay or to execute").isFalse();
        assertThat(row("select owner_id::text as owner, status from idempotency_keys where key = :k",
                Map.of("k", key)))
                .as("a refusal leaves the claim where it was")
                .containsEntry("owner", alice.toString()).containsEntry("status", "completed");

        age(key);
        assertThat(idempotency.run(scope, "k1", bob, () -> Map.of("by", "bob")))
                .as("D45's contract line — refused until the TTL ends — is only true if the read honours it")
                .containsEntry("by", "bob").doesNotContainKey("idempotent_replay");
        assertThat(row("select owner_id::text as owner, status from idempotency_keys where key = :k",
                Map.of("k", key)))
                .containsEntry("owner", bob.toString()).containsEntry("status", "completed");
        cleanup(scope);
    }

    /** The row {@code run} writes before executing, including the shape a process killed mid-request leaves. */
    private void insertClaim(String key, String scope, UUID owner, String status) {
        jdbc.update("""
                insert into idempotency_keys (key, scope, owner_id, status, response, expires_at)
                values (:key, :scope, :owner, :status, null, now() + interval '1 hour')
                """, Map.of("key", key, "scope", scope, "owner", owner, "status", status));
    }

    private void age(String key) {
        int aged = jdbc.update("update idempotency_keys set expires_at = now() - interval '1 hour' where key = :k",
                Map.of("k", key));
        assertThat(aged).as("the row this test ages must exist — an update matching nothing would pass silently")
                .isEqualTo(1);
    }

    private void cleanup(String scope) {
        jdbc.update("delete from idempotency_keys where scope = :s", Map.of("s", scope));
    }
}
