package com.nexus.cloud.gateway;

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
 * D1034 — the gateway (the plane's single edge) joins the Bus-lite lane, as the fourth member.
 *
 * <p>{@value #CHANNEL}, opt-in via {@code NEXUS_GATEWAY_BUS_ENABLED}, strict 1–64 char target
 * grammar, exact match after the {@code nexus-} prefix strip (or {@code all}), and the same
 * honest action as every other member: {@link ContextRefresher#refresh()} — the exact sequence
 * the {@code /actuator/refresh} endpoint performs.
 *
 * <p>The edge is reactive (WebFlux); this subscriber runs on Lettuce's own event loop and never
 * shares the WebFlux loop, and does no I/O except the one round trip to Redis to subscribe. A
 * refresh cannot stall route resolution — and when the bus is disabled, unreachable or the
 * property rebinding fails, the edge logs one line and boots/serves on exactly as before.
 */
@Component
public class GatewayBusRefreshSubscriber {

    /** The shared channel: byte-identical across all four members. */
    public static final String CHANNEL = "nexus:bus:refresh";

    private static final Logger log = LoggerFactory.getLogger(GatewayBusRefreshSubscriber.class);
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

    public GatewayBusRefreshSubscriber(
            @Value("${nexus.gateway.bus.enabled:false}") boolean enabled,
            @Value("${NEXUS_REDIS_URL:redis://127.0.0.1:6380/0}") String redisUrl,
            @Value("${spring.application.name:nexus-gateway}") String applicationName,
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
            log.warn("gateway bus subscriber: ContextRefresher bean absent ({}); trying RefreshScope", ex.getMessage());
        }
        try {
            scope = context.getBean(RefreshScope.class);
        } catch (RuntimeException ex) {
            log.warn("gateway bus subscriber: RefreshScope bean absent ({})", ex.getMessage());
        }
        this.contextRefresher = refresher;
        this.refreshScope = scope;
    }

    /** Total refreshes applied through this subscriber since boot. */
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
            log.info("gateway bus subscriber: nexus.gateway.bus.enabled=false — no pub/sub connection is opened");
            return;
        }
        if (contextRefresher == null && refreshScope == null) {
            log.warn("gateway bus subscriber: enabled but neither ContextRefresher nor RefreshScope is available — refusing to half-join the bus");
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
            log.info("gateway bus subscriber: listening on {} as member '{}'", CHANNEL, member);
        } catch (RuntimeException ex) {
            log.warn("gateway bus subscriber: cannot reach Redis at {} ({}); the bus stays off for this run and the edge boots on", redisUrl, ex.getMessage());
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

    /** Package-private so the smoke's boot log and a self-test can observe the handler. */
    void onMessage(String raw) {
        String target = parseTarget(raw);
        if (target == null) {
            dropped.incrementAndGet();
            log.warn("gateway bus refresh: dropping malformed message on {}", raw);
            return;
        }
        if (!"all".equals(target) && !member.equals(target)) {
            log.info("gateway bus refresh: target '{}' is not this member ('{}'), ignoring", target, member);
            return;
        }
        try {
            if (contextRefresher != null) {
                Set<String> changed = contextRefresher.refresh();
                refreshes.incrementAndGet();
                log.info("gateway bus refresh: actuator-refresh sequence applied for target '{}' ({} changed key(s))", target, changed == null ? 0 : changed.size());
            } else {
                refreshScope.refreshAll();
                refreshes.incrementAndGet();
                log.info("gateway bus refresh: @RefreshScope beans rebound for target '{}' (environment not re-read; RefreshScope fallback)", target);
            }
        } catch (RuntimeException ex) {
            dropped.incrementAndGet();
            log.warn("gateway bus refresh: refresh failed for target '{}': {}", target, ex.getMessage());
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
