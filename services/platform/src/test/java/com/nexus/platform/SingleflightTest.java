package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * D944 — singleflight coalescing: N concurrent misses for one key run the loader ONCE, with a deterministic
 * CountDownLatch schedule that makes the check-then-load window real rather than timing-dependent.
 *
 * <p>Five tiers: (1) COALESCING — N threads miss the same key together, loaderCalls == 1 (a control WITHOUT
 * singleflight shows loaderCalls == N, so the assertion is load-bearing); (2) SHARED RESULT — every caller
 * receives the one loaded value; (3) FAILURE — a throwing loader's exception reaches ALL joiners and the
 * in-flight entry is cleared, so the NEXT call reloads instead of joining a dead future forever; (4) PARALLEL
 * KEYS — two different keys are in flight simultaneously (no global lock / head-of-line blocking); (5) the
 * primitive is stateless after return and rejects null keys.
 */
class SingleflightTest {

    private static final int N = 16;

    /* -------------------------------------------------- 1. COALESCING: one load for N concurrent misses */

    @Test
    @DisplayName("N concurrent misses for one key run the loader exactly ONCE and all share its value")
    void coalescesConcurrentMissesIntoOneLoad() throws Exception {
        Singleflight<String, String> sf = new Singleflight<>();
        AtomicInteger loaderCalls = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);   // all threads arrive before any enters run()
        CountDownLatch release = new CountDownLatch(1);     // test releases the owner's loader
        CountDownLatch loaderEntered = new CountDownLatch(1);

        ExecutorService pool = Executors.newFixedThreadPool(N);
        try {
            List<Future<String>> results = new ArrayList<>();
            for (int i = 0; i < N; i++) {
                results.add(pool.submit(() -> {
                    allAtGate.countDown();
                    return sf.run("cold:key", () -> {
                        loaderCalls.incrementAndGet();
                        loaderEntered.countDown();
                        await(release, "owner loader release");
                        return "value";
                    });
                }));
            }
            // Wait until every caller is poised at run(), THEN let the owner's loader finish. Followers must
            // be joining the owner's future, not entering the loader themselves.
            assertThat(allAtGate.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(loaderEntered.await(5, TimeUnit.SECONDS)).isTrue();
            Thread.sleep(50); // give any (buggy) duplicate loaders time to enter before we release
            release.countDown();

            for (Future<String> f : results) {
                assertThat(f.get(5, TimeUnit.SECONDS)).isEqualTo("value");
            }
            assertThat(loaderCalls.get()).as("N concurrent misses must collapse into ONE DB load")
                    .isEqualTo(1);
            assertThat(sf.inFlightCount()).as("the in-flight table is empty after all joins")
                    .isZero();
        } finally {
            pool.shutdownNow();
        }
    }

    /** The assertion above is load-bearing: WITHOUT coalescing, N threads each run the loader. */
    @Test
    @DisplayName("FALSIFIER: without singleflight the same schedule runs the loader N times")
    void withoutCoalescingTheLoaderRunsNTimes() throws Exception {
        AtomicInteger loaderCalls = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(N);
        try {
            List<Future<String>> results = new ArrayList<>();
            for (int i = 0; i < N; i++) {
                results.add(pool.submit(() -> {
                    allAtGate.countDown();
                    await(release, "control release");
                    loaderCalls.incrementAndGet(); // the raw check-then-load: every caller loads
                    return "value";
                }));
            }
            assertThat(allAtGate.await(5, TimeUnit.SECONDS)).isTrue();
            release.countDown();
            for (Future<String> f : results) {
                assertThat(f.get(5, TimeUnit.SECONDS)).isEqualTo("value");
            }
            assertThat(loaderCalls.get()).as("the control reproduces the N-fold stampede")
                    .isEqualTo(N);
        } finally {
            pool.shutdownNow();
        }
    }

    /* -------------------------------------------------- 2. FAILURE propagation + in-flight cleanup */

    @Test
    @DisplayName("A failing loader's exception reaches ALL joiners and the key is cleared for a fresh retry")
    void failurePropagatesToAllAndClearsInFlight() throws Exception {
        Singleflight<String, String> sf = new Singleflight<>();
        AtomicInteger calls = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(N);
        try {
            List<Future<Throwable>> errors = new ArrayList<>();
            for (int i = 0; i < N; i++) {
                errors.add(pool.submit(() -> {
                    allAtGate.countDown();
                    try {
                        sf.run("fail:key", () -> {
                            int n = calls.incrementAndGet();
                            await(release, "failure release");
                            throw new IllegalStateException("db-down-" + n);
                        });
                        return null;
                    } catch (CompletionException e) {
                        return e.getCause();
                    }
                }));
            }
            assertThat(allAtGate.await(5, TimeUnit.SECONDS)).isTrue();
            release.countDown();
            for (Future<Throwable> f : errors) {
                Throwable cause = f.get(5, TimeUnit.SECONDS);
                assertThat(cause).isInstanceOf(IllegalStateException.class)
                        .hasMessage("db-down-1"); // ALL joiners see the SAME owner's failure
            }
            assertThat(calls.get()).isEqualTo(1);          // one load, one failure, shared
            assertThat(sf.inFlightCount()).isZero();       // the failed future was removed
            // The NEXT request starts a fresh attempt rather than joining a dead future forever.
            assertThat(sf.run("fail:key", () -> "recovered")).isEqualTo("recovered");
        } finally {
            pool.shutdownNow();
        }
    }

    /* -------------------------------------------------- 3. DIFFERENT keys stay fully parallel */

    @Test
    @DisplayName("Two different keys are in flight simultaneously — no global lock or bin head-of-line blocking")
    void differentKeysRunInParallel() throws Exception {
        Singleflight<String, String> sf = new Singleflight<>();
        CountDownLatch bothEntered = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> a = pool.submit(() -> sf.run("key:a", () -> {
                bothEntered.countDown();
                await(release, "key a release");
                return "a";
            }));
            Future<String> b = pool.submit(() -> sf.run("key:b", () -> {
                bothEntered.countDown();
                await(release, "key b release");
                return "b";
            }));
            // If loads were serialized (a single lock / CHM bin), the second could not enter and this
            // latch would time out — the test would fail rather than hang.
            assertThat(bothEntered.await(5, TimeUnit.SECONDS))
                    .as("both distinct keys entered their loaders at the same time")
                    .isTrue();
            release.countDown();
            assertThat(a.get(5, TimeUnit.SECONDS)).isEqualTo("a");
            assertThat(b.get(5, TimeUnit.SECONDS)).isEqualTo("b");
        } finally {
            pool.shutdownNow();
        }
    }

    /* -------------------------------------------------- 4. primitive hygiene */

    @Test
    @DisplayName("A null value is a shareable result; a null key is rejected; state is empty after return")
    void nullValueAndKeyAndHygiene() {
        Singleflight<String, String> sf = new Singleflight<>();
        // A null RESULT (e.g. Optional.empty() mapped to null) is a legitimate shared value.
        assertThat(sf.run("k", () -> null)).isNull();
        assertThat(sf.inFlightCount()).isZero();
        assertThatThrownBy(() -> sf.run(null, () -> "x"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("must not be null");
        assertThat(sf.inFlightCount()).isZero();
    }

    private static void await(CountDownLatch latch, String what) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("timed out waiting for " + what);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted waiting for " + what, e);
        }
    }
}
