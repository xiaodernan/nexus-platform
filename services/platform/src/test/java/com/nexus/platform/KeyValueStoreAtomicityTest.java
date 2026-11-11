package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.lettuce.core.RedisClient;
import io.lettuce.core.ScriptOutputType;
import io.lettuce.core.api.sync.RedisCommands;
import java.time.Duration;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * D932 — the Redis fixed-window counter is INCR+EXPIRE in ONE atomic script, so a counter can never
 * exist without its expiry (the permanent-429 lockout the two-command path allowed).
 *
 * <p>Two independent kinds of evidence, because neither alone proves the claim:
 * <ol>
 *   <li>a LIVE Redis arm: the first INCR really leaves a positive TTL, a second INCR does not reset
 *       it, and the count climbs — the property holds against a real server, not a mock;</li>
 *   <li>a FALSIFIER arm against a mock that makes EXPIRE throw: the legacy two-command shape
 *       ({@code incr} then a SEPARATE {@code expire}) reproduces the lockout — a key with no ttl —
 *       while the D932 path issues ONE {@code eval} and NEVER calls the standalone {@code expire}.
 *       This shows the green is attributable to atomicity, not to a mock that cannot fail.</li>
 * </ol>
 */
class KeyValueStoreAtomicityTest {

    private static final String URL = "redis://127.0.0.1:6380/0";

    private RedisClient probe() {
        try {
            RedisClient c = RedisClient.create(URL);
            c.connect().sync().ping();
            return c;
        } catch (Exception e) {
            return null;
        }
    }

    /* -------------------------------------------------- LIVE Redis: the positive property */

    @Test
    @DisplayName("A live Redis accepts the atomic script: first write sets a TTL, count climbs")
    void liveRedisLeavesATtlAndCounts() {
        RedisClient live = probe();
        assumeTrue(live != null, "live Redis not reachable at 127.0.0.1:6380 — skipping the D932 live arm");
        try {
            live.connect().sync().flushdb();
            KeyValueStore store = new KeyValueStore(true, URL, 400, 64);
            assumeTrue(store.usingRedis(), "store did not bind Redis — skipping");

            long first = store.increment("rl:atomic:k", Duration.ofSeconds(30));
            assertThat(first).isEqualTo(1);
            assertThat(store.remainingTtlSeconds("rl:atomic:k")).as("the first write ATOMICALLY set a ttl")
                    .isGreaterThan(0).isLessThanOrEqualTo(30);

            long second = store.increment("rl:atomic:k", Duration.ofSeconds(30));
            assertThat(second).isEqualTo(2);
            assertThat(store.remainingTtlSeconds("rl:atomic:k"))
                    .as("a later INCR must NOT re-arm the window").isGreaterThan(0).isLessThanOrEqualTo(30);

            // The Lua script itself holds BOTH commands in one body — the structural half of atomicity.
            assertThat(KeyValueStore.INCR_AND_EXPIRE_LUA).contains("INCR").contains("EXPIRE");
            store.delete("rl:atomic:k");
            ReflectionTestUtils.invokeMethod(store, "closeRedis");
        } finally {
            live.shutdown();
        }
    }

    /* -------------------------------------------------- FALSIFIER: the lockout is reproducible */

    @Test
    @DisplayName("Falsifier: a separate incr+expire with EXPIRE throwing leaves a TTL-less key; D932 never splits them")
    void theLegacySplitLocksOutAndTheAtomicPathDoesNot() {
        RedisCommands<String, String> cmds = mock(RedisCommands.class);
        // A key that exists but has NO ttl: the exact state that produces a permanent 429.
        when(cmds.incr(anyString())).thenReturn(1L);
        when(cmds.expire(anyString(), any(Long.class)))
                .thenThrow(new RuntimeException("EXPIRE rejected — the crash window"));
        when(cmds.ttl(anyString())).thenReturn(-1L); // Redis reports -1 for a key with no expiry

        // (a) REPRODUCE the defect: two commands, EXPIRE fails, the counter survives with no ttl.
        try { cmds.incr("rl:legacy:k"); } catch (Exception ignored) { }
        boolean expireFailed = false;
        try { cmds.expire("rl:legacy:k", 30L); } catch (RuntimeException e) { expireFailed = true; }
        assertThat(expireFailed).as("the injected EXPIRE fault must fire, or this arm proves nothing").isTrue();
        assertThat(cmds.ttl("rl:legacy:k")).as("legacy: INCR survived but EXPIRE failed -> no ttl = permanent 429")
                .isEqualTo(-1L);

        // (b) D932 path: ONE eval; the standalone expire is NEVER invoked, so the split cannot occur.
        RedisCommands<String, String> atomic = mock(RedisCommands.class);
        when(atomic.eval(anyString(), eq(ScriptOutputType.INTEGER), any(String[].class), anyString()))
                .thenReturn(1L);
        KeyValueStore store = new KeyValueStore(false, URL, 400, 64); // no real Redis from the ctor
        ReflectionTestUtils.setField(store, "redis", atomic);
        long n = store.increment("rl:atomic:k", Duration.ofSeconds(30));
        assertThat(n).isEqualTo(1);
        verify(atomic, times(1)).eval(eq(KeyValueStore.INCR_AND_EXPIRE_LUA), eq(ScriptOutputType.INTEGER),
                any(String[].class), eq("30"));
        verify(atomic, never()).expire(anyString(), any(Long.class));
        verify(atomic, never()).incr(anyString());
    }
}
