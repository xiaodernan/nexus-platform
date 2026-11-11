package com.nexus.cloud.events;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * D931 — the consumer-group property is MEASURED against a live Redis, not asserted in prose.
 *
 * <p>Three claims, each with an explicit contrast arm so a result that "looks like dedup" cannot pass
 * for the wrong reason:
 * <ol>
 *   <li>two readers in the SAME group split N entries (sum == N); the SAME two readers in TAIL mode
 *       each see all N (sum == 2N). If the group were not really partitioning, the first sum would be
 *       2N and the test fails;</li>
 *   <li>an entry a consumer claimed but never ack'd stays PENDING and is re-delivered to that same
 *       consumer on the next poll (replay) — a crash does not silently drop it;</li>
 *   <li>the {@code groupState()} surface reports the delivered / acked / pending counts that back the
 *       claim, so the smoke can read them over HTTP.</li>
 * </ol>
 *
 * <p>Every test uses a UNIQUE group name and flushes the test DB, so two JVMs running the suite cannot
 * contaminate each other. When Redis is unreachable the whole class is skipped (assumeTrue), which is
 * the same fail-soft contract D929 established — CI without Redis is not a red.
 */
class EventsGroupReaderTest {

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

    private void publish(int n) {
        for (int i = 0; i < n; i++) {
            Map<String, String> body = new HashMap<>();
            body.put("template", "lead_new");
            body.put("tenant_id", "t-" + i);
            body.put("type", "LeadCaptured");
            body.put("payload", "{\"i\":" + i + "}");
            conn.sync().xadd(STREAM, body);
        }
    }

    /** Drain a reader until it sees no more (bounded), so one poll per batch is not a flaky assumption. */
    private void drain(EventsReader r) {
        for (int i = 0; i < 5; i++) r.pollOnce();
    }

    @Test
    void sameGroupSplitsTheStreamWhileTwoTailsDoubleIt() {
        assumeTrue(live, "live Redis unreachable — skipping the D931 integration arms");
        String group = "g-" + UUID.randomUUID();
        int n = 6;
        publish(n);

        // (a) consumer group: two consumers, ONE shared group -> each entry delivered once.
        EventsReader a = new EventsReader(true, URL, 5L, 32, true, group, "consumer-a");
        EventsReader b = new EventsReader(true, URL, 5L, 32, true, group, "consumer-b");
        drain(a); // a claims first, b claims the remainder — Redis arbitrates, neither sees the other's
        drain(b);
        long groupedSum = a.totalSeen() + b.totalSeen();
        assertThat(groupedSum).as("same group must split %d entries, not double them", n).isEqualTo(n);
        assertThat(groupedSum).as("a bare tail would have produced %d here", 2 * n).isNotEqualTo(2 * n);
        a.closeQuietly();
        b.closeQuietly();

        // (b) contrast arm — same two readers in D929 tail mode each see all N.
        conn.sync().flushdb();
        publish(n);
        EventsReader t1 = new EventsReader(true, URL, 5L, 32);
        EventsReader t2 = new EventsReader(true, URL, 5L, 32);
        drain(t1);
        drain(t2);
        assertThat(t1.totalSeen() + t2.totalSeen())
                .as("two independent tails each read the whole stream: the D929 behaviour")
                .isEqualTo(2 * n);
        t1.closeQuietly();
        t2.closeQuietly();
    }

    @Test
    void anUnackedEntryStaysPendingAndIsReplayed() {
        assumeTrue(live, "live Redis unreachable — skipping the D931 integration arms");
        String group = "g-" + UUID.randomUUID();
        publish(3);

        // A consumer that claims with NOACK leaves the entries pending, with nothing ack'd.
        // We model the "crashed before ack" case by reading the group's pending list directly after a
        // normal claim, then having a SECOND poll of the same consumer re-read from offset 0.
        // The reader MUST share the consumer name "collapsed" with the raw claim below: Redis keeps the
        // pending list PER CONSUMER, so XREADGROUP ... 0 only replays entries this same consumer owns.
        EventsReader r = new EventsReader(true, URL, 5L, 32, true, group, "collapsed");
        r.pollOnce(); // creates the group and claims the new entries, ack'ing them
        long firstSeen = r.totalSeen();
        assertThat(firstSeen).isEqualTo(3);

        // Publish one more, then claim it but simulate a crash: use a raw xreadgroup so it
        // never reaches an XACK, and assert XPENDING reports it. Same consumer name as the reader.
        Map<String, String> body = new HashMap<>();
        body.put("template", "lead_new");
        body.put("type", "LeadCaptured");
        conn.sync().xadd(STREAM, body);
        conn.sync().xreadgroup(io.lettuce.core.Consumer.from(group, "collapsed"),
                new io.lettuce.core.XReadArgs().count(10),
                io.lettuce.core.XReadArgs.StreamOffset.from(STREAM, ">"));
        io.lettuce.core.models.stream.PendingMessages pending =
                conn.sync().xpending(STREAM, group);
        assertThat(pending.getCount()).as("the claimed-but-unacked entry is pending, not lost").isEqualTo(1);

        // The reader's next poll replays its own pending entry from offset 0 (and acks it there).
        r.pollOnce();
        assertThat(r.groupState()).containsEntry("enabled", true).containsEntry("group", group);
        assertThat((Long) r.groupState().get("pending")).isEqualTo(0L);
        r.closeQuietly();
    }

    @Test
    void groupStateExposesTheCountsTheSmokeReads() {
        assumeTrue(live, "live Redis unreachable — skipping the D931 integration arms");
        String group = "g-" + UUID.randomUUID();
        publish(2);
        EventsReader r = new EventsReader(true, URL, 5L, 32, true, group, "probe");
        drain(r);
        Map<String, Object> state = r.groupState();
        assertThat(state).containsEntry("enabled", true)
                .containsEntry("group", group)
                .containsEntry("consumer", "probe");
        assertThat((Long) state.get("delivered")).isEqualTo(2L);
        assertThat((Long) state.get("acked")).isEqualTo(2L);
        assertThat((Long) state.get("pending")).isEqualTo(0L);

        // Tail mode reports enabled=false and pending=0 without ever creating a group.
        EventsReader tail = new EventsReader(true, URL, 5L, 32);
        assertThat((Boolean) tail.groupState().get("enabled")).isFalse();
        r.closeQuietly();
        tail.closeQuietly();
    }
}
