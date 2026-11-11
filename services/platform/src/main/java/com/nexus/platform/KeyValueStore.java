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

    /**
     * D932 — INCR and the first-write EXPIRE are ONE atomic Redis operation, not two commands.
     *
     * <p>Before this unit the Redis path ran {@code redis.incr(key)} and, only when it returned 1,
     * a SEPARATE {@code redis.expire(key, seconds)}. Those are two round trips with a crash window
     * between them: if the process died — or the EXPIRE was rejected — after the INCR but before the
     * EXPIRE, the key carried NO ttl and the fixed-window bucket never reset. Every later request from
     * that principal then counted against a counter that would never expire: a permanent 429, i.e. a
     * self-inflicted denial of service. The in-memory fallback never had this hole (it writes value and
     * expiry together under one monitor), so the defect was specific to the Redis fast path that a
     * deployment opts INTO.
     *
     * <p>A single Lua script closes the window: Redis executes scripts atomically on one thread, so
     * the INCR and the conditional EXPIRE either both happen or neither does. There is no state in
     * which the counter exists without its ttl. The seconds are passed as ARGV (never interpolated
     * into the script), so the script text is constant and Lettuce can EVALSHA-cache it.
     */
    static final String INCR_AND_EXPIRE_LUA =
            "local n = redis.call('INCR', KEYS[1]) "
          + "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end "
          + "return n";

    /** Increment with window semantics: first write in a window sets the TTL, ATOMICALLY (D932). */
    public long increment(String key, Duration window) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                long seconds = Math.max(1L, window.getSeconds());
                Object result = redis.eval(INCR_AND_EXPIRE_LUA, io.lettuce.core.ScriptOutputType.INTEGER,
                        new String[]{key}, String.valueOf(seconds));
                return ((Number) result).longValue();
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

    /**
     * D937 — an atomic SLIDING-window limiter, the first Redis sorted-set (ZSET) use in this tree.
     *
     * <p>D932 made the fixed-window counter's INCR+first-write EXPIRE atomic, but a fixed window has a
     * boundary burst: with limit N per W, a caller can send N just before the boundary and N just after and
     * get 2N through in a span far shorter than W. A sliding window answers a stricter question — "how many
     * hits are in the last W milliseconds, at THIS instant?" — so no matter where a boundary falls, any
     * W-wide interval contains at most N accepted hits.
     *
     * <p>The whole operation is ONE Lua {@code EVAL}, because "sweep old hits, count, admit-and-append" must
     * be indivisible or two concurrent callers both read count &lt; limit and both append (a TOCTOU race).
     * Redis runs a script on one thread, so the four commands are one transaction:
     * <ol>
     *   <li>{@code ZREMRANGEBYSCORE key -inf cutoff} — drop every hit at or before {@code now-W};</li>
     *   <li>{@code ZCARD key} — the number of surviving hits in the open window;(a)</li>
     *   <li>{@code ZADD key now member} — append THIS hit, scored by its millisecond timestamp;</li>
     *   <li>{@code PEXPIRE key windowMs} — so an idle key is reclaimed instead of lingering forever.</li>
     * </ol>
     * (a) The member is a caller-supplied unique token (a UUID from {@link #slidingWindow}), so two hits in
     * the same millisecond are two ZSET members, not one overwrite. Scores are epoch ms; the window is the
     * HALF-OPEN interval {@code (now-W, now]}, which is why the sweep uses an inclusive {@code -inf cutoff}.
     * All four commands take ARGV (never string-interpolated), keeping the script text constant/EVALSHA-able.
     *
     * <p>Every call appends a hit (including one that will be refused), so the returned ZCARD is the count
     * AFTER this hit — exactly {@link #increment(String, Duration)}'s "caller compares count to limit"
     * contract. Recording refused hits is deliberate: it keeps the Redis and fallback tiers identical and
     * means a burst cannot reset its own window by being throttled. The ZSET is bounded by the rate × window
     * and reclaimed by PEXPIRE; no production throughput is claimed here.
     *
     * <p>{@code nowMs} is injectable so a test can pin the clock and PROVE the boundary property without
     * sleeping; production passes {@link System#currentTimeMillis()}. The D932 fixed-window path is untouched.
     */
    static final String SLIDING_WINDOW_LUA =
            "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) "
          + "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]) "
          + "redis.call('PEXPIRE', KEYS[1], ARGV[4]) "
          + "return redis.call('ZCARD', KEYS[1])";

    /**
     * Sliding-window count over the last {@code windowMs} milliseconds, at the injected {@code nowMs}.
     * Returns the number of hits in the window AFTER appending this one; the caller decides admission by
     * comparing to its limit. The D932 fixed-window {@link #increment} path is untouched.
     */
    public long slidingWindow(String key, long windowMs, long nowMs, String member) {
        if (redis == null && tryReconnect()) { /* re-probed successfully */ }
        if (redis != null) {
            try {
                long w = Math.max(1L, windowMs);
                long cutoff = nowMs - w;
                Object result = redis.eval(SLIDING_WINDOW_LUA, io.lettuce.core.ScriptOutputType.INTEGER,
                        new String[]{key}, String.valueOf(cutoff), String.valueOf(nowMs),
                        member, String.valueOf(w));
                return ((Number) result).longValue();
            } catch (Exception e) {
                degrade(e);
            }
        }
        // ---- bounded in-memory fallback: same half-open window semantics, D909-style cap+sweep ----
        // A per-key list of hit timestamps (epoch ms). Entries are pruned by score on every write, so the
        // tail can never grow beyond `limit + 1` in normal use; the OUTER map is the bounded LRU, so the
        // number of distinct sliding keys is capped too. Both tiers together keep memory O(cap × limit).
        long w = Math.max(1L, windowMs);
        long cutoff = nowMs - w;
        synchronized (memory) {
            if (memory.size() >= fallbackMax) {
                sweepExpired(nowMs);
            }
            String hitsKey = "nexus:sw:" + key;
            Entry prev = memory.get(hitsKey);
            StringBuilder hits = new StringBuilder();
            long live = 0;
            if (prev != null && prev.expiresAt > nowMs) {
                for (String tok : prev.value.split(",", -1)) {
                    if (tok.isEmpty()) {
                        continue;
                    }
                    try {
                        long ts = Long.parseLong(tok);
                        if (ts > cutoff) { // half-open (now-W, now]
                            if (live > 0) {
                                hits.append(',');
                            }
                            hits.append(ts);
                            live++;
                        }
                    } catch (NumberFormatException ignored) {
                        // a corrupt token is dropped, never allowed to grow the list
                    }
                }
            }
            if (live > 0) {
                hits.append(',');
            }
            hits.append(nowMs);
            long count = live + 1;
            memory.put(hitsKey, new Entry(hits.toString(), nowMs + w));
            return count;
        }
    }

    /** Production convenience overload: wall-clock now and a unique member per call. */
    public long slidingWindow(String key, long windowMs) {
        return slidingWindow(key, windowMs, System.currentTimeMillis(), java.util.UUID.randomUUID().toString());
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
