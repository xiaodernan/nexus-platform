package com.nexus.cloud.events;

import io.lettuce.core.Consumer;
import io.lettuce.core.RedisClient;
import io.lettuce.core.XAutoClaimArgs;
import io.lettuce.core.XGroupCreateArgs;
import io.lettuce.core.XReadArgs;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.models.stream.ClaimedMessages;
import io.lettuce.core.models.stream.PendingMessages;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The reader. Polls {@code nexus:events} once per second (tight enough to be useful, loose enough to be free),
 * copies new entries into an in-memory {@link EventsRing}, and exposes:
 *
 * <ul>
 *   <li>{@link #recent()} — the ring's current contents, newest first;
 *   <li>{@link #totalSeen()} — running count since boot;
 *   <li>{@link #isHealthy()} — whether the last poll succeeded recently.</li>
 * </ul>
 *
 * <p><b>D929 (default, {@code groupEnabled=false})</b> reads with bare {@code XREAD} and a process-local
 * {@code lastId}. That is a tail, not a queue: two instances each see EVERY entry, and an entry skipped
 * while the process was down is never revisited. It is honest for an instrumentation sidecar, but it
 * cannot be called reliable messaging.
 *
 * <p><b>D931 ({@code groupEnabled=true}, opt-in)</b> reads through a Redis consumer group instead. The
 * group is created once with {@code XGROUP CREATE … MKSTREAM}; each reader has a distinct consumer name
 * and claims entries with {@code XREADGROUP GROUP <g> <consumer> COUNT n STREAMS nexus:events >}, then
 * {@code XACK}s each entry it pushed into the ring. Consequences, all of them MEASURED by the smoke and
 * the two-instance unit test:
 * <ul>
 *   <li>one entry is DELIVERED to one consumer of the group, not to all of them — two readers sharing a
 *       group split the stream instead of doubling it;</li>
 *   <li>an entry a consumer claimed but did not ACK stays PENDING and can be re-read from {@code 0}
 *       (replay) — a crash does not silently drop it;</li>
 *   <li>{@link #groupState()} reports delivered / acked / pending counts and the group+consumer names,
 *       so the reliability property is observable, not asserted in prose.</li>
 * </ul>
 *
 * <p><b>D950 ({@code claimEnabled=true}, opt-in, OFF by default)</b> closes the seam D931 declared but
 * left open: "no {@code XAUTOCLAIM}/{@code XCLAIM} of a DEAD consumer's pending entries — only a LIVE
 * consumer replays its OWN pending." D931's replay arm reads {@code XREADGROUP … 0}, which returns only
 * THIS consumer's own pending list; an entry owned by a consumer that crashed and never came back stays
 * PENDING forever. D950 adds a THIRD arm to each group poll: {@code XAUTOCLAIM nexus:events <group>
 * <consumer> <minIdleMs> <cursor> COUNT n} transfers pending entries idle longer than
 * {@code claimMinIdleMs} — regardless of which consumer owned them — to THIS live consumer, which pushes
 * them to the ring and {@code XACK}s them. The scan follows the server cursor and is bounded by
 * {@code claimMaxBatches} per poll, so a large or wedged PEL cannot monopolise a tick (OS-friendly:
 * bounded work per scheduling slice). A {@code reclaimed} counter, reported by {@link #groupState()},
 * makes the recovery observable — an operator can see entries rescued from dead consumers.
 *
 * <p>The idle threshold is a HEURISTIC, not failure detection: Redis does not know a consumer is dead,
 * only that its pending entry has been idle. A slow-but-live consumer whose entry exceeds
 * {@code claimMinIdleMs} may have it claimed (duplicate processing) — this is at-least-once, and callers
 * must make ring pushes idempotent (they are keyed by stream id). D950 does NOT fence the old owner,
 * implement a dead-letter queue, or guarantee ordering. Group mode is still OFF by default, and D950
 * only runs when BOTH group mode AND claim mode are enabled; neither D929's tail nor D931's group path
 * changes byte-for-byte for a deployment that does not opt in. Polling (not pubsub) on purpose: Redis
 * pubsub is ephemeral — a reader booting after the event arrives sees nothing; polling gives this sidecar
 * a read-your-writes model even on cold start.
 */
@Component
public class EventsReader {

    private static final Logger log = LoggerFactory.getLogger(EventsReader.class);
    private static final String STREAM_KEY = "nexus:events";
    private static final String PENDING_OFFSET = "0";   // re-read this consumer's unacked entries
    private static final String NEW_OFFSET = ">";       // claim entries never delivered to the group
    private static final String CLAIM_CURSOR_START = "0-0"; // D950: first cursor of an XAUTOCLAIM sweep
    private static final int CLAIM_MAX_BATCHES_HARD_CAP = 64; // D950: never scan more than this per poll

    private final boolean enabled;
    private final String url;
    private final Duration pollEvery;
    private final EventsRing ring;
    private final Counter pollTicks;
    private final Counter pollFailures;
    private final boolean groupEnabled;
    private final String groupName;
    private final String consumerName;
    // D950: dead-consumer pending reclamation (all inert unless group AND claim mode are on).
    private final boolean claimEnabled;
    private final long claimMinIdleMs;
    private final long claimBatchSize;
    private final int claimMaxBatches;
    private final AtomicLong lastOkNanos = new AtomicLong(0L);
    private final AtomicLong acked = new AtomicLong();
    private final AtomicLong delivered = new AtomicLong();
    private final AtomicLong reclaimed = new AtomicLong(); // D950: entries rescued from a DEAD consumer's PEL

    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private String lastId = "0-0";  // D929 bare-tail cursor; unused in group mode.
    private boolean groupReady = false;

    /** Spring must use THIS constructor: the legacy shapes below exist only for existing callers/tests,
     *  and with several constructors and no @Autowired the container falls back to a nonexistent no-arg
     *  one (the exact D931 defect). D939 injects the MeterRegistry explicitly, not via field injection,
     *  so every claim about the meters can be asserted against a SimpleMeterRegistry. D950 adds the four
     *  claim parameters; all are inert unless groupEnabled is also true, and claimEnabled defaults false
     *  so D929's tail and D931's group path ship byte-for-byte. */
    @Autowired
    public EventsReader(
            @Value("${nexus.events.enabled:true}") boolean enabled,
            @Value("${nexus.events.url:redis://127.0.0.1:6380/0}") String url,
            @Value("${nexus.events.poll-ms:1000}") long pollMs,
            @Value("${nexus.events.ring-size:32}") int ringSize,
            @Value("${nexus.events.group-enabled:false}") boolean groupEnabled,
            @Value("${nexus.events.group-name:nexus-events-readers}") String groupName,
            @Value("${nexus.events.consumer-name:}") String consumerName,
            @Value("${nexus.events.claim-enabled:false}") boolean claimEnabled,
            @Value("${nexus.events.claim-min-idle-ms:60000}") long claimMinIdleMs,
            @Value("${nexus.events.claim-batch-size:50}") long claimBatchSize,
            @Value("${nexus.events.claim-max-batches:8}") int claimMaxBatches,
            MeterRegistry meters) {
        this.enabled = enabled;
        this.url = url;
        this.pollEvery = Duration.ofMillis(pollMs);
        this.ring = new EventsRing(ringSize);
        this.groupEnabled = groupEnabled;
        this.groupName = groupName;
        // A stable, distinct consumer per process: explicit config wins, else a UUID. Two readers with
        // the same consumer name would silently share a pending list — that is a misconfiguration this
        // default makes impossible.
        this.consumerName = (consumerName == null || consumerName.isBlank())
                ? UUID.randomUUID().toString() : consumerName;
        // D950: validate the bounded-work knobs once at construction. A non-positive batch or a max
        // outside [1, HARD_CAP] would either busy-loop or unbound a tick; fail fast instead.
        this.claimEnabled = claimEnabled;
        this.claimMinIdleMs = Math.max(0L, claimMinIdleMs);
        this.claimBatchSize = claimBatchSize < 1L ? 1L : claimBatchSize;
        this.claimMaxBatches = claimMaxBatches < 1 ? 1
                : Math.min(claimMaxBatches, CLAIM_MAX_BATCHES_HARD_CAP);
        this.pollTicks = Counter.builder("nexus.events.poll.ticks")
                .description("pollOnce() attempts on an enabled reader (disabled readers never tick)")
                .register(meters);
        this.pollFailures = Counter.builder("nexus.events.poll.failures")
                .description("pollOnce() attempts that threw and were swallowed after logging")
                .tag("mode", groupEnabled ? "group" : "tail")
                .register(meters);
        Gauge.builder("nexus.events.ring.evictions", ring, EventsRing::evictions)
                .description("entries the bounded ring evicted at its cap; the overload signal")
                .baseUnit("evictions")
                .register(meters);
    }

    /** D931/D939 constructor shape kept verbatim: existing callers and test sites that pass the
     *  MeterRegistry directly get claim mode OFF. Spring wires the @Autowired 12-arg constructor above. */
    public EventsReader(boolean enabled, String url, long pollMs, int ringSize,
                        boolean groupEnabled, String groupName, String consumerName,
                        MeterRegistry meters) {
        this(enabled, url, pollMs, ringSize, groupEnabled, groupName, consumerName,
                false, 60000L, 50L, 8, meters);
    }

    /** D931 constructor shape kept: existing callers and test sites that pass 7 args build their own
     *  (discarded) SimpleMeterRegistry; Spring wires the @Autowired 12-arg constructor above. */
    public EventsReader(boolean enabled, String url, long pollMs, int ringSize,
                        boolean groupEnabled, String groupName, String consumerName) {
        this(enabled, url, pollMs, ringSize, groupEnabled, groupName, consumerName,
                new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
    }

    /** D929 constructor kept verbatim: seven existing tests and every caller that builds a tail reader. */
    public EventsReader(boolean enabled, String url, long pollMs, int ringSize) {
        this(enabled, url, pollMs, ringSize, false, "nexus-events-readers", "",
                new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
    }

    /** Called by the scheduled tick below. */
    public void pollOnce() {
        if (!enabled) {
            return;
        }
        pollTicks.increment();
        try {
            ensureConnection();
            if (groupEnabled) {
                pollGroup();
            } else {
                pollTail();
            }
            lastOkNanos.set(System.nanoTime());
        } catch (Exception e) {
            pollFailures.increment();
            log.warn("events_reader poll_failed group={} reason={}", groupEnabled, e.toString());
        }
    }

    /* --------------------------------------------------------------- D929: bare XREAD tail */
    private void pollTail() {
        XReadArgs args = new XReadArgs().count(50).block(Duration.ofMillis(50));
        XReadArgs.StreamOffset<String> offset = XReadArgs.StreamOffset.from(STREAM_KEY, lastId);
        List<io.lettuce.core.StreamMessage<String, String>> messages = connection.sync().xread(args, offset);
        if (messages != null && !messages.isEmpty()) {
            for (io.lettuce.core.StreamMessage<String, String> msg : messages) {
                ring.push(msg.getId(), msg.getBody());
                lastId = msg.getId();
            }
            log.debug("events_reader consumed {} entr(y/ies), lastId={}", messages.size(), lastId);
        }
    }

    /* --------------------------------------------------------------- D931: consumer group */
    private void ensureGroup() {
        if (groupReady) {
            return;
        }
        try {
            // MKSTREAM creates nexus:events if the producer has not written yet. BUSYGROUP (the group
            // already exists) is the normal case on restart and is deliberately swallowed.
            connection.sync().xgroupCreate(
                    XReadArgs.StreamOffset.from(STREAM_KEY, PENDING_OFFSET),
                    groupName, XGroupCreateArgs.Builder.mkstream());
            log.info("events_reader group created stream={} group={}", STREAM_KEY, groupName);
        } catch (io.lettuce.core.RedisCommandExecutionException e) {
            if (!String.valueOf(e.getMessage()).contains("BUSYGROUP")) {
                throw e;
            }
        }
        groupReady = true;
    }

    private void pollGroup() {
        ensureGroup();
        Consumer<String> me = Consumer.from(groupName, consumerName);
        XReadArgs args = new XReadArgs().count(50).block(Duration.ofMillis(50));
        // 1) Replay: entries THIS consumer claimed before but never ack'd (e.g. it died mid-batch).
        //    XREADGROUP ... 0 reads only this consumer's own pending list. Processing one here and
        //    ACK-ing it is what drains the PEL — so a crash is recovered, not replayed forever.
        drain(me, args, XReadArgs.StreamOffset.from(STREAM_KEY, PENDING_OFFSET));
        // 2) New: entries never yet delivered to ANY consumer in the group — the at-most-once split.
        drain(me, args, XReadArgs.StreamOffset.from(STREAM_KEY, NEW_OFFSET));
        // 3) D950: reclaim entries idle past the threshold that a DEAD/stalled consumer left pending.
        //    BOTH flags must be on; the guard keeps D931's group path byte-for-byte when claim is off.
        if (groupEnabled && claimEnabled) {
            reclaimDeadPending(me);
        }
    }

    /** D950 — the third arm. {@code XAUTOCLAIM} walks the group's PEL and transfers entries whose idle
     *  time exceeds {@code claimMinIdleMs} to THIS consumer, no matter who owned them. We push each to
     *  the ring, bump delivered + reclaimed, then XACK it (ACK only after a successful push, so a push
     *  failure leaves it pending for a later sweep). The scan FOLLOWS the server cursor and is bounded
     *  by {@code claimMaxBatches} × {@code claimBatchSize} per poll, so a wedged/large PEL cannot starve
     *  the other two arms — bounded work per scheduling slice. An empty batch or the {@code 0-0} cursor
     *  ends the sweep. We stop early on ANY error: reclaim is best-effort, never fatal to the poll. */
    private void reclaimDeadPending(Consumer<String> me) {
        String cursor = CLAIM_CURSOR_START;
        for (int batch = 0; batch < claimMaxBatches; batch++) {
            XAutoClaimArgs<String> claimArgs = XAutoClaimArgs.Builder
                    .xautoclaim(me, claimMinIdleMs, cursor)
                    .count(claimBatchSize);
            ClaimedMessages<String, String> claimed = connection.sync().xautoclaim(STREAM_KEY, claimArgs);
            List<io.lettuce.core.StreamMessage<String, String>> messages = claimed.getMessages();
            if (messages == null || messages.isEmpty()) {
                return; // nothing idle past the threshold — the normal steady-state case
            }
            for (io.lettuce.core.StreamMessage<String, String> msg : messages) {
                ring.push(msg.getId(), msg.getBody());
                delivered.incrementAndGet();
                reclaimed.incrementAndGet();
                Long n = connection.sync().xack(STREAM_KEY, groupName, msg.getId());
                if (n != null && n > 0) {
                    acked.incrementAndGet();
                }
            }
            String next = claimed.getId();
            // Redis returns "0-0" when the PEL scan is exhausted; a repeated cursor means no progress.
            if (next == null || CLAIM_CURSOR_START.equals(next) || next.equals(cursor)) {
                return;
            }
            cursor = next;
        }
        // Bounded out: more than claimMaxBatches batches remain. The next poll continues the sweep;
        // a permanently wedged PEL is visible as a non-zero `pending` in groupState(), not hidden here.
    }

    /** Claim one batch at the given offset; push each to the ring, then ACK it. */
    private void drain(Consumer<String> me, XReadArgs args,
                       XReadArgs.StreamOffset<String> offset) {
        List<io.lettuce.core.StreamMessage<String, String>> messages =
                connection.sync().xreadgroup(me, args, offset);
        if (messages == null || messages.isEmpty()) {
            return;
        }
        for (io.lettuce.core.StreamMessage<String, String> msg : messages) {
            ring.push(msg.getId(), msg.getBody());
            delivered.incrementAndGet();
            // ACK only AFTER the entry is safely in the ring: a push failure throws out of pollOnce's
            // try/catch, the entry stays pending, and the next poll's replay arm re-reads it. That is
            // the at-least-once recovery bound; the group split gives at-most-once across consumers.
            Long n = connection.sync().xack(STREAM_KEY, groupName, msg.getId());
            if (n != null && n > 0) {
                acked.incrementAndGet();
            }
        }
        log.debug("events_reader group consumed {} entr(y/ies) offset={} group={} consumer={}",
                messages.size(), offset.getOffset(), groupName, consumerName);
    }

    private void ensureConnection() {
        if (connection != null) {
            return;
        }
        client = RedisClient.create(url);
        client.setOptions(io.lettuce.core.ClientOptions.builder()
                .autoReconnect(true)
                .disconnectedBehavior(io.lettuce.core.ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                .build());
        connection = client.connect();
        connection.sync().ping();
        groupReady = false; // a reconnect may have lost the server-side group; re-assert it
        log.info("events_reader connected url={} stream={} group={} enabled={}",
                url, STREAM_KEY, groupName, groupEnabled);
    }

    public Map<String, Map<String, String>> recent() {
        return ring.snapshot();
    }

    public long totalSeen() {
        return ring.totalSeen();
    }

    public long buffered() {
        return ring.size();
    }

    /** D931: observable reliability state — the group property is measured, not asserted in prose. */
    public Map<String, Object> groupState() {
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("enabled", groupEnabled);
        out.put("group", groupName);
        out.put("consumer", consumerName);
        out.put("delivered", delivered.get());
        out.put("acked", acked.get());
        // D950: observable recovery. `reclaimed` counts entries taken from a DEAD consumer's PEL;
        // `claim_*` makes the opt-in knob and its threshold visible, so "is rescue running?" is a
        // question a dashboard can answer, not prose. All are inert (reclaimed=0) when claim is off.
        out.put("reclaimed", reclaimed.get());
        out.put("claim_enabled", claimEnabled);
        out.put("claim_min_idle_ms", claimMinIdleMs);
        if (groupEnabled && connection != null && groupReady) {
            try {
                PendingMessages pm = connection.sync().xpending(STREAM_KEY, groupName);
                out.put("pending", pm.getCount());
            } catch (Exception e) {
                out.put("pending", "unavailable:" + e.getClass().getSimpleName());
            }
        } else {
            out.put("pending", 0L); // not a claim about the stream; group mode is off
        }
        return out;
    }

    public boolean isGroupEnabled() {
        return groupEnabled;
    }

    /** D950: entries reclaimed from a DEAD consumer's pending list since boot. 0 when claim is off. */
    public long reclaimedCount() {
        return reclaimed.get();
    }

    /** D950: the configured idle threshold in millis — the harness asserts the min-idle gate with it. */
    public long claimMinIdleMs() {
        return claimMinIdleMs;
    }

    public Duration sinceLastOk() {
        long ns = lastOkNanos.get();
        return ns == 0L ? Duration.ZERO.plusMillis(-1) : Duration.ofNanos(System.nanoTime() - ns);
    }

    public boolean isHealthy() {
        long ns = lastOkNanos.get();
        return ns != 0L && (System.nanoTime() - ns) < Duration.ofSeconds(30).toNanos();
    }

    public Duration pollFrequency() {
        return pollEvery;
    }

    /** Test/probe hook: release the Lettuce connection so a second instance can bind a fresh group state. */
    public void closeQuietly() {
        try {
            if (connection != null) connection.close();
            if (client != null) client.shutdown();
        } catch (Exception ignored) {
            // best effort
        }
        connection = null;
        client = null;
        groupReady = false;
    }
}
