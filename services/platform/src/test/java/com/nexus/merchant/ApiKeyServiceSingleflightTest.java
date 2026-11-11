package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.nexus.platform.AuditService;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * D944 — the singleflight primitive is WIRED into ApiKeyService.verify()'s cold-key miss path, and the
 * wiring is load-bearing: with {@code verify-singleflight-enabled=true}, N concurrent misses for one secret
 * hash run the DB loader ONCE; with it OFF (the D933 default) the same schedule runs it N times.
 *
 * <p>This is the penetration defect the primitive exists to close: D933's LRU guarded only the map lookup;
 * the SELECT ran AFTER the lock was released, so N cold-key callers each queried Postgres. The test drives
 * the REAL verify()/cacheKey/singleflight path with a deterministic latch, on ONE SHARED service instance
 * (a per-thread instance would have a per-thread singleflight and could never coalesce).
 */
@ExtendWith(MockitoExtension.class)
class ApiKeyServiceSingleflightTest {

    private static final int N = 12;
    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID MERCHANT = UUID.randomUUID();
    private static final UUID KEY_ID = UUID.randomUUID();
    private static final TenantContext TCTX =
            new TenantContext(TENANT, "test-tenant", "hkd", "Asia/Hong_Kong", "HK");
    private static final String RAW_KEY = "nx_live_9f6edeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefde";
    /** cache TTL > 0 so verify() enters the branch that wraps the load in singleflight. */
    private static final long CACHE_TTL_MS = 10_000L;

    @Mock private TenantJdbc jdbc;
    @Mock private PermissionService permissions;
    @Mock private AuditService audit;

    private ApiKeyService service(boolean singleflightOn) {
        return new ApiKeyService(jdbc, permissions, audit, CACHE_TTL_MS, 512, 0, 1024, singleflightOn);
    }

    private void stubSlowLoader(AtomicInteger loads, CountDownLatch entered, CountDownLatch release) {
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any())).thenAnswer(inv -> {
            loads.incrementAndGet();
            entered.countDown();
            if (!release.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("release timeout");
            return Optional.of(Map.of("id", KEY_ID, "merchant_id", MERCHANT));
        });
    }

    @Test
    @DisplayName("singleflight ON: N concurrent verify() misses for one hash run the DB loader exactly ONCE")
    void onCoalescesTheColdKeyMiss() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);
        CountDownLatch ownerEntered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        stubSlowLoader(loads, ownerEntered, release);
        ApiKeyService shared = service(true); // ONE instance -> ONE singleflight table

        ExecutorService pool = Executors.newFixedThreadPool(N);
        try {
            List<Future<Optional<Principal>>> results = new ArrayList<>();
            for (int i = 0; i < N; i++) {
                results.add(pool.submit(() -> {
                    allAtGate.countDown();
                    return shared.verify(RAW_KEY, TCTX);
                }));
            }
            assertThat(allAtGate.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(ownerEntered.await(5, TimeUnit.SECONDS)).isTrue();
            // The owner is blocked in the loader; give the other N-1 callers time to pass the LRU miss and
            // join the owner's future rather than entering the loader. If coalescing were absent, loads
            // would already be climbing toward N here.
            Thread.sleep(80);
            release.countDown();
            for (Future<Optional<Principal>> f : results) {
                assertThat(f.get(5, TimeUnit.SECONDS)).isPresent();
            }
            assertThat(loads.get()).as("singleflight ON must collapse N cold misses into ONE query").isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("FALSIFIER singleflight OFF: the SAME schedule runs the DB loader N times (the D933 window)")
    void offReproducesTheNPenetration() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch allAtGate = new CountDownLatch(N);
        CountDownLatch allEntered = new CountDownLatch(N);
        CountDownLatch release = new CountDownLatch(1);
        stubSlowLoader(loads, allEntered, release);
        ApiKeyService shared = service(false); // singleflight OFF -> the exact D933 check-then-load

        ExecutorService pool = Executors.newFixedThreadPool(N);
        try {
            List<Future<Optional<Principal>>> results = new ArrayList<>();
            for (int i = 0; i < N; i++) {
                results.add(pool.submit(() -> {
                    allAtGate.countDown();
                    return shared.verify(RAW_KEY, TCTX);
                }));
            }
            assertThat(allAtGate.await(5, TimeUnit.SECONDS)).isTrue();
            // Deterministic: wait until ALL N callers are blocked in their own loader before releasing — no
            // timing guess. With singleflight OFF there is nothing to join, so all N must enter.
            assertThat(allEntered.await(5, TimeUnit.SECONDS))
                    .as("without coalescing every caller enters its own DB load").isTrue();
            release.countDown();
            for (Future<Optional<Principal>> f : results) {
                assertThat(f.get(5, TimeUnit.SECONDS)).isPresent();
            }
            assertThat(loads.get()).as("singleflight OFF reproduces the N-fold stampede").isEqualTo(N);
        } finally {
            pool.shutdownNow();
        }
    }
}
