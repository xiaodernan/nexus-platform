package com.nexus.cloud.events;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.XReadArgs;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * Polling (not pubsub) on purpose: Redis pubsub is ephemeral — a reader booting after the event arrives sees
 * nothing. Polling gives this sidecar a read-your-writes model even on cold start, which is why it belongs here
 * rather than in the platform (the platform writes; this sidecar observes).
 */
@Component
public class EventsReader {

    private static final Logger log = LoggerFactory.getLogger(EventsReader.class);
    private static final String STREAM_KEY = "nexus:events";

    private final boolean enabled;
    private final String url;
    private final Duration pollEvery;
    private final EventsRing ring;
    private final AtomicLong lastOkNanos = new AtomicLong(0L);

    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private String lastId = "0-0";  // Start from the very beginning of the stream.

    public EventsReader(
            @Value("${nexus.events.enabled:true}") boolean enabled,
            @Value("${nexus.events.url:redis://127.0.0.1:6380/0}") String url,
            @Value("${nexus.events.poll-ms:1000}") long pollMs,
            @Value("${nexus.events.ring-size:32}") int ringSize) {
        this.enabled = enabled;
        this.url = url;
        this.pollEvery = Duration.ofMillis(pollMs);
        this.ring = new EventsRing(ringSize);
    }

    /** Called by the scheduled tick below. */
    public void pollOnce() {
        if (!enabled) {
            return;
        }
        try {
            ensureConnection();
            // tiny block so we actually get a chance to see entries without burning the CPU
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
            lastOkNanos.set(System.nanoTime());
        } catch (Exception e) {
            log.warn("events_reader poll_failed reason={}", e.toString());
        }
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
        log.info("events_reader connected url={} stream={}", url, STREAM_KEY);
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
}
