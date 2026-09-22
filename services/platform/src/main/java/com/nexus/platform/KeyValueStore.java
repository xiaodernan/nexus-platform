package com.nexus.platform;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import jakarta.annotation.PreDestroy;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Tiny key/value + counter abstraction so rate limiting and refresh-token replay detection can live
 * in Redis when it is reachable and in process memory when it is not (task requirement: "Redis-backed
 * + in-memory fallback when Redis absent"). The active backend is reported by {@code /api/v1/health}.
 */
@Component
public class KeyValueStore {

    private static final Logger log = LoggerFactory.getLogger(KeyValueStore.class);

    private final boolean redisEnabled;
    private final String url;
    private final long timeoutMs;

    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private RedisCommands<String, String> redis;
    private final Map<String, long[]> memory = new ConcurrentHashMap<>(); // value stored via strings map below
    private final Map<String, String> memoryValues = new ConcurrentHashMap<>();

    public KeyValueStore(@Value("${nexus.redis.enabled:true}") boolean redisEnabled,
                         @Value("${nexus.redis.url:redis://127.0.0.1:6380/0}") String url,
                         @Value("${nexus.redis.timeout-ms:400}") long timeoutMs) {
        this.redisEnabled = redisEnabled;
        this.url = url;
        this.timeoutMs = timeoutMs;
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

    // ---- api ------------------------------------------------------------

    public Optional<String> get(String key) {
        if (redis != null) {
            try {
                return Optional.ofNullable(redis.get(key));
            } catch (Exception e) {
                degrade(e);
            }
        }
        String v = memoryValues.get(key);
        if (v == null) {
            return Optional.empty();
        }
        long[] exp = memory.get(key);
        if (exp != null && exp[0] < System.currentTimeMillis()) {
            memoryValues.remove(key);
            memory.remove(key);
            return Optional.empty();
        }
        return Optional.of(v);
    }

    public void set(String key, String value, Duration ttl) {
        if (redis != null) {
            try {
                redis.setex(key, ttl.getSeconds(), value);
                return;
            } catch (Exception e) {
                degrade(e);
            }
        }
        memoryValues.put(key, value);
        memory.put(key, new long[]{System.currentTimeMillis() + ttl.toMillis()});
    }

    public boolean setIfAbsent(String key, String value, Duration ttl) {
        if (redis != null) {
            try {
                return Boolean.TRUE.equals(redis.setnx(key, value)) && expire(key, ttl);
            } catch (Exception e) {
                degrade(e);
            }
        }
        long now = System.currentTimeMillis();
        long[] prev = memory.get(key);
        if (prev != null && prev[0] > now && memoryValues.containsKey(key)) {
            return false;
        }
        set(key, value, ttl);
        return true;
    }

    /** Increment with window semantics: first write in a window sets the TTL. */
    public long increment(String key, Duration window) {
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
        synchronized (memory) {
            long now = System.currentTimeMillis();
            long[] exp = memory.get(key);
            String raw = memoryValues.get(key);
            if (exp == null || exp[0] < now || raw == null) {
                memory.put(key, new long[]{now + window.toMillis()});
                memoryValues.put(key, "1");
                return 1;
            }
            long v = Long.parseLong(raw) + 1;
            memoryValues.put(key, String.valueOf(v));
            return v;
        }
    }

    public long remainingTtlSeconds(String key) {
        if (redis != null) {
            try {
                Long t = redis.ttl(key);
                return t == null || t < 0 ? 0 : t;
            } catch (Exception e) {
                degrade(e);
            }
        }
        long[] exp = memory.get(key);
        if (exp == null) {
            return 0;
        }
        return Math.max(0, (exp[0] - System.currentTimeMillis()) / 1000);
    }

    public void delete(String key) {
        if (redis != null) {
            try {
                redis.del(key);
                return;
            } catch (Exception e) {
                degrade(e);
            }
        }
        memoryValues.remove(key);
        memory.remove(key);
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
    }
}
