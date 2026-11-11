package com.nexus.platform;

import java.nio.charset.StandardCharsets;

/**
 * D940 — deterministic cache-TTL decorrelation (the thundering-herd / cache-avalanche guard).
 *
 * <p>The problem: a batch of keys written with the SAME TTL (e.g. {@code TokenRegistry}'s refresh-family
 * keys, or any cache filled in one deploy/backfill) all expire at the SAME instant. At that instant every
 * miss lands on the backing store at once — a self-synchronised stampede. The naive fix, a per-process
 * {@code Random} added to the TTL, is WORSE than the disease in a distributed/cache setting: two instances
 * (or the same instance after a restart) give the SAME key DIFFERENT expiries, so a key's lifetime becomes
 * an unpredictable function of which pod wrote it, and the jitter itself becomes an inconsistency source
 * that cannot be reproduced or tested.
 *
 * <p>This unit instead derives the offset from a STABLE hash of the key: the same key always gets the same
 * offset, on every JVM, after every restart, on every node, and in the Python wire smoke. Decorrelation
 * comes from the keys DIFFERING, not from process-local entropy. It is a pure function — no clock, no
 * state, no injected dependency — so the boundary and the golden vector are exactly reproducible.
 *
 * <p><b>Why FNV-1a 64 and not {@link String#hashCode()}:</b> Java's String hash is specified but weak
 * (short keys cluster, and it is 32-bit), while FNV-1a is a published, trivially portable 64-bit byte
 * hash — the Python half of the wire smoke reproduces it byte-for-byte from the two constants below.
 * The {@code long} overflow in the multiply is INTENTIONAL mod-2^64 arithmetic; the resulting bit pattern
 * is identical in Java and Python (Python masks each step with {@code & 0xFFFFFFFFFFFFFFFF}).
 *
 * <p><b>The unsigned remainder is load-bearing.</b> FNV's top bit is set for about half of all keys, so as
 * a signed Java {@code long} the hash is negative. A plain {@code hash % spread} would return a NEGATIVE
 * offset for those keys, producing a TTL SHORTER than the caller asked for — a cache that expires early is
 * a worse defect than the avalanche it was meant to prevent. {@link Long#remainderUnsigned(long, long)}
 * keeps the offset in {@code [0, spread)}, so the TTL is only ever LENGTHENED. The wire falsifier plants
 * exactly this signed-remainder bug and requires the "never shortens" assertion to redden.
 */
public final class TtlJitter {

    /** FNV-1a 64-bit offset basis, as a Java signed long bit pattern (portable to Python via a 2^64 mask). */
    static final long FNV_OFFSET_BASIS = 0xcbf29ce484222325L;
    /** FNV-1a 64-bit prime. */
    static final long FNV_PRIME = 0x100000001b3L;

    private TtlJitter() {
    }

    /**
     * FNV-1a over the key's UTF-8 bytes. The multiply overflows a signed {@code long} by design: that is
     * mod-2^64 arithmetic, and the bit pattern is what the Python wire smoke reproduces. Do NOT "fix" the
     * overflow with Math.multiplyHigh or a widened type — the golden vector pins this exact bit pattern.
     */
    public static long fnv1a64(String key) {
        long h = FNV_OFFSET_BASIS;
        for (byte b : key.getBytes(StandardCharsets.UTF_8)) {
            h ^= (b & 0xffL);
            h *= FNV_PRIME;
        }
        return h;
    }

    /**
     * Return {@code baseTtlMs + offset}, where {@code offset = unsigned(hash(key)) % spreadMs}, so the
     * result is in {@code [baseTtlMs, baseTtlMs + spreadMs)} — never shorter than the requested TTL.
     *
     * @param key       the cache key; the offset is a stable function of it (same key -> same offset)
     * @param baseTtlMs the requested TTL in milliseconds; callers pass at least 1
     * @param spreadMs  the maximum extra lifetime; {@code <= 1} disables jitter (identity), which is what
     *                  the default-off configuration passes so the legacy path is byte-for-byte preserved
     */
    public static long jitterMs(String key, long baseTtlMs, long spreadMs) {
        if (spreadMs <= 1L) {
            return baseTtlMs;
        }
        // UNSIGNED remainder (see class javadoc): for ~half of keys the signed hash is negative, and a
        // signed % would shorten the TTL. Long.remainderUnsigned keeps offset in [0, spreadMs).
        long offset = Long.remainderUnsigned(fnv1a64(key), spreadMs);
        return baseTtlMs + offset;
    }
}
