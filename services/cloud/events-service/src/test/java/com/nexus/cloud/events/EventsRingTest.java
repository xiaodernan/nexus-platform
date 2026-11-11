package com.nexus.cloud.events;

import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class EventsRingTest {

    @Test
    void itEvictsTheEldestEntryWhenFull() {
        EventsRing ring = new EventsRing(3);
        ring.push("1", Map.of("template", "t1"));
        ring.push("2", Map.of("template", "t2"));
        ring.push("3", Map.of("template", "t3"));
        ring.push("4", Map.of("template", "t4"));
        assertThat(ring.snapshot()).containsOnlyKeys("2", "3", "4");
        assertThat(ring.totalSeen()).isEqualTo(4);
    }

    @Test
    void itRefusesZeroAndNegativeCapacities() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new EventsRing(0))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void itCutsPayloadSizeAtCapacityNotAtEnqueueCount() {
        EventsRing ring = new EventsRing(2);
        ring.push("1", Map.of("u", "a"));
        ring.push("2", Map.of("u", "b"));
        ring.push("2", Map.of("u", "b-updated"));
        assertThat(ring.snapshot().get("2")).containsValue("b-updated");
        assertThat(ring.size()).isEqualTo(2);
        assertThat(ring.totalSeen()).isEqualTo(3);
    }
}
