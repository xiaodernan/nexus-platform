package com.nexus.cloud.events;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import io.lettuce.core.RedisClient;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;

/**
 * D1026 — this member's publisher door for the plane's Bus-lite refresh lane.
 *
 * <p>A THIRD member joins the lane (D1024 dispatcher, D1025 insight): one POST to
 * {@code /events/bus/refresh} publishes {@code {"target":…,"source":"events-service"}} on the
 * shared channel {@code nexus:bus:refresh}; every opted-in member rebinds through on the same pid.
 *
 * <p>Default OFF ({@code nexus.events.bus.enabled:false}). 409 {@code bus_disabled} is an honest
 * refusal: a "published" answer that reached nobody is worse than a named refusal.
 */
@RestController
public class EventsBusController {

    /** The channel every member subscribes to and every controller publishes on. */
    static final String CHANNEL = "nexus:bus:refresh";

    private final String redisUrl;
    private final boolean enabled;

    public EventsBusController(
            @Value("${NEXUS_REDIS_URL:redis://127.0.0.1:6380/0}") String redisUrl,
            @Value("${nexus.events.bus.enabled:false}") boolean enabled) {
        this.redisUrl = redisUrl;
        this.enabled = enabled;
    }

    @PostMapping("/events/bus/refresh")
    public ResponseEntity<Map<String, Object>> refresh(
            @RequestParam(name = "target", defaultValue = "all") String target) {
        if (!this.enabled) {
            return ResponseEntity
                    .status(409)
                    .body(Map.of(
                            "error", Map.of(
                                    "code", "bus_disabled",
                                    "message", "the bus is disabled on this instance; set NEXUS_EVENTS_BUS_ENABLED=true to publish")));
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
        String message = "{\"target\":\"" + sanitized + "\",\"source\":\"events-service\"}";
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
