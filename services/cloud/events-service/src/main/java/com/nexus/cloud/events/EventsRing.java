package com.nexus.cloud.events;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Fixed-size bounded ring of recent events. Zero allocations on steady state. */
final class EventsRing {

    private final int cap;
    private final LinkedHashMap<String, Map<String, String>> buffer = new LinkedHashMap<>() {

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Map<String, String>> eldest) {
            if (size() > cap) {
                evictions.incrementAndGet();
                return true;
            }
            return false;
        }
    };
    private final AtomicLong seen = new AtomicLong();
    private final AtomicLong evictions = new AtomicLong();

    EventsRing(int cap) {
        if (cap < 1) {
            throw new IllegalArgumentException("cap must be >= 1");
        }
        this.cap = cap;
    }

    void push(String id, Map<String, String> body) {
        if (id == null || body == null) {
            return;
        }
        seen.incrementAndGet();
        buffer.put(id, body);
    }

    /** Sized copy for serialisation. */
    Map<String, Map<String, String>> snapshot() {
        return new LinkedHashMap<>(buffer);
    }

    String oldest() {
        var it = buffer.keySet().iterator();
        return it.hasNext() ? it.next() : null;
    }

    long size() {
        return buffer.size();
    }

    long totalSeen() {
        return seen.get();
    }

    /** Evictions this ring has shrugged off at the cap — the signal the gauge binds to. */
    long evictions() {
        return evictions.get();
    }

    int capacity() {
        return cap;
    }
}
