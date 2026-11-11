package com.nexus.cloud.events;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Honest read surface for D928's Redis Stream bridge.
 *
 * <ul>
 *   <li>{@code GET /events/health} — liveness, with the last-poll age in milliseconds.</li>
 *   <li>{@code GET /events/count} — running totals (bounded ring) for audit and dashboards.</li>
 *   <li>{@code GET /events/recent} — the ring itself, newest first.</li>
 *   <li>{@code GET /events/group} — D931: consumer-group state (enabled, group, consumer,
 *       delivered / acked / pending), so the at-most-once property is observable.</li>
 * </ul>
 *
 * Returned as a map rather than a domain object: no schema, no promises, the reader is the arbiter.
 */
@RestController
public class EventsViewController {

    private final EventsReader reader;

    public EventsViewController(EventsReader reader) {
        this.reader = reader;
    }

    @GetMapping("/events/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", reader.isHealthy() ? "UP" : "degraded");
        body.put("service", "nexus-events");
        body.put("poll_frequency_ms", reader.pollFrequency().toMillis());
        body.put("last_poll_age_ms", reader.sinceLastOk().toMillis());
        return body;
    }

    @GetMapping("/events/count")
    public Map<String, Object> count() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("total_seen", reader.totalSeen());
        body.put("currently_buffered", reader.buffered());
        body.put("capacity", 32);
        return body;
    }

    @GetMapping("/events/recent")
    public Map<String, Object> recent() {
        return Map.of("events", reader.recent());
    }

    /** D931: the consumer-group reliability surface. In tail mode `enabled` is false and pending is 0. */
    @GetMapping("/events/group")
    public Map<String, Object> group() {
        return reader.groupState();
    }
}
