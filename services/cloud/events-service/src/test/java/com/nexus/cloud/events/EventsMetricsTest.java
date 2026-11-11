package com.nexus.cloud.events;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.lettuce.core.RedisClient;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * D939 — the events-service reports what it promises it can see: poll attempts, swallowed poll
 * failures (split by mode tag) and ring evictions at the cap. Assertions run against a caller-owned
 * {@link SimpleMeterRegistry} — the reader takes the registry constructor-injected, so the meters
 * under test are exactly what production wires up.
 *
 * The counters are also part of the actuator surface: `GET /actuator/metrics/nexus.events.poll.holds`
 * is not claimed (the names are `nexus.events.poll.ticks` / `.failures` / `nexus.events.ring.evictions`);
 * this test is the proof of the names, so renaming one reddens here, not in a dashboard some deploy finds empty.
 */
class EventsMetricsTest {

    private EventsReader readerWith(MeterRegistry registry, boolean enabled, boolean groupEnabled) {
        return new EventsReader(enabled, "redis://127.0.0.1:1/0", 100L, 4,
                groupEnabled, "metrics-test-group", "metrics-test-consumer", registry);
    }

    @Test
    void aDisabledReaderNeverTicks() {
        MeterRegistry registry = new SimpleMeterRegistry();
        EventsReader reader = readerWith(registry, false, false);
        reader.pollOnce();
        reader.pollOnce();
        assertThat(registry.get("nexus.events.poll.ticks").counter().count()).isEqualTo(0.0);
        assertThat(registry.get("nexus.events.poll.failures").counter().count()).isEqualTo(0.0);
    }

    @Test
    void aFailedTailPollCountsTheAttemptAndTheFailure() {
        MeterRegistry registry = new SimpleMeterRegistry();
        EventsReader reader = readerWith(registry, true, false);
        reader.pollOnce();
        reader.pollOnce();
        assertThat(registry.get("nexus.events.poll.ticks").counter().count()).isEqualTo(2.0);
        assertThat(registry.get("nexus.events.poll.failures").tag("mode", "tail").counter().count())
                .isEqualTo(2.0);
    }

    @Test
    void aFailedGroupPollCountsUnderTheGroupModeTag() {
        MeterRegistry registry = new SimpleMeterRegistry();
        EventsReader reader = readerWith(registry, true, true);
        reader.pollOnce();
        assertThat(registry.get("nexus.events.poll.failures").tag("mode", "group").counter().count())
                .isEqualTo(1.0);
        assertThat(registry.find("nexus.events.poll.failures").tag("mode", "tail").counters())
                .as("a group-mode reader registers exactly one failures meter — its own mode")
                .isEmpty();
    }

    @Test
    void theEvictionsGaugeStandsAtZeroUntilTheRingOverflows() {
        MeterRegistry registry = new SimpleMeterRegistry();
        EventsReader reader = readerWith(registry, false, false);
        assertThat(registry.get("nexus.events.ring.evictions").gauge().value()).isEqualTo(0.0);
    }

    @Test
    void theEvictionsGaugeCountsCapOverflowExactly() {
        MeterRegistry registry = new SimpleMeterRegistry();
        EventsReader reader = new EventsReader(true, "redis://127.0.0.1:6380/0", 10L, 2,
                false, "metrics-test-group", "metrics-test-consumer", registry);
        RedisClient probe = RedisClient.create("redis://127.0.0.1:6380/0");
        try {
            probe.connect().sync().ping();
        } catch (Exception e) {
            probe.shutdown();
            assumeTrue(false, "live Redis unreachable — skipping integration arm");
            return;
        }
        probe.connect().sync().flushdb();
        for (int i = 0; i < 3; i++) {
            probe.connect().sync().xadd("nexus:events",
                    Map.of("template", "lead_new", "tenant_id", "00000000-0000-0000-0000-000000000001",
                            "type", "LeadCaptured", "payload", "{\"merchant_id\":\"m-1\"}"));
        }
        reader.pollOnce();
        assertThat(reader.buffered()).isEqualTo(2);
        assertThat(reader.totalSeen()).isEqualTo(3);
        assertThat(registry.get("nexus.events.ring.evictions").gauge().value()).isEqualTo(1.0);
        probe.shutdown();
    }
}
