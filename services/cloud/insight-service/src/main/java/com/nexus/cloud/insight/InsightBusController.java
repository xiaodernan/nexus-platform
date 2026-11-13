package com.nexus.cloud.insight;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import io.lettuce.core.RedisClient;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;

/**
 * D1025 — this member's publisher door for the plane's Spring Cloud Bus-lite refresh lane.
 *
 * <p>The wave every member of the bus ships (D1024 gave the dispatcher both halves): one POST to
 * {@code /insight/bus/refresh} publishes {@code {"target":…,"source":"insight-service"}} on the
 * shared channel {@code nexus:bus:refresh}, which every opted-in member on the plane rebinds
 * through on the same pid. This controller does not rebind anything — it publishes; receivers
 * rebind.
 *
 * <p>Default OFF ({@code nexus.insight.bus.enabled:false}). A member with the bus unset never
 * opens a pub/sub connection. 409 {@code bus_disabled} is an honest refusal: a "published" answer
 * that reached nobody is worse than a named refusal.
 */
@RestController
public class InsightBusController {

    /** The channel every member subscribes to and every controller publishes on. */
    static final String CHANNEL = "nexus:bus:refresh";

    private final String redisUrl;
    private final boolean enabled;

    public InsightBusController(
            @Value("${NEXUS_REDIS_URL:redis://127.0.0.1:6380/0}") String redisUrl,
            @Value("${nexus.insight.bus.enabled:false}") boolean enabled) {
        this.redisUrl = redisUrl;
        this.enabled = enabled;
    }

    @PostMapping("/insight/bus/refresh")
    public ResponseEntity<Map<String, Object>> refresh(
            @RequestParam(name = "target", defaultValue = "all") String target) {
        if (!this.enabled) {
            return ResponseEntity
                    .status(409)
                    .body(Map.of(
                            "error", Map.of(
                                    "code", "bus_disabled",
                                    "message", "the bus is disabled on this instance; set NEXUS_INSIGHT_BUS_ENABLED=true to publish")));
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
        String message = "{\"target\":\"" + sanitized + "\",\"source\":\"insight-service\"}";
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
