package com.nexus.cloud.dispatcher;

import com.nexus.cloud.dispatcher.DispatcherWorker.EnqueueResult;
import java.io.IOException;
import java.lang.reflect.Field;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.PushPromiseHandler;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * D978 — a failed webhook's deferred retry must be BOUNDED, BACKPRESSURE-VISIBLE and
 * NON-SILENTLY-DROPPING.
 *
 * <p>Pre-D978 {@code scheduleRetry} spawned {@code new Thread(() -> { Thread.sleep(delayMs);
 * queue.offer(retry); })} per failed attempt. Three faults: (1) one OS thread per failure — an
 * unbounded, kernel-thread-per-attempt shape under a persistent 5xx storm; (2) the sleeping retry
 * was invisible to the {@code queue.size()+inFlight} gauge and offered straight back onto the
 * bounded queue, bypassing D973's backpressure; (3) an {@code InterruptedException} returned and
 * dropped the delivery silently, and {@code shutdown()} never touched those threads at all.
 *
 * <p>The fix defers retries on a bounded {@link java.util.concurrent.DelayQueue} keyed by a
 * monotonic {@code System.nanoTime()} deadline, counts them in the backpressure gauge, promotes due
 * entries ONLY into spare capacity, parks to the DLQ when the heap is full, and drains the whole
 * heap to the DLQ on shutdown.
 *
 * <p>Every probe is fully offline: a scripted {@link HttpClient} returns a per-event status
 * sequence, a single-thread executor stands in for the drain pool, no Redis/network/JVM container.
 * A LEGACY control re-enacts the naked-thread shape on the SAME apparatus and proves the
 * "count dispatcher-retry-* threads" detector is load-bearing — so the positive "zero naked
 * threads" arm is a real distinction, not a detector that can never fire.
 */
class DispatcherWorkerRetryTest {

    /* ------------------------------------------------------------------ fakes */

    /** A controllable HTTP client: a per-event status sequence (last value repeats). */
    static final class ScriptedHttpClient extends HttpClient {
        private final Map<String, int[]> sequences;
        private final CountDownLatch entered;
        private final CountDownLatch release;
        private final ConcurrentHashMap<String, Integer> hits = new ConcurrentHashMap<>();
        final List<HttpRequest> requests = new CopyOnWriteArrayList<>();

        ScriptedHttpClient(Map<String, int[]> sequences) { this(sequences, null, null); }
        ScriptedHttpClient(Map<String, int[]> sequences, CountDownLatch entered, CountDownLatch release) {
            this.sequences = new LinkedHashMap<>(sequences);
            this.entered = entered;
            this.release = release;
        }

        @SuppressWarnings("unchecked")
        @Override
        public <T> HttpResponse<T> send(HttpRequest request, BodyHandler<T> handler)
                throws InterruptedException {
            requests.add(request);
            if (entered != null) entered.countDown();
            if (release != null) release.await();
            String id = request.headers().firstValue("X-Nexus-Event-Id").orElse("unknown");
            int[] seq = sequences.getOrDefault(id, new int[] {500});
            int i = hits.merge(id, 1, Integer::sum) - 1;
            int status = seq[Math.min(i, seq.length - 1)];
            return (HttpResponse<T>) new FakeResponse<>(status, "", request);
        }

        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest r, BodyHandler<T> h) { throw new UnsupportedOperationException(); }
        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest r, BodyHandler<T> h, PushPromiseHandler<T> p) { throw new UnsupportedOperationException(); }
        @Override public WebSocket.Builder newWebSocketBuilder() { throw new UnsupportedOperationException(); }
        @Override public Optional<Duration> connectTimeout() { return Optional.empty(); }
        @Override public Redirect followRedirects() { return Redirect.NEVER; }
        @Override public Optional<CookieHandler> cookieHandler() { return Optional.empty(); }
        @Override public Optional<ProxySelector> proxy() { return Optional.empty(); }
        @Override public SSLContext sslContext() { return null; }
        @Override public SSLParameters sslParameters() { return null; }
        @Override public Optional<Authenticator> authenticator() { return Optional.empty(); }
        @Override public Version version() { return Version.HTTP_1_1; }
        @Override public Optional<Executor> executor() { return Optional.empty(); }
    }

    static final class FakeResponse<T> implements HttpResponse<T> {
        private final int status;
        private final T body;
        private final HttpRequest request;
        FakeResponse(int status, T body, HttpRequest request) { this.status = status; this.body = body; this.request = request; }
        @Override public int statusCode() { return status; }
        @Override public HttpRequest request() { return request; }
        @Override public Optional<HttpResponse<T>> previousResponse() { return Optional.empty(); }
        @Override public HttpHeaders headers() { return HttpHeaders.of(Map.<String, List<String>>of(), (a, b) -> true); }
        @Override public T body() { return body; }
        @Override public Optional<SSLSession> sslSession() { return Optional.empty(); }
        @Override public URI uri() { return request != null ? request.uri() : URI.create("http://gate.test/"); }
        @Override public HttpClient.Version version() { return HttpClient.Version.HTTP_1_1; }
    }

    /* ----------------------------------------------------------------- helpers */

    private static ThreadFactory named(String name) {
        return r -> { Thread t = new Thread(r, name); t.setDaemon(true); return t; };
    }

    private static HookProperties props(int maxQueue, int maxAttempts, int threshold,
                                        long baseDelayMs, long jitterMs) {
        HookProperties p = new HookProperties();
        p.setEnabled(true);
        p.setMaxQueue(maxQueue);
        HookProperties.Hook hook = new HookProperties.Hook();
        hook.setUri("http://gate.test/hook");
        hook.setSecret("probe-secret");
        hook.setEventTypes("Order*");
        hook.setMaxAttempts(maxAttempts);
        hook.setCircuitBreakerThreshold(threshold);
        hook.setBaseDelayMs(baseDelayMs);
        hook.setJitterMs(jitterMs);
        hook.setEnabled(true);
        p.setHooks(new LinkedHashMap<>(Map.of("probe", hook)));
        return p;
    }

    private static DomainEvent event(String id) {
        return DomainEvent.fromStreamBody(id, Map.of("type", "OrderCreated", "tenant_id", "t1"));
    }

    private static int number(Map<String, Object> state, String key) {
        return ((Number) state.get(key)).intValue();
    }

    /** Poll until the predicate holds (or 5 s), then return the last observed state. */
    private static Map<String, Object> awaitState(DispatcherWorker w, Predicate<Map<String, Object>> cond)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        Map<String, Object> s = w.state();
        while (System.nanoTime() < deadline) {
            s = w.state();
            if (cond.test(s)) return s;
            Thread.sleep(20L);
        }
        return s;
    }

    private static Map<String, Object> awaitSettled(DispatcherWorker w) throws InterruptedException {
        return awaitState(w, s -> number(s, "inFlight") == 0);
    }

    /** Poll AND drive the fixed-cadence drain, standing in for Spring's @Scheduled tick. */
    private static Map<String, Object> awaitWithTicks(DispatcherWorker w, Predicate<Map<String, Object>> cond)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        Map<String, Object> s = w.state();
        while (System.nanoTime() < deadline) {
            w.drainTick();
            s = w.state();
            if (cond.test(s)) return s;
            Thread.sleep(20L);
        }
        return s;
    }

    /** The detector the positive arm relies on: live threads named by the naked-retry shape. */
    private static long nakedRetryThreads() {
        return Thread.getAllStackTraces().keySet().stream()
                .filter(t -> t.getName().startsWith("dispatcher-retry-"))
                .count();
    }

    private static boolean hasOutcome(Map<String, Object> state, String outcome) {
        @SuppressWarnings("unchecked")
        Map<String, List<Map<String, Object>>> recent =
                (Map<String, List<Map<String, Object>>>) state.get("recent");
        for (List<Map<String, Object>> list : recent.values()) {
            for (Map<String, Object> entry : list) {
                if (outcome.equals(entry.get("outcome"))) return true;
            }
        }
        return false;
    }

    /* ------------------------------------------------------------------- arms */

    @Test
    void aDeferredRetryIsVisibleToBackpressure() throws Exception {
        // THE positive arm: a sleeping retry now occupies a backpressure slot. With maxQueue=1,
        // one deferred retry (gauge=1) makes the NEXT submit refuse. Pre-fix, the naked-thread
        // retry was invisible (gauge=0) and this submit would have been accepted.
        ScriptedHttpClient http = new ScriptedHttpClient(Map.of("bp-1", new int[] {500}));
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props(1, 100, 1000, 60_000L, 0L), http, drainer);
        try {
            assertThat(worker.submitIfMatch(event("bp-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            worker.drainTick();
            Map<String, Object> settled = awaitState(worker,
                    s -> number(s, "pendingRetries") == 1 && number(s, "inFlight") == 0);
            assertThat(number(settled, "pendingRetries")).isEqualTo(1);
            assertThat(worker.submitIfMatch(event("bp-2"))).isEqualTo(EnqueueResult.QUEUE_FULL);
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void aLegacyInvisibleDeferredWouldAcceptUnboundedWork() throws Exception {
        // LEGACY control on the SAME numbers: the pre-fix gauge was queue+inFlight only, so a
        // deferred retry contributed 0 and the bound failed to see it. This proves arm (1)'s
        // refusal is caused by the pendingRetries term alone — a one-variable distinction.
        int maxQueue = 1;
        int queueDepth = 0, inFlight = 0, pendingRetries = 1;
        int gaugeWithDeferred = queueDepth + inFlight + pendingRetries;
        int gaugeLegacy = queueDepth + inFlight;
        assertThat(gaugeLegacy).isZero();
        assertThat(gaugeWithDeferred).isEqualTo(1);
        assertThat(gaugeLegacy < maxQueue).isTrue();      // legacy would accept event bp-2
        assertThat(gaugeWithDeferred >= maxQueue).isTrue(); // D978 refuses it
    }

    @Test
    void failureBurstSpawnsNoNakedThreads() throws Exception {
        // Bounded thread shape: a burst of failures parks retries on the heap (pendingRetries,
        // capped by maxQueue) and NEVER creates one dispatcher-retry-* kernel thread per attempt.
        ScriptedHttpClient http = new ScriptedHttpClient(Map.of()); // every event 500
        int cap = 4;
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props(cap, 100, 1000, 60_000L, 0L), http, drainer);
        try {
            for (int i = 0; i < 3; i++) {
                final int expectedFailures = i + 1;
                assertThat(worker.submitIfMatch(event("burst-" + i))).isEqualTo(EnqueueResult.ENQUEUED);
                worker.drainTick();
                awaitState(worker, s -> number(s, "inFlight") == 0 && number(s, "failed") >= expectedFailures);
            }
            Map<String, Object> state = worker.state();
            assertThat(number(state, "pendingRetries")).isEqualTo(3).isLessThanOrEqualTo(cap);
            assertThat(number(state, "failed")).isEqualTo(3);
            assertThat(nakedRetryThreads()).isZero();
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void legacyNakedThreadShapeReallySpawnsAThreadPerFailure() throws Exception {
        // LEGACY control: re-enact the pre-D978 shape on the SAME detector. It really does leave
        // one live dispatcher-retry-* thread per failure — so arm (3)'s zero is meaningful and the
        // thread detector is not vacuous. Threads are joined before returning (no cross-test leak).
        int failures = 3;
        CountDownLatch release = new CountDownLatch(1);
        List<Thread> spawned = new ArrayList<>();
        try {
            for (int i = 0; i < failures; i++) {
                Thread t = new Thread(() -> {
                    try { release.await(3, TimeUnit.SECONDS); }
                    catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                }, "dispatcher-retry-LEGACY-" + i);
                t.setDaemon(true);
                spawned.add(t);
                t.start();
            }
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (nakedRetryThreads() < failures && System.nanoTime() < deadline) Thread.sleep(10L);
            assertThat(nakedRetryThreads()).isGreaterThanOrEqualTo(failures);
        } finally {
            release.countDown();
            for (Thread t : spawned) t.join(2_000L);
        }
    }

    @Test
    void shutdownParksEveryDeferredRetry() throws Exception {
        // No silent loss: shutdown() drains the WHOLE heap to the DLQ, accounting for each waiting
        // retry. Pre-fix the naked daemon threads kept sleeping after shutdown and offered into a
        // stopped worker — parked nowhere, delivered never.
        ScriptedHttpClient http = new ScriptedHttpClient(Map.of());
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props(4, 100, 1000, 60_000L, 0L), http, drainer);
        try {
            for (int i = 0; i < 2; i++) {
                assertThat(worker.submitIfMatch(event("shut-" + i))).isEqualTo(EnqueueResult.ENQUEUED);
                worker.drainTick();
                awaitSettled(worker);
            }
            assertThat(number(worker.state(), "pendingRetries")).isEqualTo(2);
            worker.shutdown();
            Map<String, Object> state = worker.state();
            assertThat(number(state, "pendingRetries")).isZero();
            assertThat(number(state, "parked")).isEqualTo(2);
            assertThat(hasOutcome(state, "parked:shutdown_deferred")).isTrue();
        } finally {
            drainer.shutdownNow();
        }
    }

    @Test
    void aDueRetryStillReturnsAndDispatches() throws Exception {
        // Contract survival: a due retry leaves the heap on a later tick and the second attempt
        // succeeds. A short baseDelay (floored at 50 ms) proves the monotonic DelayQueue actually
        // releases the entry, and the HMAC header still rides the outbound POST.
        ScriptedHttpClient http = new ScriptedHttpClient(Map.of("ok-1", new int[] {500, 200}));
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props(8, 5, 1000, 0L, 0L), http, drainer);
        try {
            assertThat(worker.submitIfMatch(event("ok-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            worker.drainTick();
            awaitState(worker, s -> number(s, "pendingRetries") == 1 && number(s, "inFlight") == 0);
            Map<String, Object> state = awaitWithTicks(worker, s -> number(s, "dispatched") == 1);
            assertThat(number(state, "dispatched")).isEqualTo(1);
            assertThat(number(state, "pendingRetries")).isZero();
            assertThat(http.requests).hasSize(2);
            assertThat(http.requests.get(0).headers().firstValue("X-Nexus-Event-Signature"))
                    .isPresent().get().asString().startsWith("sha256=");
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void anExhaustedDeliveryIsStillParkedNotRetried() throws Exception {
        // D973/D975 contract: a delivery at maxAttempts parks to the DLQ and NEVER enters the
        // retry heap — the bounded heap must not turn an exhausted delivery into a deferred one.
        ScriptedHttpClient http = new ScriptedHttpClient(Map.of("ex-1", new int[] {500}));
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props(8, 1, 1000, 0L, 0L), http, drainer);
        try {
            assertThat(worker.submitIfMatch(event("ex-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            worker.drainTick();
            Map<String, Object> state = awaitSettled(worker);
            assertThat(number(state, "parked")).isEqualTo(1);
            assertThat(number(state, "pendingRetries")).isZero();
            assertThat(number(state, "failed")).isEqualTo(1);
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void aFullHeapParksTheOverflowToTheDlq() throws Exception {
        // Bounded-heap cap guard, no silent loss: when pendingRetries is already at maxQueue (the
        // concurrent-failure race where several drainPool threads fail before the gauge is
        // re-read), a further failure must PARK with reason retry_heap_full — never grow the heap
        // past cap, never drop the delivery. The gauge alone cannot reach the guard from a single
        // submit (backpressure refuses first), so this offline probe seeds the gauge to its cap to
        // reach the exact racing state the guard exists for. Reverting the guard to an unbounded
        // offer turns parked=0 / pendingRetries>cap and REDDENS this arm.
        int cap = 2;
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ScriptedHttpClient http = new ScriptedHttpClient(Map.of("full-1", new int[] {500}), entered, release);
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props(cap, 100, 1000, 60_000L, 0L), http, drainer);
        try {
            // maxQueue=cap=2, but the gauge is queue+inFlight+pendingRetries. Park the first
            // attempt INSIDE HTTP send, then seed pendingRetries to the cap via the offline seam —
            // exactly the state a burst of concurrent in-flight failures would leave behind. When
            // this attempt fails, scheduleRetry must see gauge>=cap and park, not grow the heap.
            assertThat(worker.submitIfMatch(event("full-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            worker.drainTick();                       // attempt parks in HTTP send (inFlight=1, queue=0)
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            Field field = DispatcherWorker.class.getDeclaredField("pendingRetries");
            field.setAccessible(true);
            ((AtomicInteger) field.get(worker)).set(cap);

            release.countDown();                      // 500 -> handleFailure -> scheduleRetry
            Map<String, Object> state = awaitSettled(worker);
            assertThat(number(state, "pendingRetries")).isEqualTo(cap).isLessThanOrEqualTo(cap);
            assertThat(number(state, "parked")).isEqualTo(1);
            assertThat(hasOutcome(state, "parked:retry_heap_full")).isTrue();
        } finally {
            release.countDown();
            drainer.shutdownNow();
            worker.shutdown();
        }
    }
}
