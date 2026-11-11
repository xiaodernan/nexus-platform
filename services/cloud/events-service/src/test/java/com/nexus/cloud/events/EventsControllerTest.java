package com.nexus.cloud.events;

import io.lettuce.core.RedisClient;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class EventsControllerTest {

    private EventsController controller;

    @BeforeEach
    void setUp() {
        controller = new EventsController(new EventsReader(false, "redis://127.0.0.1:1/0", 1L, 4));
    }

    @Test
    void healthReportsDegradedWhenPollingDisabled() {
        Map<String, Object> body = controller.health();
        assertThat(body).containsEntry("status", "degraded");
        assertThat(body).containsEntry("service", "nexus-events");
    }

    @Test
    void countReportsAllZeroesBeforeAnythingIsBuffered() {
        Map<String, Object> body = controller.count();
        assertThat(body).containsEntry("total_seen", 0L);
        assertThat(body).containsEntry("currently_buffered", 0L);
        assertThat(body).containsEntry("capacity", 32);
    }

    @Test
    void recentReturnsEmptyMapBeforeAnythingIsBuffered() {
        assertThat(controller.recent()).containsEntry("events", Map.of());
    }

    @Test
    void whenRedisIsLiveTheReaderBuffersAndTheCountMoves() {
        RedisClient probe = RedisClient.create("redis://127.0.0.1:6380/0");
        try {
            probe.connect().sync().ping();
        } catch (Exception e) {
            probe.shutdown();
            assumeTrue(false, "live Redis unreachable — skipping integration arm");
            return;
        }
        probe.connect().sync().flushdb();

        // The reader starts at "$", meaning "only entries added after I connect". Establish the
        // connection first, THEN publish, then poll — the path is exactly what a production
        // reader sees on its first live tick.
        EventsReader reader = new EventsReader(true, "redis://127.0.0.1:6380/0", 10L, 4);
        reader.pollOnce();
        RedisClient publisher = RedisClient.create("redis://127.0.0.1:6380/0");
        publisher.connect().sync().xadd("nexus:events",
                Map.of("template", "lead_new", "tenant_id", "00000000-0000-0000-0000-000000000001",
                        "type", "LeadCaptured", "payload", "{\"merchant_id\":\"m-1\"}"));
        reader.pollOnce();

        assertThat(reader.totalSeen()).isEqualTo(1);
        assertThat(reader.recent()).hasSize(1);
        probe.shutdown();
        publisher.shutdown();
    }
}
