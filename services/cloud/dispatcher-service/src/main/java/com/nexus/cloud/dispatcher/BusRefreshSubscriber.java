package com.nexus.cloud.dispatcher;

import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.context.refresh.ContextRefresher;
import org.springframework.cloud.context.scope.refresh.RefreshScope;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.lettuce.core.RedisClient;
import io.lettuce.core.pubsub.RedisPubSubAdapter;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;

/**
 * D1024 — the receiver half of the plane's Spring Cloud Bus-lite lane.
 *
 * <p>One Redis channel ({@value #CHANNEL}), one opt-in env ({@code NEXUS_BUS_ENABLED}), one
 * honest action when the {@code target} field names this member or {@code all}:
 * {@link ContextRefresher#refresh()} — the exact sequence the {@code /actuator/refresh}
 * endpoint performs. It re-reads the environment (Config Server re-fetch included), diffs it
 * and rebinds the {@code @RefreshScope} beans, so {@code /dispatcher/config} answers with the
 * newly resolved label on the SAME pid. No restart.
 *
 * <p>Off by default. A member with {@code NEXUS_BUS_ENABLED} unset never opens a pub/sub
 * connection and never sees a message; its behaviour on the wire is byte-identical to before
 * this lane existed. A member whose Redis is unreachable logs one warning and stays bootable —
 * the same posture as the redis-disabled event readers.
 *
 * <p>The target match is exact after the {@code nexus-} prefix is stripped from the member's
 * application name: {@code nexus-dispatcher} answers to {@code dispatcher} (and to {@code all}),
 * never to {@code insight} or {@code gateway}. A malformed message is logged and dropped,
 * not fatal — pub/sub is a notice lane, not a command queue.
 *
 * <p>If the plane ever ships without spring-cloud-context on the classpath, this component
 * degrades to a no-op with a loud boot log rather than failing the service.
 */
@Component
public class BusRefreshSubscriber {

    /** The channel every member subscribes to and every controller publishes on. */
    public static final String CHANNEL = "nexus:bus:refresh";

    private static final Logger log = LoggerFactory.getLogger(BusRefreshSubscriber.class);
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final boolean enabled;
    private final String redisUrl;
    private final String member;
    private final ContextRefresher contextRefresher;
    private final RefreshScope refreshScope;

    private RedisClient client;
    private StatefulRedisPubSubConnection<String, String> connection;
    private final AtomicLong refreshes = new AtomicLong(0);
    private final AtomicLong dropped = new AtomicLong(0);

    public BusRefreshSubscriber(
            @Value("${nexus.dispatcher.bus.enabled:false}") boolean enabled,
            @Value("${nexus.dispatcher.url:redis://127.0.0.1:6380/0}") String redisUrl,
            @Value("${spring.application.name:nexus-dispatcher}") String applicationName,
            ApplicationContext context) {
        this.enabled = enabled;
        this.redisUrl = redisUrl;
        this.member = applicationName != null && applicationName.startsWith("nexus-")
                ? applicationName.substring("nexus-".length())
                : String.valueOf(applicationName);
        ContextRefresher refresher = null;
        RefreshScope scope = null;
        try {
            refresher = context.getBean(ContextRefresher.class);
        } catch (RuntimeException ex) {
            log.warn("bus subscriber: ContextRefresher bean absent ({}); trying RefreshScope", ex.getMessage());
        }
        try {
            scope = context.getBean(RefreshScope.class);
        } catch (RuntimeException ex) {
            log.warn("bus subscriber: RefreshScope bean absent ({})", ex.getMessage());
        }
        this.contextRefresher = refresher;
        this.refreshScope = scope;
    }

    /** Total refreshes applied through this subscriber since boot (a metric, not a claim). */
    public long refreshes() {
        return refreshes.get();
    }

    /** Messages logged and dropped as malformed or off-target since boot. */
    public long dropped() {
        return dropped.get();
    }

    @PostConstruct
    void start() {
        if (!enabled) {
            log.info("bus subscriber: nexus.dispatcher.bus.enabled=false — no pub/sub connection is opened");
            return;
        }
        if (contextRefresher == null && refreshScope == null) {
            log.warn("bus subscriber: enabled but neither ContextRefresher nor RefreshScope is available — refusing to half-join the bus");
            return;
        }
        try {
            client = RedisClient.create(redisUrl);
            connection = client.connectPubSub();
            connection.addListener(new RedisPubSubAdapter<String, String>() {
                @Override
                public void message(String channel, String message) {
                    onMessage(message);
                }
            });
            connection.sync().subscribe(CHANNEL);
            log.info("bus subscriber: listening on {} as member '{}'", CHANNEL, member);
        } catch (RuntimeException ex) {
            log.warn("bus subscriber: cannot reach Redis at {} ({}); the bus stays off for this run and the service boots on", redisUrl, ex.getMessage());
            closeQuietly();
        }
    }

    @PreDestroy
    void stop() {
        closeQuietly();
    }

    private void closeQuietly() {
        try {
            if (connection != null) connection.close();
        } catch (RuntimeException ignored) {
            // best-effort cleanup
        }
        try {
            if (client != null) client.shutdown();
        } catch (RuntimeException ignored) {
            // best-effort cleanup
        }
        connection = null;
        client = null;
    }

    /** Package-private so a self-test can drive the handler without any Redis at all. */
    void onMessage(String raw) {
        String target = parseTarget(raw);
        if (target == null) {
            dropped.incrementAndGet();
            log.warn("bus refresh: dropping malformed message on {}", raw);
            return;
        }
        if (!"all".equals(target) && !member.equals(target)) {
            log.info("bus refresh: target '{}' is not this member ('{}'), ignoring", target, member);
            return;
        }
        try {
            if (contextRefresher != null) {
                Set<String> changed = contextRefresher.refresh();
                refreshes.incrementAndGet();
                log.info("bus refresh: actuator-refresh sequence applied for target '{}' ({} changed key(s))", target, changed == null ? 0 : changed.size());
            } else {
                refreshScope.refreshAll();
                refreshes.incrementAndGet();
                log.info("bus refresh: @RefreshScope beans rebound for target '{}' (environment not re-read; RefreshScope fallback)", target);
            }
        } catch (RuntimeException ex) {
            dropped.incrementAndGet();
            log.warn("bus refresh: refresh failed for target '{}': {}", target, ex.getMessage());
        }
    }

    /** Strict enough to refuse nonsense: the target must be a 1..64 char lower-case tag. */
    static String parseTarget(String raw) {
        try {
            JsonNode node = OBJECT_MAPPER.readTree(raw);
            JsonNode target = node == null ? null : node.get("target");
            if (target == null || !target.isTextual()) return null;
            String value = target.asText().trim().toLowerCase(java.util.Locale.ROOT);
            if (!value.matches("[a-z0-9-]{1,64}")) return null;
            return value;
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException ex) {
            return null;
        }
    }
}
