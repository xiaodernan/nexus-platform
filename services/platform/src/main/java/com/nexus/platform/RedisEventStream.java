package com.nexus.platform;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nexus.notification.event.DomainEvents;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * An OPTIONAL Redis Streams bridge from the in-process {@code ApplicationEventPublisher} events
 * (mostly {@code DomainEvent}s in {@code notification/event/DomainEvents}) to anything on this plane
 * that can read {@code XREAD}.
 *
 * <p>Behaviour:
 * <ul>
 *   <li>{@code nexus.events.redis-stream-enabled=false} (default): NO Redis client is constructed,
 *       the class is present but {@link #isEnabled()} is {@code false} — every {@code publish(...)}
 *       is a benign no-op. This matches the plane's pattern: zero surprise cost unless a deployment
 *       opts in.</li>
 *   <li>{@code nexus.events.redis-stream-enabled=true} + reachable Redis: events are {@code XADD}-ed
 *       to {@code nexus:events} with the body serialised to JSON; the stream is trimmed to the
 *       configured {@code nexus.events.max-len} (approximate, using {@code XADD ... MAXLEN ~ N})
 *       so a wedged consumer cannot grow the stream indefinitely.</li>
 *   <li>Redis unreachable or errors during {@code XADD}: publish logs a warning and returns; the
 *       business operation is never failed. Exactly the same fail-soft rule as the notification
 *       listener: a notification failure can never roll back a commerce action.</li>
 * </ul>
 *
 * <p>Not a production-grade broker (no consumer groups, no acks, no retention policy split
 * between tenants, no idempotency guard on consumer side). It exists to provide a real wire
 * path for domain events on this plane, and it is bounded explicitly.
 */
@Component
public class RedisEventStream {

    private static final Logger log = LoggerFactory.getLogger(RedisEventStream.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String STREAM_KEY = "nexus:events";

    private final String url;
    private final boolean streamEnabled;
    private final long maxLen;
    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;

    public RedisEventStream(@Value("${nexus.events.redis-stream-enabled:false}") boolean streamEnabled,
                           @Value("${nexus.redis.url:redis://127.0.0.1:6380/0}") String url,
                           @Value("${nexus.events.max-len:1000}") long maxLen) {
        this.streamEnabled = streamEnabled;
        this.url = url;
        this.maxLen = maxLen;
    }

    /** Whether the bridge is live for this instance. Callers may branch on it if they want to know. */
    public boolean isEnabled() {
        return streamEnabled && connection != null;
    }

    @PostConstruct
    public void init() {
        if (!streamEnabled) {
            log.info("events_stream disabled (nexus.events.redis-stream-enabled=false)");
            return;
        }
        try {
            client = RedisClient.create(url);
            client.setOptions(io.lettuce.core.ClientOptions.builder()
                    .autoReconnect(true)
                    .disconnectedBehavior(io.lettuce.core.ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                    .build());
            connection = client.connect();
            connection.sync().ping();
            log.info("events_stream enabled stream={} url={}", STREAM_KEY, url);
        } catch (Exception e) {
            log.warn("events_stream disabled reason=redis_unreachable url={} message={}", url, e.getMessage());
            closeQuietly();
        }
    }

    @PreDestroy
    public void shutdown() {
        closeQuietly();
    }

    private void closeQuietly() {
        try {
            if (connection != null) {
                connection.close();
            }
            if (client != null) {
                client.shutdown();
            }
        } catch (Exception ignored) {
            // best effort
        }
        connection = null;
        client = null;
    }

    /**
     * Publish one event to {@code nexus:events}. Logs at warn level and returns on any failure;
     * never throws.
     */
    public boolean publish(DomainEvents.NexusDomainEvent event) {
        StatefulRedisConnection<String, String> conn = connection;
        if (!streamEnabled || conn == null) {
            return false;
        }
        try {
            String id = conn.sync().xadd(STREAM_KEY, Map.of(
                    "template", event.template(),
                    "tenant_id", event.tenantId().toString(),
                    "type", event.getClass().getSimpleName(),
                    "payload", MAPPER.writeValueAsString(event)));
            // Cheap self-trim: keep the stream bounded without a separate background job.
            conn.sync().xtrim(STREAM_KEY, io.lettuce.core.XTrimArgs.Builder.maxlen(
                    maxLen).approximateTrimming());
            log.debug("events_stream published id={} template={}", id, event.template());
            return true;
        } catch (Exception e) {
            log.warn("events_stream publish_failed template={} type={} reason={}", event.template(),
                    e.getClass().getSimpleName(), e.getMessage());
            return false;
        }
    }
}
