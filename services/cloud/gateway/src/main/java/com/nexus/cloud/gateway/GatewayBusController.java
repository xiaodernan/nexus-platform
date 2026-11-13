package com.nexus.cloud.gateway;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import io.lettuce.core.RedisClient;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;

/**
 * D1034 — the edge's publisher door for the plane's Bus-lite refresh lane.
 *
 * <p>A FOURTH member of the lane (dispatcher D1024, insight D1025, events D1026): one POST to
 * {@code /gateway/bus/refresh} publishes {@code {"target":…,"source":"gateway-service"}} on
 * {@code nexus:bus:refresh}, and every opted-in member rebinds on the same pid.
 *
 * <p>Default OFF ({@code nexus.gateway.bus.enabled:false}). 409 {@code bus_disabled} is the honest
 * refusal: a "published" answer that reached nobody is worse than a named refusal. This door is
 * the entry point an operator arms for a plane-wide refresh notice from the edge.
 */
@RestController
public class GatewayBusController {

    /** The shared channel: byte-identical to the sidecars'. */
    static final String CHANNEL = "nexus:bus:refresh";

    private final String redisUrl;
    private final boolean enabled;

    public GatewayBusController(
            @Value("${NEXUS_REDIS_URL:redis://127.0.0.1:6380/0}") String redisUrl,
            @Value("${nexus.gateway.bus.enabled:false}") boolean enabled) {
        this.redisUrl = redisUrl;
        this.enabled = enabled;
    }

    @PostMapping("/gateway/bus/refresh")
    public ResponseEntity<Map<String, Object>> refresh(
            @RequestParam(name = "target", defaultValue = "all") String target) {
        if (!this.enabled) {
            return ResponseEntity
                    .status(409)
                    .body(Map.of(
                            "error", Map.of(
                                    "code", "bus_disabled",
                                    "message", "the bus is disabled on this instance; set NEXUS_GATEWAY_BUS_ENABLED=true to publish")));
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
        String message = "{\"target\":\"" + sanitized + "\",\"source\":\"gateway-service\"}";
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
