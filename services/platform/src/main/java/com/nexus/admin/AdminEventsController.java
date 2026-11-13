package com.nexus.admin;

import com.nexus.platform.RequiresPlatformRole;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisException;
import io.lettuce.core.Limit;
import io.lettuce.core.Range;
import io.lettuce.core.StreamMessage;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import io.lettuce.core.models.stream.PendingMessages;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §9 — {@code GET /api/v1/admin/events}.
 *
 * <p>The Redis Streams bridge (RedisEventStream, D928) is now the wire that feeds the events-service
 * consumer group, and nothing in the operator surface could answer "how deep is the queue and is
 * the consumer keeping up?" This read surface answers it, from the same Redis the publisher writes
 * to. Same fail-soft rule as everywhere else on the platform plane: Redis down is an honest degraded
 * body with a 200, never a 500, never fabricated numbers, never a full scan.
 *
 * <p>The read is O(len + window). {@code xPending} is one call per group; the admin UI shows the
 * total in-flight and the newest 8 entries' template/tenant_id/type. It is strictly read-only:
 * no publish, no claim, no ack — the events lane writes its own chokes to its own logs.
 */
@RestController
@RequestMapping("/api/v1/admin/events")
public class AdminEventsController {

    private static final Logger log = LoggerFactory.getLogger(AdminEventsController.class);
    private static final String STREAM_KEY = "nexus:events";
    private static final String DEFAULT_GROUP = "nexus-events-readers";
    private static final int RECENT_WINDOW = 8;

    private final String redisUrl;
    private final boolean streamEnabled;
    private final long maxLen;

    private volatile RedisClient client;
    private volatile StatefulRedisConnection<String, String> conn;

    public AdminEventsController(@Value("${nexus.redis.url:redis://127.0.0.1:6380/0}") String redisUrl,
                                 @Value("${nexus.events.redis-stream-enabled:false}") boolean streamEnabled,
                                 @Value("${nexus.events.max-len:1000}") long maxLen) {
        this.redisUrl = redisUrl;
        this.streamEnabled = streamEnabled;
        this.maxLen = maxLen;
    }

    @GetMapping
    @RequiresPlatformRole
    public Map<String, Object> events(HttpServletRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("source", "redis:" + STREAM_KEY);
        body.put("enabled", streamEnabled);
        body.put("max_len", maxLen);
        body.put("as_of", Instant.now().toString());

        if (!streamEnabled) {
            body.put("disabled", true);
            body.put("degraded", false);
            body.put("degraded_reason", null);
            body.put("xlen", null);
            body.put("group", null);
            body.put("recent", null);
            return body;
        }

        StatefulRedisConnection<String, String> connection = connection();
        if (connection == null) {
            body.put("degraded", true);
            body.put("degraded_reason", "redis_unreachable");
            body.put("xlen", null);
            body.put("group", null);
            body.put("recent", null);
            return body;
        }

        RedisCommands<String, String> sync = connection.sync();
        try {
            body.put("xlen", sync.xlen(STREAM_KEY));
        } catch (Exception e) {
            body.put("degraded", true);
            body.put("degraded_reason", "xlen_failed:" + e.getClass().getSimpleName());
            body.put("xlen", null);
            body.put("group", null);
            body.put("recent", null);
            return body;
        }

        body.put("group", groupState(sync));
        body.put("recent", recent(sync));
        body.put("degraded", false);
        body.put("degraded_reason", null);
        return body;
    }

    private StatefulRedisConnection<String, String> connection() {
        StatefulRedisConnection<String, String> current = conn;
        if (current != null && current.isOpen()) {
            return current;
        }
        synchronized (this) {
            current = conn;
            if (current != null && current.isOpen()) {
                return current;
            }
            try {
                RedisClient c = RedisClient.create(redisUrl);
                c.setOptions(io.lettuce.core.ClientOptions.builder()
                        .autoReconnect(true)
                        .disconnectedBehavior(io.lettuce.core.ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                        .build());
                StatefulRedisConnection<String, String> opened = c.connect();
                opened.sync().ping();
                this.client = c;
                this.conn = opened;
                return opened;
            } catch (RedisException e) {
                log.warn("admin events read — redis unreachable: {}", e.getMessage());
                closeQuietly();
                return null;
            } catch (Exception e) {
                log.warn("admin events read — redis open failed: {}", e.getMessage());
                closeQuietly();
                return null;
            }
        }
    }

    private Map<String, Object> groupState(RedisCommands<String, String> sync) {
        try {
            PendingMessages pending = sync.xpending(STREAM_KEY, DEFAULT_GROUP);
            Map<String, Object> group = new LinkedHashMap<>();
            group.put("name", DEFAULT_GROUP);
            group.put("pending", pending.getCount());
            group.put("consumers", pending.getConsumerMessageCount().size());
            group.put("consumer_detail", pending.getConsumerMessageCount());
            group.put("oldest_pending_id", pending.getMessageIds().getLower());
            group.put("newest_pending_id", pending.getMessageIds().getUpper());
            return group;
        } catch (Exception e) {
            // The group only exists once the events-service has created it (or in dev: never).
            log.debug("admin events read — group {} unavailable: {}", DEFAULT_GROUP, e.getMessage());
            return null;
        }
    }

    private List<Map<String, Object>> recent(RedisCommands<String, String> sync) {
        try {
            List<StreamMessage<String, String>> messages = sync.xrevrange(STREAM_KEY,
                    Range.unbounded(), Limit.from(RECENT_WINDOW));
            List<Map<String, Object>> out = new ArrayList<>(messages.size());
            for (StreamMessage<String, String> message : messages) {
                Map<String, String> body = message.getBody();
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", message.getId());
                row.put("template", body.get("template"));
                row.put("tenant_id", body.get("tenant_id"));
                row.put("type", body.get("type"));
                out.add(row);
            }
            return out;
        } catch (Exception e) {
            log.debug("admin events read — recent window unavailable: {}", e.getMessage());
            return null;
        }
    }

    @PreDestroy
    public void shutdown() {
        closeQuietly();
    }

    private void closeQuietly() {
        try {
            if (conn != null) {
                conn.close();
            }
        } catch (Exception ignored) {
            // best effort
        }
        try {
            if (client != null) {
                client.shutdown();
            }
        } catch (Exception ignored) {
            // best effort
        }
        conn = null;
        client = null;
    }
}
