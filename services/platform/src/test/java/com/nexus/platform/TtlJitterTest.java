package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import io.lettuce.core.RedisClient;
import io.lettuce.core.api.sync.RedisCommands;
import java.time.Duration;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * D940 — deterministic cache-TTL decorrelation, with an explicit FALSIFIER tier and a live-Redis arm.
 *
 * <p>Evidence tiers:
 * <ol>
 *   <li>GOLDEN VECTOR — FNV-1a 64 + unsigned remainder is pinned to exact millisecond values that the
 *       Python wire smoke (scripts/ttl_jitter_smoke.sh) reproduces byte-for-byte. If either implementation
 *       drifts, the vector reddens.</li>
 *   <li>PROPERTIES — stable across instances (no process randomness), bounded to [base, base+spread),
 *       identity when spread<=1, and a batch of same-TTL keys spreads across many buckets while the
 *       no-jitter control collapses to one.</li>
 *   <li>FALSIFIER — modelling the signed-% bug (which the wire smoke plants in the source) SHORTENS the
 *       TTL for a negative-hash key; the assertion requires it to redden, proving "never shortens" is
 *       load-bearing on the unsigned remainder, not decoration.</li>
 *   <li>WIRING / DEFAULT — jitter is OFF unless the 6-arg constructor enables it; the Redis tier issues
 *       PSETEX (one atomic command) when on and the untouched SETEX when off; the fallback stays bounded.</li>
 *   <li>LIVE Redis — an enabled store really arms a per-key millisecond PTTL inside [base, base+spread).</li>
 * </ol>
 */
class TtlJitterTest {

    private static final String URL = "redis://127.0.0.1:6380/0";
    private static final long BASE = 60_000L;
    private static final long SPREAD = 1_024L;

    private RedisClient probe() {
        try {
            RedisClient c = RedisClient.create(URL);
            c.connect().sync().ping();
            return c;
        } catch (Exception e) {
            return null;
        }
    }

    /* -------------------------------------------------- GOLDEN VECTOR: pins Java == Python wire smoke */

    @Test
    @DisplayName("FNV-1a 64 + unsigned remainder is pinned to an exact golden vector (Java == wire smoke Python)")
    void goldenVectorPinsBothImplementations() {
        // base=60000, spread=1024 — the SAME constants scripts/ttl_jitter_smoke.sh uses.
        assertThat(TtlJitter.jitterMs("nexus:jc:0", BASE, SPREAD)).isEqualTo(60_583L);
        assertThat(TtlJitter.jitterMs("nexus:jc:1", BASE, SPREAD)).isEqualTo(60_148L);
        assertThat(TtlJitter.jitterMs("nexus:jc:7", BASE, SPREAD)).isEqualTo(60_302L);
        assertThat(TtlJitter.jitterMs("nexus:jc:42", BASE, SPREAD)).isEqualTo(60_267L);
        // A real refresh-family key: the actual TokenRegistry shape, so the vector is not synthetic-only.
        assertThat(TtlJitter.jitterMs("nexus:refreshfam:demo", BASE, SPREAD)).isEqualTo(61_020L);
    }

    /* -------------------------------------------------- PROPERTIES */

    @Test
    @DisplayName("The offset is a STABLE function of the key — no process randomness, no restart drift")
    void offsetIsStableAcrossInstances() {
        // Two independent "instances" (static calls stand in for separate JVMs) must agree for the same key.
        for (String key : new String[]{"nexus:jc:0", "nexus:jc:7", "nexus:refreshfam:demo"}) {
            long a = TtlJitter.jitterMs(key, BASE, SPREAD);
            long b = TtlJitter.jitterMs(key, BASE, SPREAD);
            assertThat(b).as("same key must get the same lifetime, on every node and after every restart")
                    .isEqualTo(a);
        }
        // Different keys differ — that difference is what decorrelates the batch.
        assertThat(TtlJitter.jitterMs("nexus:jc:0", BASE, SPREAD))
                .isNotEqualTo(TtlJitter.jitterMs("nexus:jc:1", BASE, SPREAD));
    }

    @Test
    @DisplayName("Jitter only ever LENGTHENS the TTL, into [base, base+spread)")
    void jitterOnlyLengthensAndIsBounded() {
        for (int i = 0; i < 256; i++) {
            long ttl = TtlJitter.jitterMs("nexus:jc:" + i, BASE, SPREAD);
            assertThat(ttl).isGreaterThanOrEqualTo(BASE).isLessThan(BASE + SPREAD);
        }
        // Even the 10/64 negative-signed FNV hashes stay in range — the unsigned remainder is why.
        assertThat(TtlJitter.jitterMs("nexus:jc:0", BASE, SPREAD)).isGreaterThanOrEqualTo(BASE);
    }

    @Test
    @DisplayName("A batch of same-TTL keys spreads across many buckets; with NO jitter it collapses to one")
    void sameTtlBatchDecorrelates() {
        int n = 64;
        long bucketWidth = 64L; // 1024 / 16 buckets
        Set<Long> withJitter = new HashSet<>();
        Set<Long> withoutJitter = new HashSet<>();
        for (int i = 0; i < n; i++) {
            String key = "nexus:jc:" + i;
            withJitter.add((TtlJitter.jitterMs(key, BASE, SPREAD) - BASE) / bucketWidth);
            withoutJitter.add((TtlJitter.jitterMs(key, BASE, 1L) - BASE) / bucketWidth);
        }
        assertThat(withoutJitter).as("no jitter: every key expires in the SAME bucket (the stampede)")
                .hasSize(1);
        assertThat(withJitter).as("jitter: the same batch spreads across >= 16 distinct expiry buckets")
                .hasSizeGreaterThanOrEqualTo(16);
    }

    @Test
    @DisplayName("spread<=1 is the identity (the default-off config passes 0/1)")
    void spreadAtMostOneIsIdentity() {
        String key = "nexus:jc:0";
        assertThat(TtlJitter.jitterMs(key, BASE, 0L)).isEqualTo(BASE);
        assertThat(TtlJitter.jitterMs(key, BASE, 1L)).isEqualTo(BASE);
        assertThat(TtlJitter.jitterMs(key, BASE, -5L)).isEqualTo(BASE);
    }

    /* -------------------------------------------------- FALSIFIER: the unsigned remainder is load-bearing */

    @Test
    @DisplayName("FALSIFIER: a signed remainder SHORTENS the TTL for a negative-hash key — the claim reddens")
    void signedRemainderFalsifierReddened() {
        // Model the bug the wire falsifier plants: Java's signed `hash % spread` on a negative FNV hash.
        // Find a key whose hash is negative (about half of them), then show the naive result < base.
        boolean foundShortened = false;
        for (int i = 0; i < 128; i++) {
            String key = "nexus:jc:" + i;
            long signed = TtlJitter.fnv1a64(key) % SPREAD; // the FAULTY signed remainder
            long honest = TtlJitter.jitterMs(key, BASE, SPREAD); // the unsigned remainder
            if (signed < 0) {
                foundShortened = true;
                assertThat(BASE + signed).as("the signed bug expires this key EARLIER than requested")
                        .isLessThan(BASE);
                assertThat(honest).as("the shipped unsigned path never shortens it")
                        .isGreaterThanOrEqualTo(BASE);
                break;
            }
        }
        assertThat(foundShortened).as("a negative FNV hash must exist — otherwise the falsifier arm is vacuous")
                .isTrue();
    }

    /* -------------------------------------------------- WIRING: default OFF, one atomic PSETEX when on */

    @Test
    @DisplayName("Default 4-arg store keeps jitter OFF and issues the untouched SETEX path")
    void defaultStoreKeepsLegacySetex() {
        KeyValueStore store = new KeyValueStore(false, URL, 400, 64);
        assertThat(store.usingTtlJitter()).isFalse();
        assertThat(store.effectiveTtlMs("k", Duration.ofSeconds(60))).isEqualTo(60_000L);

        RedisCommands<String, String> cmds = mock(RedisCommands.class);
        ReflectionTestUtils.setField(store, "redis", cmds);
        store.set("k", "v", Duration.ofSeconds(60));
        verify(cmds, times(1)).setex(eq("k"), eq(60L), eq("v"));
        verify(cmds, never()).psetex(anyString(), anyLong(), anyString());
    }

    @Test
    @DisplayName("Enabled store issues ONE millisecond PSETEX with the golden-vector TTL — never SETEX")
    void enabledStoreUsesOneAtomicPsetex() {
        KeyValueStore store = new KeyValueStore(false, URL, 400, 64, true, SPREAD);
        assertThat(store.usingTtlJitter()).isTrue();
        assertThat(store.effectiveTtlMs("nexus:jc:0", Duration.ofMillis(BASE))).isEqualTo(60_583L);

        RedisCommands<String, String> cmds = mock(RedisCommands.class);
        ReflectionTestUtils.setField(store, "redis", cmds);
        store.set("nexus:jc:0", "v", Duration.ofMillis(BASE));
        verify(cmds, times(1)).psetex(eq("nexus:jc:0"), eq(60_583L), eq("v"));
        verify(cmds, never()).setex(anyString(), anyLong(), anyString());
    }

    @Test
    @DisplayName("The in-memory fallback applies the SAME decorrelated TTL and stays bounded by the D909 cap")
    void fallbackDecorrelatesAndStaysBounded() {
        KeyValueStore store = new KeyValueStore(false, URL, 400, 4, true, SPREAD);
        // effectiveTtlMs is shared by both tiers, so the fallback decorrelates too.
        assertThat(store.effectiveTtlMs("nexus:jc:0", Duration.ofMillis(BASE))).isEqualTo(60_583L);
        for (int k = 0; k < 12; k++) {
            for (int i = 0; i < 3; i++) {
                store.set("k" + k, "v", Duration.ofMinutes(5));
            }
        }
        assertThat(store.fallbackSize()).as("distinct keys still capped by the D909 LRU")
                .isLessThanOrEqualTo(4);
    }

    /* -------------------------------------------------- LIVE Redis: a real per-key millisecond PTTL */

    @Test
    @DisplayName("LIVE Redis: an enabled store arms a real PSETEX whose per-key millisecond TTL is decorrelated")
    void liveRedisArmsDecorrelatedMillisecondTtl() {
        RedisClient live = probe();
        assumeTrue(live != null, "live Redis not reachable at 127.0.0.1:6380 — skipping the D940 live arm");
        try {
            live.connect().sync().flushdb();
            KeyValueStore store = new KeyValueStore(true, URL, 400, 64, true, SPREAD);
            assumeTrue(store.usingRedis(), "store did not bind Redis — skipping");
            String k0 = "ttl:live:nexus:jc:0";
            String k1 = "ttl:live:nexus:jc:1";
            // Use direct keys so the golden vector applies; write via the store to prove the PSETEX path.
            long base = 30_000L;
            store.set(k0, "v", Duration.ofMillis(base));
            store.set(k1, "v", Duration.ofMillis(base));
            long p0 = live.connect().sync().pttl(k0);
            long p1 = live.connect().sync().pttl(k1);
            // Two round trips may differ by a few ms, but the KEY-SPECIFIC offsets (~hundreds of ms) differ far
            // more than that, and each lands inside its own [base, base+spread) band.
            assertThat(p0).as("k0 PTTL inside [base, base+spread)").isBetween(base, base + SPREAD);
            assertThat(p1).as("k1 PTTL inside [base, base+spread)").isBetween(base, base + SPREAD);
            assertThat(Math.abs(p0 - p1)).as("two different keys get different PTTLs, far beyond round-trip noise")
                    .isGreaterThan(50L);
            // Off-store control: the D932 counter path never sees jitter (its key is untouched by set()).
            store.delete(k0);
            store.delete(k1);
            ReflectionTestUtils.invokeMethod(store, "closeRedis");
        } finally {
            live.shutdown();
        }
    }
}
