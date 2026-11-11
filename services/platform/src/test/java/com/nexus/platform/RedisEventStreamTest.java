package com.nexus.platform;

import com.nexus.notification.event.DomainEvents;
import io.lettuce.core.RedisClient;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The bridge is an opt-in Redis Streams carrier: flag off → inert; flag on + unreachable → logs and
 * continues; flag on + live Redis → XADD under `nexus:events` with the schema this file promises.
 * Each claim has an arm.
 */
class RedisEventStreamTest {

    private RedisClient probe() {
        try {
            RedisClient c = RedisClient.create("redis://127.0.0.1:6380/0");
            c.connect().sync().ping();
            return c;
        } catch (Exception e) {
            return null;
        }
    }

    private DomainEvents.NexusDomainEvent sampleEvent() {
        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        return new DomainEvents.LeadCaptured(tenant, UUID.randomUUID(), UUID.randomUUID(),
                "Probe Person", Map.of("source", "unit-test"));
    }

    @Test
    @DisplayName("With the flag unset, the bridge is inert and publish() returns false")
    void whenDisabledPublishIsANoOp() {
        RedisEventStream stream = new RedisEventStream(false, "redis://127.0.0.1:6380/0", 1000);
        stream.init();
        assertThat(stream.publish(sampleEvent())).isFalse();
    }

    @Test
    @DisplayName("With an unreachable Redis URL, the bridge does not throw and publish() returns false")
    void whenUnreachableDoesNotThrow() {
        RedisEventStream stream = new RedisEventStream(true, "redis://127.0.0.1:1/0", 1000);
        stream.init();
        assertThat(stream.publish(sampleEvent())).isFalse();
        stream.shutdown();
    }

    @Test
    @DisplayName("A live Redis accepts the XADD into nexus:events with the schema the seed documents")
    void aLiveRedisAcceptsTheEvent() {
        RedisClient live = probe();
        assumeTrue(live != null, "live Redis not reachable at 127.0.0.1:6380 — skipping live arm (CI runs redis as a service on :6379)");
        live.connect().sync().flushdb();

        RedisEventStream stream = new RedisEventStream(true, "redis://127.0.0.1:6380/0", 1000);
        stream.init();
        boolean ok = stream.publish(sampleEvent());
        assertThat(ok).isTrue();

        java.util.List<io.lettuce.core.StreamMessage<String, String>> entries = live.connect().sync()
                .xread(io.lettuce.core.XReadArgs.StreamOffset.from("nexus:events", "0"));

        assertThat(entries).hasSizeGreaterThanOrEqualTo(1);
        io.lettuce.core.StreamMessage<String, String> body = entries.get(0);
        assertThat(body.getBody())
                .containsEntry("template", "lead_new")
                .containsEntry("type", "LeadCaptured")
                .containsEntry("tenant_id", "00000000-0000-0000-0000-000000000001");
        assertThat(body.getBody().get("payload")).contains("\"source\":");

        stream.shutdown();
        live.shutdown();
    }
}
