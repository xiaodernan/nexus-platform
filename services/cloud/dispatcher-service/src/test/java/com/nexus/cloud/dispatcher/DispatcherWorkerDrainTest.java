package com.nexus.cloud.dispatcher;

import com.nexus.cloud.dispatcher.DispatcherWorker.EnqueueResult;
import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.time.Duration;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.PushPromiseHandler;
import java.net.http.WebSocket;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * D975 — a slow/hung webhook must NOT starve the Redis stream consumer.
 *
 * <p>Spring Boot's default {@code @EnableScheduling} pool is a SINGLE thread, shared by
 * {@code DispatcherReader.pollOnce} (consume nexus:events + XACK) and {@code DispatcherWorker.drainTick}.
 * The pre-D975 drainTick submitted each delivery to drainPool and then called {@code future.get(20s)}
 * ON that scheduling thread — so one hung hook held the only thread for up to 10 x 20 s, the poll
 * loop stopped being scheduled, and D973's leave-unacked backpressure could never drain.
 *
 * <p>These probes are fully offline: no Redis, no network. A gate {@link HttpClient} blocks a
 * delivery on a latch (a controllable "hung hook"), a single-thread executor stands in for Spring's
 * one scheduling thread, and an injected drainPool lets us keep the two concerns separate. The
 * legacy control arm re-enacts the old submit-then-future.get shape on the SAME apparatus and proves
 * it starves — so the positive arm's survival is load-bearing, not a gate that never blocks.
 */
class DispatcherWorkerDrainTest {

    /* ------------------------------------------------------------------ fakes */

    /** A controllable HTTP client: optionally counts down {@code entered} and parks on
     *  {@code release}, letting a probe hold a delivery hostage without touching the network. */
    static final class GateHttpClient extends HttpClient {
        private final int status;
        private final CountDownLatch entered;
        private final CountDownLatch release;
        final List<HttpRequest> requests = new CopyOnWriteArrayList<>();

        private GateHttpClient(int status, CountDownLatch entered, CountDownLatch release) {
            this.status = status;
            this.entered = entered;
            this.release = release;
        }

        static GateHttpClient instant(int status) { return new GateHttpClient(status, null, null); }
        static GateHttpClient blocking(int status, CountDownLatch entered, CountDownLatch release) {
            return new GateHttpClient(status, entered, release);
        }

        @SuppressWarnings("unchecked")
        @Override
        public <T> HttpResponse<T> send(HttpRequest request, BodyHandler<T> handler)
                throws IOException, InterruptedException {
            requests.add(request);
            if (entered != null) entered.countDown();
            if (release != null) release.await();
            // attempt() uses BodyHandlers.ofString(UTF_8), so T is String here.
            return (HttpResponse<T>) new FakeResponse<>(status, "", request);
        }

        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(
                HttpRequest r, BodyHandler<T> h) { throw new UnsupportedOperationException(); }
        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(
                HttpRequest r, BodyHandler<T> h, PushPromiseHandler<T> p) {
            throw new UnsupportedOperationException();
        }
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

        FakeResponse(int status, T body, HttpRequest request) {
            this.status = status;
            this.body = body;
            this.request = request;
        }
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
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }

    private static HookProperties oneHook(String uri, int maxAttempts, int threshold) {
        HookProperties props = new HookProperties();
        props.setEnabled(true);
        HookProperties.Hook hook = new HookProperties.Hook();
        hook.setUri(uri);
        hook.setSecret("probe-secret");
        hook.setEventTypes("Order*");
        hook.setMaxAttempts(maxAttempts);
        hook.setCircuitBreakerThreshold(threshold);
        hook.setEnabled(true);
        props.setHooks(new LinkedHashMap<>(Map.of("probe", hook)));
        return props;
    }

    private static DomainEvent event(String id) {
        return DomainEvent.fromStreamBody(id, Map.of("type", "OrderCreated", "tenant_id", "t1"));
    }

    private static Map<String, Object> awaitSettled(DispatcherWorker worker, long expectedDone)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        Map<String, Object> state = worker.state();
        while (System.nanoTime() < deadline) {
            state = worker.state();
            int inFlight = ((Number) state.get("inFlight")).intValue();
            long done = ((Number) state.get("dispatched")).longValue()
                      + ((Number) state.get("parked")).longValue();
            if (inFlight == 0 && done >= expectedDone) return state;
            Thread.sleep(20L);
        }
        return state;
    }

    /* ------------------------------------------------------------------- arms */

    @Test
    void aFastHookLeavesTheSingleSchedulerThreadHealthy() throws Exception {
        // Control: with a fast hook the one scheduling thread is free for the poll loop.
        GateHttpClient http = GateHttpClient.instant(200);
        ExecutorService scheduler = Executors.newSingleThreadExecutor(named("probe-scheduler"));
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(oneHook("http://gate.test/hook", 5, 3), http, drainer);
        CountDownLatch pollRan = new CountDownLatch(1);
        try {
            assertThat(worker.submitIfMatch(event("fast-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            scheduler.submit(worker::drainTick);
            scheduler.submit(pollRan::countDown);
            assertThat(pollRan.await(3, TimeUnit.SECONDS)).isTrue();
            awaitSettled(worker, 1);
            assertThat(((Number) worker.state().get("dispatched")).longValue()).isEqualTo(1L);
        } finally {
            scheduler.shutdownNow();
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void aSynchronousDrainWouldStarveTheSingleSchedulerThread() throws Exception {
        // Legacy control: re-enact the PRE-D975 shape (submit then future.get on the scheduling
        // thread). The SAME single-thread apparatus now refuses to run the poll probe — proving the
        // gate really can starve, so the positive arm below is a meaningful distinction.
        ExecutorService scheduler = Executors.newSingleThreadExecutor(named("probe-scheduler"));
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch pollRan = new CountDownLatch(1);
        try {
            scheduler.submit(() -> {
                Future<?> f = drainer.submit(() -> {
                    entered.countDown();
                    try { release.await(); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                });
                try { f.get(20, TimeUnit.SECONDS); } catch (Exception ignored) { }
            });
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            scheduler.submit(pollRan::countDown);
            // The scheduling thread is stuck inside future.get -> the poll probe never runs.
            assertThat(pollRan.await(1, TimeUnit.SECONDS)).isFalse();
        } finally {
            release.countDown();
            scheduler.shutdownNow();
            drainer.shutdownNow();
        }
    }

    @Test
    void aHungHookDoesNotStarveThePollLoop() throws Exception {
        // THE positive arm: the new fire-and-forget drainTick must return the single scheduling
        // thread even while a delivery is hung inside HTTP send().
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch pollRan = new CountDownLatch(1);
        GateHttpClient http = GateHttpClient.blocking(200, entered, release);
        ExecutorService scheduler = Executors.newSingleThreadExecutor(named("probe-scheduler"));
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(oneHook("http://gate.test/hook", 5, 3), http, drainer);
        try {
            assertThat(worker.submitIfMatch(event("hung-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            scheduler.submit(worker::drainTick);
            // The delivery is now parked inside the blocked HTTP send.
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            // The scheduling thread must already be free: queue a poll probe behind drainTick.
            scheduler.submit(pollRan::countDown);
            assertThat(pollRan.await(3, TimeUnit.SECONDS)).isTrue();
            // And the delivery still completes correctly once the hook answers.
            release.countDown();
            Map<String, Object> state = awaitSettled(worker, 1);
            assertThat(((Number) state.get("dispatched")).longValue()).isEqualTo(1L);
            assertThat(((Number) state.get("inFlight")).intValue()).isZero();
        } finally {
            release.countDown();
            scheduler.shutdownNow();
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void inFlightReturnsToZeroForEveryCompletedDelivery() throws Exception {
        // The completion callback must decrement inFlight exactly once per delivery, or the
        // queue.size()+inFlight backpressure gauge drifts upward and jams the consumer permanently.
        GateHttpClient http = GateHttpClient.instant(200);
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(oneHook("http://gate.test/hook", 5, 3), http, drainer);
        try {
            for (int i = 0; i < 6; i++) {
                assertThat(worker.submitIfMatch(event("gauge-" + i))).isEqualTo(EnqueueResult.ENQUEUED);
            }
            worker.drainTick();
            Map<String, Object> state = awaitSettled(worker, 6);
            assertThat(((Number) state.get("inFlight")).intValue()).isZero();
            assertThat(((Number) state.get("dispatched")).longValue()).isEqualTo(6L);
            assertThat(((Number) state.get("queueDepth")).intValue()).isZero();
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void backpressureIsReleasedOnlyWhenInFlightDrains() throws Exception {
        // Invariant: once a delivery leaves the queue it is counted in inFlight, so backpressure
        // still refuses new work; when its callback runs the capacity is handed back.
        CountDownLatch release = new CountDownLatch(1);
        GateHttpClient http = GateHttpClient.blocking(200, null, release);
        HookProperties props = oneHook("http://gate.test/hook", 5, 3);
        props.setMaxQueue(1);
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(props, http, drainer);
        try {
            assertThat(worker.submitIfMatch(event("bp-1"))).isEqualTo(EnqueueResult.ENQUEUED);
            assertThat(worker.submitIfMatch(event("bp-2"))).isEqualTo(EnqueueResult.QUEUE_FULL);
            worker.drainTick(); // bp-1 leaves the queue, enters inFlight (still occupying capacity)
            assertThat(worker.submitIfMatch(event("bp-3"))).isEqualTo(EnqueueResult.QUEUE_FULL);
            release.countDown(); // callback runs -> inFlight drops to 0
            Map<String, Object> state = awaitSettled(worker, 1);
            assertThat(((Number) state.get("inFlight")).intValue()).isZero();
            assertThat(worker.submitIfMatch(event("bp-4"))).isEqualTo(EnqueueResult.ENQUEUED);
        } finally {
            release.countDown();
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void aSuccessfulDeliveryIsStillSignedAndCounted() throws Exception {
        // D973 contract: the outbound POST still carries the deterministic HMAC-SHA256 signature.
        GateHttpClient http = GateHttpClient.instant(200);
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(oneHook("http://gate.test/hook", 5, 3), http, drainer);
        try {
            worker.submitIfMatch(event("sign-1"));
            worker.drainTick();
            awaitSettled(worker, 1);
            assertThat(http.requests).hasSize(1);
            assertThat(http.requests.get(0).headers().firstValue("X-Nexus-Event-Signature"))
                    .isPresent()
                    .get()
                    .asString()
                    .startsWith("sha256=");
            assertThat(((Number) worker.state().get("dispatched")).longValue()).isEqualTo(1L);
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }

    @Test
    void anExhaustedDeliveryIsStillParkedNotSilentlyDropped() throws Exception {
        // D973 contract: a failed delivery at maxAttempts goes to the DLQ (parked), not nowhere.
        GateHttpClient http = GateHttpClient.instant(500);
        ExecutorService drainer = Executors.newSingleThreadExecutor(named("probe-drainer"));
        DispatcherWorker worker = new DispatcherWorker(oneHook("http://gate.test/hook", 1, 3), http, drainer);
        try {
            worker.submitIfMatch(event("park-1"));
            worker.drainTick();
            Map<String, Object> state = awaitSettled(worker, 1);
            assertThat(((Number) state.get("failed")).longValue()).isEqualTo(1L);
            assertThat(((Number) state.get("parked")).longValue()).isEqualTo(1L);
            assertThat(((Number) state.get("inFlight")).intValue()).isZero();
        } finally {
            drainer.shutdownNow();
            worker.shutdown();
        }
    }
}
