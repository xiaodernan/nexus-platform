package com.nexus.cloud.dispatcher;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import io.lettuce.core.RedisClient;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;

/**
 * D1024 — the control the bus exists to serve: one POST to {@code /dispatcher/bus/refresh}
 * publishes a {@code nexus:bus:refresh} message and every subscriber on the plane rebinds
 * without restarting. This controller does not rebind itself — it is the publisher, nothing
 * else. Whether a member participates is answered by {@code NEXUS_BUS_ENABLED} on that member.
 *
 * <p>Default OFF ({@code nexus.dispatcher.bus.enabled:false}). When disabled the endpoint
 * refuses to publish and answers 409 with a reason — a silent success that reaches no one is
 * worse than an honest refusal.
 *
 * <p>Publishing uses a dedicated short-lived connection and closes it before returning; the
 * reader's consumer group is never involved. The subscriber side refreshes the member's
 * {@code @RefreshScope} beans through Spring Cloud's own {@code RefreshScope.refreshAll()}.
 */
@RestController
public class BusRefreshController {

    /** The channel every member subscribes to and every controller publishes on. */
    static final String CHANNEL = "nexus:bus:refresh";

    private final String redisUrl;
    private final boolean enabled;

    public BusRefreshController(
            @Value("${nexus.dispatcher.url:redis://127.0.0.1:6380/0}") String redisUrl,
            @Value("${nexus.dispatcher.bus.enabled:false}") boolean enabled) {
        this.redisUrl = redisUrl;
        this.enabled = enabled;
    }

    @PostMapping("/dispatcher/bus/refresh")
    public ResponseEntity<Map<String, Object>> refresh(
            @RequestParam(name = "target", defaultValue = "all") String target) {
        if (!this.enabled) {
            return ResponseEntity
                    .status(409)
                    .body(Map.of(
                            "error", Map.of(
                                    "code", "bus_disabled",
                                    "message", "the bus is disabled on this instance; set NEXUS_BUS_ENABLED=true to publish")));
        }
        String trimmed = target == null ? "" : target.trim();
        if (trimmed.isEmpty()) {
            return ResponseEntity
                    .status(400)
                    .body(Map.of(
                            "error", Map.of(
                                    "code", "bus_target_blank",
                                    "message", "target must name a service or 'all'")));
        }
        String sanitized = trimmed.replace("\"", "");
        String message = "{\"target\":\"" + sanitized + "\",\"source\":\"dispatcher-service\"}";
        try (RedisClient client = RedisClient.create(redisUrl);
             StatefulRedisPubSubConnection<String, String> connection = client.connectPubSub()) {
            long receivers = connection.sync().publish(CHANNEL, message);
            return ResponseEntity
                    .status(202)
                    .body(Map.of(
                            "published", true,
                            "channel", CHANNEL,
                            "target", sanitized,
                            "receivers", receivers));
        }
    }
}
