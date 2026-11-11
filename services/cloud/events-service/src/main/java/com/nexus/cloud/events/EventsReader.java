package com.nexus.cloud.events;

import io.lettuce.core.Consumer;
import io.lettuce.core.RedisClient;
import io.lettuce.core.XGroupCreateArgs;
import io.lettuce.core.XReadArgs;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.models.stream.PendingMessages;
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
 * <p>Group mode is OFF by default: D929's tail semantics, its smoke and its seven tests are unchanged,
 * and a deployment that does not opt in pays nothing. Polling (not pubsub) on purpose: Redis pubsub is
 * ephemeral — a reader booting after the event arrives sees nothing; polling gives this sidecar a
 * read-your-writes model even on cold start.
 */
@Component
public class EventsReader {

    private static final Logger log = LoggerFactory.getLogger(EventsReader.class);
    private static final String STREAM_KEY = "nexus:events";
    private static final String PENDING_OFFSET = "0";   // re-read this consumer's unacked entries
    private static final String NEW_OFFSET = ">";       // claim entries never delivered to the group

    private final boolean enabled;
    private final String url;
    private final Duration pollEvery;
    private final EventsRing ring;
    private final boolean groupEnabled;
    private final String groupName;
    private final String consumerName;
    private final AtomicLong lastOkNanos = new AtomicLong(0L);
    private final AtomicLong acked = new AtomicLong();
    private final AtomicLong delivered = new AtomicLong();

    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private String lastId = "0-0";  // D929 bare-tail cursor; unused in group mode.
    private boolean groupReady = false;

    /** Spring must use THIS constructor: the 4-arg one below exists only for D929-era unit tests, and
     *  with two constructors and no @Autowired the container falls back to a nonexistent no-arg one. */
    @Autowired
    public EventsReader(
            @Value("${nexus.events.enabled:true}") boolean enabled,
            @Value("${nexus.events.url:redis://127.0.0.1:6380/0}") String url,
            @Value("${nexus.events.poll-ms:1000}") long pollMs,
            @Value("${nexus.events.ring-size:32}") int ringSize,
            @Value("${nexus.events.group-enabled:false}") boolean groupEnabled,
            @Value("${nexus.events.group-name:nexus-events-readers}") String groupName,
            @Value("${nexus.events.consumer-name:}") String consumerName) {
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
    }

    /** D929 constructor kept verbatim: seven existing tests and every caller that builds a tail reader. */
    public EventsReader(boolean enabled, String url, long pollMs, int ringSize) {
        this(enabled, url, pollMs, ringSize, false, "nexus-events-readers", "");
    }

    /** Called by the scheduled tick below. */
    public void pollOnce() {
        if (!enabled) {
            return;
        }
        try {
            ensureConnection();
            if (groupEnabled) {
                pollGroup();
            } else {
                pollTail();
            }
            lastOkNanos.set(System.nanoTime());
        } catch (Exception e) {
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
