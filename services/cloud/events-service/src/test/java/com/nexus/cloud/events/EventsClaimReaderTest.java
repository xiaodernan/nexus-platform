package com.nexus.cloud.events;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.lettuce.core.Consumer;
import io.lettuce.core.RedisClient;
import io.lettuce.core.XReadArgs;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.models.stream.PendingMessages;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * D950 — dead-consumer pending reclamation is MEASURED against a live Redis, not asserted in prose.
 *
 * <p>D931's replay arm ({@code XREADGROUP … 0}) only drains THIS consumer's own pending list, so an entry
 * owned by a consumer that crashed and never returned stays PENDING forever. D950 adds an opt-in
 * {@code XAUTOCLAIM} arm that transfers entries idle past a threshold from ANY consumer to this reader.
 * Four claims, each with a contrast arm so a result that "looks like recovery" cannot pass for the
 * wrong reason:
 * <ol>
 *   <li>a reader with claim ON reclaims N entries stranded under a DEAD consumer's name (PEL N -> 0,
 *       reclaimed == N, totalSeen == N); the SAME setup with claim OFF (D931) leaves all N stranded;</li>
 *   <li>the min-idle threshold is load-bearing: with a huge threshold a FRESH pending entry is NOT
 *       stolen (reclaimed == 0, PEL stays N) — so a merely slow, still-live consumer is not robbed;</li>
 *   <li>bounding: with a small batch and more entries than one batch, repeated polls drain the whole
 *       PEL (the cursor is followed, not re-scanned);</li>
 *   <li>{@code groupState()} exposes reclaimed / claim_enabled / claim_min_idle_ms so the property is
 *       observable over HTTP, and the knobs are inert when group mode is off.</li>
 * </ol>
 *
 * <p>Every test uses a UNIQUE group name and flushes the test DB, so two JVMs running the suite cannot
 * contaminate each other. When Redis is unreachable the class skips (assumeTrue) — the same fail-soft
 * contract D929/D931 established. The 12-arg constructor is used directly with a discarded
 * SimpleMeterRegistry; Spring wires that same constructor with real {@code @Value} defaults.
 */
class EventsClaimReaderTest {

    private static final String URL = "redis://127.0.0.1:6380/0";
    private static final String STREAM = "nexus:events";

    private RedisClient probe;
    private StatefulRedisConnection<String, String> conn;
    private boolean live;

    @BeforeEach
    void setUp() {
        probe = RedisClient.create(URL);
        try {
            conn = probe.connect();
            conn.sync().ping();
            conn.sync().flushdb();
            live = true;
        } catch (Exception e) {
            live = false;
        }
    }

    @AfterEach
    void tearDown() {
        try { if (live) conn.sync().flushdb(); } catch (Exception ignored) { }
        try { if (conn != null) conn.close(); } catch (Exception ignored) { }
        probe.shutdown();
    }

    private String newGroup() {
        String g = "g-" + UUID.randomUUID();
        conn.sync().xgroupCreate(XReadArgs.StreamOffset.from(STREAM, "0"), g,
                io.lettuce.core.XGroupCreateArgs.Builder.mkstream());
        return g;
    }

    /** Publish n entries, then have a consumer named "dead-consumer" claim ALL of them with a raw
     *  XREADGROUP and NEVER ack — modelling a process that crashed between claim and ack. Returns the
     *  number left pending (must equal n). */
    private long strandUnderDeadConsumer(String group, int n) {
        for (int i = 0; i < n; i++) {
            Map<String, String> body = new HashMap<>();
            body.put("template", "lead_new");
            body.put("tenant_id", "t-" + i);
            body.put("type", "LeadCaptured");
            body.put("payload", "{\"i\":" + i + "}");
            conn.sync().xadd(STREAM, body);
        }
        conn.sync().xreadgroup(Consumer.from(group, "dead-consumer"),
                new XReadArgs().count(100), XReadArgs.StreamOffset.from(STREAM, ">"));
        return conn.sync().xpending(STREAM, group).getCount();
    }

    private long pending(String group) {
        return conn.sync().xpending(STREAM, group).getCount();
    }

    private EventsReader reader(String group, String consumer, boolean claimEnabled,
                                long minIdleMs, long batchSize, int maxBatches) {
        return new EventsReader(true, URL, 5L, 64,
                true, group, consumer, claimEnabled, minIdleMs, batchSize, maxBatches,
                new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
    }

    @Test
    void claimOnReclaimsDeadPendingWhileClaimOffLeavesItStranded() {
        assumeTrue(live, "live Redis unreachable — skipping the D950 integration arms");
        int n = 6;

        // (a) claim ON: the live consumer rescues every entry the dead one left pending.
        String g1 = newGroup();
        long stranded = strandUnderDeadConsumer(g1, n);
        assertThat(stranded).as("premise: the dead consumer left all %d entries pending", n).isEqualTo(n);
        EventsReader live1 = reader(g1, "rescuer", true, 0L, 50L, 8);
        live1.pollOnce();
        assertThat(live1.reclaimedCount()).as("all %d stranded entries were reclaimed", n).isEqualTo(n);
        assertThat(live1.totalSeen()).as("the ring saw each rescued entry once").isEqualTo(n);
        assertThat((Long) live1.groupState().get("pending")).as("the PEL is drained").isEqualTo(0L);
        assertThat(pending(g1)).as("XPENDING agrees the PEL is empty").isEqualTo(0L);
        live1.closeQuietly();

        // (b) contrast arm — claim OFF (D931 behaviour): XREADGROUP … 0 reads only OUR OWN pending,
        //     so the dead consumer's entries stay pending forever. This is the seam D950 closes.
        conn.sync().flushdb();
        String g2 = newGroup();
        long stranded2 = strandUnderDeadConsumer(g2, n);
        assertThat(stranded2).isEqualTo(n);
        EventsReader live2 = reader(g2, "rescuer", false, 0L, 50L, 8);
        live2.pollOnce();
        live2.pollOnce();
        assertThat(live2.reclaimedCount()).as("claim OFF reclaims nothing").isEqualTo(0L);
        assertThat(live2.totalSeen()).as("claim OFF cannot see the dead consumer's entries").isEqualTo(0L);
        assertThat(pending(g2)).as("D931: the dead consumer's %d entries stay PENDING", n).isEqualTo(n);
        live2.closeQuietly();
    }

    @Test
    void theMinIdleThresholdProtectsAFreshlyPendingEntry() {
        assumeTrue(live, "live Redis unreachable — skipping the D950 integration arms");
        int n = 4;
        String g = newGroup();
        assertThat(strandUnderDeadConsumer(g, n)).isEqualTo(n);

        // A huge min-idle means a just-claimed entry is NOT idle enough to steal. Redis returns the
        // 0-0 cursor with an empty batch (measured on the wire), so reclaimed stays 0 and the PEL holds.
        EventsReader r = reader(g, "rescuer", true, 600_000L, 50L, 8);
        r.pollOnce();
        assertThat(r.reclaimedCount()).as("a fresh pending entry must not be stolen (slow-but-live consumer)").isEqualTo(0L);
        assertThat(pending(g)).as("the PEL is untouched when the entry is younger than min-idle").isEqualTo(n);
        r.closeQuietly();
    }

    @Test
    void aBoundedBatchStillDrainsTheWholePelAcrossPolls() {
        assumeTrue(live, "live Redis unreachable — skipping the D950 integration arms");
        int n = 7;
        String g = newGroup();
        assertThat(strandUnderDeadConsumer(g, n)).isEqualTo(n);

        // batch=2, maxBatches=1: one poll moves at most 2 entries; repeated polls follow the cursor and
        // finish the job. This proves the bound is a per-tick work cap, not a loss of the remaining PEL.
        EventsReader r = reader(g, "rescuer", true, 0L, 2L, 1);
        for (int i = 0; i < 10 && pending(g) > 0; i++) {
            r.pollOnce();
        }
        assertThat(pending(g)).as("repeated bounded sweeps drain the entire PEL").isEqualTo(0L);
        assertThat(r.reclaimedCount()).isEqualTo(n);
        assertThat(r.totalSeen()).isEqualTo(n);
        r.closeQuietly();
    }

    @Test
    void groupStateExposesTheClaimKnobsAndIsInertWhenGroupIsOff() {
        assumeTrue(live, "live Redis unreachable — skipping the D950 integration arms");
        int n = 3;
        String g = newGroup();
        assertThat(strandUnderDeadConsumer(g, n)).isEqualTo(n);

        // Recovery: min-idle 0 so the FRESH stranded entries qualify; the reclaimed counter becomes
        // observable in groupState(). Using a non-zero min-idle here would correctly refuse them.
        EventsReader r = reader(g, "rescuer", true, 0L, 50L, 8);
        r.pollOnce();
        Map<String, Object> state = r.groupState();
        assertThat((Long) state.get("reclaimed")).isEqualTo((long) n);
        assertThat(state).containsEntry("claim_enabled", true)
                .containsEntry("claim_min_idle_ms", 0L);
        r.closeQuietly();

        // The knobs reflect a NON-default configuration even on a reader that never polled (no Redis
        // contact): groupState reports what the operator configured, not a hardcoded constant.
        EventsReader knobbed = reader(g, "knobbed", true, 4321L, 50L, 8);
        assertThat(knobbed.groupState()).containsEntry("claim_enabled", true)
                .containsEntry("claim_min_idle_ms", 4321L);
        assertThat(knobbed.reclaimedCount()).isEqualTo(0L);
        knobbed.closeQuietly();

        // Group mode OFF: claim knobs are inert, no group created, reclaimed stays 0.
        EventsReader tail = new EventsReader(true, URL, 5L, 32);
        assertThat((Boolean) tail.groupState().get("claim_enabled")).isFalse();
        assertThat((Boolean) tail.groupState().get("enabled")).isFalse();
        tail.closeQuietly();
    }
}
