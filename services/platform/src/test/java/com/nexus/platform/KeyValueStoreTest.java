package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.Test;

/** D909 — the in-memory fallback is bounded, LRU-ordered, and sweeps expired entries on write. */
class KeyValueStoreTest {

    private static KeyValueStore storeWithCap(int cap) {
        return new KeyValueStore(false, "redis://unused", 100, cap);
    }

    @Test
    void fallbackBackendRoundTripsWithoutRedis() {
        KeyValueStore store = storeWithCap(16);
        assertThat(store.usingRedis()).isFalse();
        store.set("k", "v", Duration.ofSeconds(30));
        assertThat(store.get("k")).contains("v");
        assertThat(store.fallbackSize()).isEqualTo(1);
    }

    @Test
    void theFallbackNeverExceedsItsBoundAndEvictsTheEldest() {
        KeyValueStore store = storeWithCap(3);
        for (int i = 0; i < 6; i++) {
            store.set("k" + i, "v" + i, Duration.ofMinutes(5));
        }
        assertThat(store.fallbackSize()).isLessThanOrEqualTo(3);
        assertThat(store.get("k5")).contains("v5"); // newest kept
        assertThat(store.get("k0")).isEmpty();      // eldest evicted
        assertThat(store.get("k1")).isEmpty();
    }

    @Test
    void aWriteSweepsExpiredEntriesBeforeTheCapBites() throws Exception {
        KeyValueStore store = storeWithCap(4);
        store.set("old", "v", Duration.ofMillis(120));
        store.set("keep", "v", Duration.ofMinutes(5));
        Thread.sleep(180);
        store.set("new1", "v", Duration.ofMinutes(5));
        store.set("new2", "v", Duration.ofMinutes(5));
        store.set("new3", "v", Duration.ofMinutes(5));
        assertThat(store.get("old")).isEmpty();            // expired either way
        assertThat(store.get("keep")).contains("v");      // live entry untouched
        assertThat(store.fallbackSize()).isEqualTo(4);    // keep + new1..3, old swept
    }

    @Test
    void aReadMakesAnEntryMostRecentSoEvictionTakesTheLeastRecentlyUsed() {
        KeyValueStore store = storeWithCap(3);
        store.set("a", "1", Duration.ofMinutes(5));
        store.set("b", "2", Duration.ofMinutes(5));
        store.set("c", "3", Duration.ofMinutes(5));
        assertThat(store.get("a")).isPresent();           // touch a → a is now most recent
        store.set("d", "4", Duration.ofMinutes(5));       // evicts LRU = b, not a
        assertThat(store.get("a")).contains("1");
        assertThat(store.get("b")).isEmpty();
        assertThat(store.get("d")).contains("4");
    }

    @Test
    void incrementWindowsRestartAtTheBoundary() throws Exception {
        KeyValueStore store = storeWithCap(16);
        assertThat(store.increment("rl:k", Duration.ofMillis(120))).isEqualTo(1);
        assertThat(store.increment("rl:k", Duration.ofMillis(120))).isEqualTo(2);
        Thread.sleep(180);
        assertThat(store.increment("rl:k", Duration.ofMillis(120))).isEqualTo(1);
    }

    @Test
    void setIfAbsentRespectsALiveEntryButOverwritesAnExpiredOne() throws Exception {
        KeyValueStore store = storeWithCap(16);
        assertThat(store.setIfAbsent("k", "v1", Duration.ofMillis(120))).isTrue();
        assertThat(store.setIfAbsent("k", "v2", Duration.ofMillis(120))).isFalse();
        Thread.sleep(180);
        assertThat(store.setIfAbsent("k", "v3", Duration.ofMillis(120))).isTrue();
        assertThat(store.get("k")).contains("v3");
    }
}
