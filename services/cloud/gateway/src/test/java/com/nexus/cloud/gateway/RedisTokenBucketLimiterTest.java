package com.nexus.cloud.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * D1140 — the Redis token-bucket Lua is the enforcement path; this mirrors it bit-for-bit so the
 * arithmetic is pinned by golden vectors without a live Redis. The mirror is NOT a substitute for
 * the smoke: scripts/ratelimit_gateway_redis_smoke.sh measures the REAL script on a REAL Redis
 * across TWO gateway processes. If the two ever diverge, fix the Lua (and this mirror) together.
 */
class RedisTokenBucketLimiterTest {

    // --- pure mirror of TOKEN_BUCKET_LUA (caller computes `now`; capacity/refill in ARGV[1..2]) ---

    private static final class Entry {
        Double tokens;
        Long   ts;
    }

    private record Decision(int allowed, int returnedFloor) { }

    private static Decision eval(Entry e, long capacity, long refill, long now) {
        double tokens = e.tokens == null ? capacity : e.tokens;
        long   ts     = e.ts     == null ? now      : e.ts;
        double delta  = Math.max(0, (now - ts) / 1000.0);
        tokens = Math.min(capacity, tokens + delta * refill);
        int allowed = 0;
        if (tokens >= 1) { allowed = 1; tokens -= 1; }
        e.tokens = tokens;
        e.ts = now;
        return new Decision(allowed, (int) Math.floor(tokens));
    }

    @Test
    void theLuaBodyIssuesTheThreeCommandsTheDesignLeansOn() {
        String lua = RedisTokenBucketLimiter.TOKEN_BUCKET_LUA;
        assertThat(lua).contains("HMGET").contains("HSET").contains("PEXPIRE");
        assertThat(lua).doesNotContain("GETSET"); // one deliberately rejected shape
        assertThat(lua).contains("math.min(capacity"); // refill can never exceed capacity
        assertThat(lua).contains("math.max(0");        // a skewed clock never un-fills the bucket
    }

    @Test
    void aFreshBucketAdmitsExactlyCapacityThenRefuses() {
        Entry e = new Entry();
        assertThat(eval(e, 2, 1, 1_000L)).isEqualTo(new Decision(1, 1)); // 2 -> 1
        assertThat(eval(e, 2, 1, 1_000L)).isEqualTo(new Decision(1, 0)); // 1 -> 0
        assertThat(eval(e, 2, 1, 1_000L)).isEqualTo(new Decision(0, 0)); // empty
    }

    @Test
    void theBucketRefillsContinuouslyNotInWindows() {
        Entry e = new Entry();
        eval(e, 2, 1, 1_000L);   // tokens 1
        eval(e, 2, 1, 1_000L);   // tokens 0
        assertThat(eval(e, 2, 1, 2_000L)).isEqualTo(new Decision(1, 0));  // +1 over 1s -> admit, back to 0
        assertThat(eval(e, 2, 1, 2_100L)).isEqualTo(new Decision(0, 0)); // 100ms = 0.1 token, still empty
        assertThat(eval(e, 2, 1, 3_000L)).isEqualTo(new Decision(1, 0)); // 900ms more = 0.9+0.1=1.0 -> admit
    }

    @Test
    void aSkewedClockNeverUnfillsTheBucket() {
        Entry e = new Entry();
        eval(e, 2, 1, 9_000L);   // tokens 1, ts 9000
        assertThat(eval(e, 2, 1, 1_000L)).isEqualTo(new Decision(1, 0)); // now < ts -> delta forced to 0
        assertThat(eval(e, 2, 1, 1_000L)).isEqualTo(new Decision(0, 0));
    }

    @Test
    void aVeryLongIdleNeverExceedsCapacity() {
        Entry e = new Entry();
        eval(e, 3, 10, 1_000L);  // drain one
        Decision d = eval(e, 3, 10, 999_999_000L);
        assertThat(d.allowed()).isEqualTo(1);
        assertThat(d.returnedFloor()).isEqualTo(2); // clamped at cap-1 after the admit, never > cap-1
    }

    @Test
    void aZeroRefillBucketIsAPureLeakyBucket() {
        Entry e = new Entry();
        eval(e, 1, 0, 1_000L);
        assertThat(eval(e, 1, 0, 9_999_000L)).isEqualTo(new Decision(0, 0)); // never refills
    }

    @Test
    void theDisabledTwinNeverClaimsAStoreExists() {
        RedisTokenBucketLimiter disabled = RedisTokenBucketLimiter.disabled();
        assertThat(disabled.isEnabled()).isFalse();
        assertThat(disabled.timeout()).isPositive();
    }
}
