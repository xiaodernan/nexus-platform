package com.nexus.platform;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import jakarta.annotation.PreDestroy;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Tiny key/value + counter abstraction so rate limiting and refresh-token replay detection can live
 * in Redis when it is reachable and in process memory when it is not (task requirement: "Redis-backed
 * + in-memory fallback when Redis absent"). The active backend is reported by {@code /api/v1/health}.
 *
 * <p>D909: the in-memory fallback used to be an unbounded {@link java.util.concurrent.ConcurrentHashMap}
 * whose expired entries were only reclaimed when THEIR OWN key happened to be read again — a
 * {@code rl:login:<ip>} bucket written at rate-limit time and never read again leaked forever (the
 * same defect class as the AI tool cache's unbounded store, closed in D903). The fallback is now an
 * access-order {@link LinkedHashMap} capped at {@code nexus.redis.fallback-max-entries} (default 4096,
 * override via the same env convention as every other Redis knob): reads and writes refresh an
 * entry's position, a write purges expired entries before inserting when the map is at capacity, and
 * the eldest entry is evicted once the cap is reached — memory is bounded by the cap, not by the
 * number of distinct keys this process has ever seen. The Redis fast path is untouched.
 */
@Component
public class KeyValueStore {

    private static final Logger log = LoggerFactory.getLogger(KeyValueStore.class);

    /** One entry; the value is opaque to the store (Long.parseLong is the counter contract by key). */
    private static final class Entry {
        String value;
        long expiresAt;

        Entry(String value, long expiresAt) {
            this.value = value;
            this.expiresAt = expiresAt;
        }
    }

    /** Minimum interval between re-probe attempts once the store has degraded into in_memory mode. */
    private static final long REDIS_REPROBE_INTERVAL_MS = 30_000L;

    private final boolean redisEnabled;
    private final String url;
    private final long timeoutMs;

    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private RedisCommands<String, String> redis;
    /** epoch ms of the last degraded-window reconnect attempt; 0 when never degraded. */
    private volatile long lastReconnectAttemptMs = 0L;
    /**
     * Access-order LRU keyed by the store's logical key. Only ever touched under the map's own
     * monitor; volatile never. The Redis fast path never reads this.
     */
    private final Map<String, Entry> memory;
    private final int fallbackMax;

    public KeyValueStore(@Value("${nexus.redis.enabled:true}") boolean redisEnabled,
                         @Value("${nexus.redis.url:redis://127.0.0.1:6380/0}") String url,
                         @Value("${nexus.redis.timeout-ms:400}") long timeoutMs,
                         @Value("${nexus.redis.fallback-max-entries:4096}") int fallbackMaxEntries) {
        this.redisEnabled = redisEnabled;
        this.url = url;
        this.timeoutMs = timeoutMs;
        this.fallbackMax = Math.max(1, fallbackMaxEntries);
        this.memory = Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, KeyValueStore.Entry> eldest) {
                return size() > fallbackMax;
            }
        });
        if (redisEnabled) {
            try {
                client = RedisClient.create(url);
                client.setOptions(io.lettuce.core.ClientOptions.builder()
                        .autoReconnect(true)
                        .disconnectedBehavior(io.lettuce.core.ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                        .build());
                connection = client.connect();
                connection.sync().ping();
                redis = connection.sync();
                log.info("key_value_backend backend=redis url={}", url);
            } catch (Exception e) {
                log.warn("key_value_backend backend=in_memory reason=redis_unreachable url={} message={}", url, e.getMessage());
                closeRedis();
            }
        } else {
            log.info("key_value_backend backend=in_memory reason=disabled_by_config");
        }
    }

    public boolean usingRedis() {
        return redis != null;
    }

    /**
     * The D909 bounded LRU behaves correctly only when the process keeps using the same backend
     * for the whole run. When Redis recovers after a blip, the plane re-probes at most once per
     * {@link #REDIS_REPROBE_INTERVAL_MS}; on success the backend flips back to redis without a
     * restart, and the health route returns {@code key_value_backend=redis} again — a window that
     * once stayed open until the JVM restarted, on every transient blip.
     */
    private boolean tryReconnect() {
        long now = System.currentTimeMillis();
        if (now - lastReconnectAttemptMs < REDIS_REPROBE_INTERVAL_MS) {
            return false;
        }
        synchronized (this) {
            now = System.currentTimeMillis();
            if (now - lastReconnectAttemptMs < REDIS_REPROBE_INTERVAL_MS) {
                return false;
            }
            lastReconnectAttemptMs = now;
            try {
                RedisClient probe = RedisClient.create(url);
                probe.setOptions(io.lettuce.core.ClientOptions.builder()
                        .autoReconnect(true)
                        .disconnectedBehavior(io.lettuce.core.ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                        .build());
                StatefulRedisConnection<String, String> conn = probe.connect();
                conn.sync().ping();
                this.client = probe;
                this.connection = conn;
                this.redis = conn.sync();
                log.info("key_value_backend backend=redis url={} reason=reconnected", url);
                return true;
            } catch (Exception e) {
                log.warn("key_value_backend reason=reconnect_failed message={}", e.getMessage());
                return false;
            }
        }
    }

    private void closeRedis() {
        try {
            if (connection != null) {
                connection.close();
            }
            if (client != null) {
                client.shutdown();
            }
        } catch (Exception ignored) {
            // best effort
        }
        connection = null;
        client = null;
        redis = null;
    }

    @PreDestroy
    public void shutdown() {
        closeRedis();
    }

    /** purge of everything expired; bounded by the cap, called on the write path only. */
    private void sweepExpired(long now) {
        memory.values().removeIf(e -> e.expiresAt <= now);
    }

    // ---- api ------------------------------------------------------------

    public Optional<String> get(String key) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                return Optional.ofNullable(redis.get(key));
            } catch (Exception e) {
                degrade(e);
            }
        }
        synchronized (memory) {
            Entry e = memory.get(key);
            if (e == null) {
                return Optional.empty();
            }
            if (e.expiresAt <= System.currentTimeMillis()) {
                memory.remove(key);
                return Optional.empty();
            }
            return Optional.of(e.value);
        }
    }

    public void set(String key, String value, Duration ttl) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                redis.setex(key, ttl.getSeconds(), value);
                return;
            } catch (Exception e) {
                degrade(e);
            }
        }
        long now = System.currentTimeMillis();
        synchronized (memory) {
            if (memory.size() >= fallbackMax) {
                sweepExpired(now);
            }
            memory.put(key, new Entry(value, now + Math.max(1L, ttl.toMillis())));
        }
    }

    public boolean setIfAbsent(String key, String value, Duration ttl) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                return Boolean.TRUE.equals(redis.setnx(key, value)) && expire(key, ttl);
            } catch (Exception e) {
                degrade(e);
            }
        }
        long now = System.currentTimeMillis();
        synchronized (memory) {
            Entry prev = memory.get(key);
            if (prev != null && prev.expiresAt > now) {
                return false;
            }
            if (memory.size() >= fallbackMax) {
                sweepExpired(now);
            }
            memory.put(key, new Entry(value, now + Math.max(1L, ttl.toMillis())));
            return true;
        }
    }

    /** Increment with window semantics: first write in a window sets the TTL. */
    public long increment(String key, Duration window) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                long v = redis.incr(key);
                if (v == 1) {
                    redis.expire(key, window.getSeconds());
                }
                return v;
            } catch (Exception e) {
                degrade(e);
            }
        }
        long now = System.currentTimeMillis();
        synchronized (memory) {
            if (memory.size() >= fallbackMax) {
                sweepExpired(now);
            }
            Entry prev = memory.get(key);
            if (prev == null || prev.expiresAt <= now) {
                memory.put(key, new Entry("1", now + Math.max(1L, window.toMillis())));
                return 1;
            }
            long v;
            try {
                v = Long.parseLong(prev.value) + 1;
            } catch (NumberFormatException e) {
                // a value was written by set() with a non-numeric string; restart the window honestly
                memory.put(key, new Entry("1", now + Math.max(1L, window.toMillis())));
                return 1;
            }
            prev.value = String.valueOf(v);
            return v;
        }
    }

    public long remainingTtlSeconds(String key) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                Long t = redis.ttl(key);
                return t == null || t < 0 ? 0 : t;
            } catch (Exception e) {
                degrade(e);
            }
        }
        synchronized (memory) {
            Entry e = memory.get(key);
            if (e == null) {
                return 0;
            }
            return Math.max(0, (e.expiresAt - System.currentTimeMillis()) / 1000);
        }
    }

    public void delete(String key) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                redis.del(key);
                return;
            } catch (Exception e) {
                degrade(e);
            }
        }
        synchronized (memory) {
            memory.remove(key);
        }
    }

    /** package-visible for the unit tests: exact size of the in-memory tier. */
    int fallbackSize() {
        synchronized (memory) {
            return memory.size();
        }
    }

    private boolean expire(String key, Duration ttl) {
        if (redis != null) {
            redis.expire(key, ttl.getSeconds());
        }
        return true;
    }

    private void degrade(Exception e) {
        log.warn("redis_command_failed falling_back=in_memory message={}", e.getMessage());
        closeRedis();
        lastReconnectAttemptMs = System.currentTimeMillis();
    }
}
