package com.nexus.cloud.dispatcher;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.DelayQueue;
import java.util.concurrent.Delayed;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * One bounded queue, a small worker pool, per-hook circuit breaker, deterministic-jitter retry.
 * 2xx — success (the circuit breaker closes on first success); anything else / exception -> retry with
 * cap on attempts, exp backoff; max attempts reached -> park in the DLQ.
 *
 * <p>Backpressure: a full queue refuses the enqueue. The reader leaves the entry un-ACKed; it
 * drains on the next poll when capacity frees. The only alternative shapes are silent loss or
 * unbounded memory; both are unacceptable.
 *
 * <p>Deterministic jitter: {@code fnv1a64(hookId + ":" + eventId + ":" + attempt) % (jitterMs+1)} —
 * identical inputs always receive identical jitter, so a replayed event gets the same retry schedule
 * and we can assert it in tests.
 *
 * <p>D978: deferred retries no longer spawn one naked daemon thread per failed attempt. They live
 * on {@link #retryHeap}, a bounded monotonic min-heap ({@link DelayQueue}); {@link #drainTick}
 * promotes a due retry into the ready queue ONLY while the {@code maxQueue - queue.size() - inFlight}
 * backpressure headroom exists, so a retry can no longer offer straight back onto the queue and
 * bypass the D973 bound. A full heap parks to the DLQ (no silent loss), and {@link #shutdown} drains
 * the whole heap to the DLQ (no interrupt-dropped message). Deadlines use {@code System.nanoTime()}
 * so an NTP clock step can neither fire a retry early nor postpone it indefinitely.
 */
@Component
public class DispatcherWorker {

    private static final Logger log = LoggerFactory.getLogger(DispatcherWorker.class);

    public enum EnqueueResult { ENQUEUED, NO_HOOK_MATCHED, QUEUE_FULL }

    private final HookProperties props;
    private final CircuitBreaker breaker;
    private final HttpClient httpClient;
    private final ConcurrentLinkedDeque<ScheduledDelivery> queue = new ConcurrentLinkedDeque<>();
    private final ExecutorService drainPool;
    /** D978: bounded deferred-retry min-heap; one entry per waiting attempt, deadline in nanoTime. */
    private final DelayQueue<DelayedRetry> retryHeap = new DelayQueue<>();
    /** D978: heap occupancy, exact under the drainLock; asserted by the backpressure gate + probe. */
    private final AtomicInteger pendingRetries = new AtomicInteger(0);
    private final AtomicInteger inFlight = new AtomicInteger(0);
    private final AtomicLong dispatched = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong parked = new AtomicLong();
    private final ConcurrentHashMap<String, ConcurrentLinkedDeque<RecentDelivery>> recent = new ConcurrentHashMap<>();
    private final ReentrantLock drainLock = new ReentrantLock();
    private volatile boolean running = true;

    public DispatcherWorker(HookProperties props) {
        this(props, HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(2_500L))
                .build(), null);
    }

    /**
     * D975: offline-probe seam. {@code drainPool == null} keeps the production fixed pool; a probe
     * passes its own (typically single-threaded) pool so it can occupy the scheduler thread and
     * prove whether a slow delivery starves the poll loop. {@code httpClient} is injectable so no
     * probe ever touches the network.
     */
    DispatcherWorker(HookProperties props, HttpClient httpClient, ExecutorService drainPool) {
        this.props = props;
        this.breaker = new CircuitBreaker();
        this.httpClient = httpClient;
        if (drainPool != null) {
            this.drainPool = drainPool;
        } else {
            int workers = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2));
            ThreadFactory factory = r -> {
                Thread t = new Thread(r, "dispatcher-drainer");
                t.setDaemon(true);
                return t;
            };
            this.drainPool = Executors.newFixedThreadPool(workers, factory);
        }
    }

    /** Hand an event to the dispatcher; returns how many hooks it was enqueued for. */
    public EnqueueResult submitIfMatch(DomainEvent event) {
        if (!props.isEnabled()) return EnqueueResult.NO_HOOK_MATCHED;
        boolean any = false;
        for (Map.Entry<String, HookProperties.Hook> entry : props.getHooks().entrySet()) {
            HookProperties.Hook hook = entry.getValue();
            String hookId = entry.getKey();
            if (hook == null || !hook.isOn()) continue;
            if (!hook.matches(event.type())) continue;
            CircuitBreaker.Verdict verdict = breaker.allow(hookId);
            if (verdict == CircuitBreaker.Verdict.OPEN) {
                parkDelivery(event, hookId, hook, "circuit_open");
                parked.incrementAndGet();
                any = true;
                continue;
            }
            if (queue.size() + inFlight.get() + pendingRetries.get() >= props.getMaxQueue()) {
                return EnqueueResult.QUEUE_FULL;
            }
            queue.offer(new ScheduledDelivery(event, hookId, 1));
            any = true;
        }
        return any ? EnqueueResult.ENQUEUED : EnqueueResult.NO_HOOK_MATCHED;
    }

    /** NO-op kept for symmetry — bounded for calls from the reader/DLQ layer. */
    public int depthOf(String hookId) {
        return 0;
    }

    public Map<String, Object> state() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("queueDepth", queue.size());
        out.put("inFlight", inFlight.get());
        out.put("pendingRetries", pendingRetries.get());
        out.put("dispatched", dispatched.get());
        out.put("failed", failed.get());
        out.put("parked", parked.get());
        out.put("circuitBreakers", breaker.snapshot());
        out.put("recent", recentDeliveries());
        out.put("enabled", props.isEnabled());
        out.put("hooks", props.publicHooks());
        return out;
    }

    private Map<String, List<Map<String, Object>>> recentDeliveries() {
        Map<String, List<Map<String, Object>>> out = new LinkedHashMap<>();
        for (Map.Entry<String, ConcurrentLinkedDeque<RecentDelivery>> entry : recent.entrySet()) {
            List<Map<String, Object>> list = new ArrayList<>();
            for (RecentDelivery r : entry.getValue()) list.add(r.toMap());
            out.put(entry.getKey(), list);
        }
        return out;
    }

    public CircuitBreaker circuitBreakers() { return breaker; }

    public void shutdown() {
        running = false;
        // Stop the pool FIRST so no in-flight attempt can offer a fresh retry while we drain.
        drainPool.shutdown();
        try {
            if (!drainPool.awaitTermination(5, TimeUnit.SECONDS)) {
                drainPool.shutdownNow();
                try { drainPool.awaitTermination(1, TimeUnit.SECONDS); }
                catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            drainPool.shutdownNow();
        }
        // D978: a bare Thread.sleep retry died on an interrupt at shutdown and silently lost the
        // delivery. DelayQueue.drainTo()/poll() only yield EXPIRED entries, so a retry still inside
        // a long backoff would survive drainTo and be lost in a NEW shape. Snapshot ALL entries
        // (expired or not) with toArray() + clear() and park each to the DLQ — no silent loss.
        Object[] deferred = retryHeap.toArray();
        retryHeap.clear();
        for (Object o : deferred) {
            DelayedRetry abandonedRetry = (DelayedRetry) o;
            pendingRetries.decrementAndGet();
            parkDelivery(abandonedRetry.delivery.event, abandonedRetry.delivery.hookId,
                props.getHooks().get(abandonedRetry.delivery.hookId), "shutdown_deferred");
            parked.incrementAndGet();
        }
    }

    /** Fixed-cadence drain. Each tick promotes due retries into spare capacity, then submits at
     *  most 10 deliveries through the drain pool.
     *  D975: dispatch is fire-and-forget ON THE SCHEDULER THREAD. Spring's default scheduling pool
     *  has one thread, shared with {@code DispatcherReader.pollOnce}; a synchronous future.get here
     *  used to hold that thread hostage for the whole batch (up to 10 x 20 s on a hung hook), so the
     *  stream consumer stopped being polled and D973's leave-unacked backpressure could never drain.
     *  The scheduler now only SUBMITS; each completion callback (success or failure) decrements
     *  inFlight, keeping the queue.size()+inFlight backpressure gauge exact.
     *  D978: before pulling the new batch, due entries leave the deferred heap ONLY into the free
     *  room of {@code maxQueue - queue.size() - inFlight - pendingRetries}; a full ready side leaves
     *  them deferred, so retries now respect the same bound fresh events do. */
    @Scheduled(fixedDelayString = "${nexus.dispatcher.drain-ms:50}",
               initialDelayString = "${nexus.dispatcher.initial-drain-ms:250}")
    public void drainTick() {
        if (!running) return;
        if (!drainLock.tryLock()) return;
        try {
            // D978: promote due retries into spare backpressure capacity. A bare queue.offer here
            // would reintroduce the pre-fix bypass that let retries overfill the bounded queue.
            // Moving one entry decrements pendingRetries and (below) its queue.offer raises
            // queue.size() by one — the three-term gauge stays conserved across the transfer.
            int room = props.getMaxQueue() - queue.size() - inFlight.get() - pendingRetries.get();
            DelayedRetry due;
            while (room > 0 && (due = retryHeap.poll()) != null) {
                queue.offer(due.delivery);
                pendingRetries.decrementAndGet();
                room--;
            }
            List<ScheduledDelivery> batch = new ArrayList<>();
            while (!queue.isEmpty() && batch.size() < 10) {
                ScheduledDelivery next = queue.poll();
                if (next != null) batch.add(next);
            }
            if (batch.isEmpty()) return;
            inFlight.addAndGet(batch.size());
            // D975: submit only — never future.get on the scheduling thread.
            for (ScheduledDelivery delivery : batch) {
                CompletableFuture.runAsync(() -> attempt(delivery), drainPool)
                        .whenComplete((unused, error) -> {
                            if (error != null) {
                                log.warn("dispatcher drain future failed: {}", error.toString());
                            }
                            inFlight.decrementAndGet();
                        });
            }
        } finally {
            drainLock.unlock();
        }
    }

    private void attempt(ScheduledDelivery delivery) {
        HookProperties.Hook hook = props.getHooks().get(delivery.hookId);
        if (hook == null || !hook.isOn()) {
            parkDelivery(delivery.event, delivery.hookId, hook, "hook_disabled");
            return;
        }
        if (breaker.allow(delivery.hookId) == CircuitBreaker.Verdict.OPEN) {
            parkDelivery(delivery.event, delivery.hookId, hook, "circuit_open");
            return;
        }
        long start = System.currentTimeMillis();
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(new URI(hook.getUri()))
                .timeout(Duration.ofMillis(hook.getTimeoutMs()))
                .header("Content-Type", "application/json; charset=utf-8")
                .header("X-Nexus-Event-Id", delivery.event.id())
                .header("X-Nexus-Event-Type", delivery.event.type())
                .header("X-Nexus-Event-Tenant",
                    delivery.event.tenantId() == null ? "" : delivery.event.tenantId())
                .header("X-Nexus-Event-Signature",
                    "sha256=" + Signature.sha256Hex(hook.getSecret(), delivery.event.body()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(delivery.event.body()))
                .build();
            HttpResponse<String> response = httpClient.send(request, BodyHandlers.ofString(StandardCharsets.UTF_8));
            int status = response.statusCode();
            int bodyBytes = response.body() == null ? 0 : response.body().getBytes(StandardCharsets.UTF_8).length;
            if (status >= 200 && status < 300) {
                breaker.registerSuccess(delivery.hookId);
                dispatched.incrementAndGet();
                record(delivery.hookId, new RecentDelivery(delivery.event.id(), delivery.event.type(),
                    delivery.attempt, status, "ok", msSince(start), Map.of("status", status, "bodyBytes", bodyBytes)));
                return;
            }
            handleFailure(delivery, hook, "http_" + status, status);
        } catch (IOException | URISyntaxException | InterruptedException e) {
            handleFailure(delivery, hook, "exception:" + e.getClass().getSimpleName(), 0);
        }
    }

    private void handleFailure(ScheduledDelivery delivery, HookProperties.Hook hook,
                               String reason, int httpStatus) {
        int threshold = Math.max(1, hook.getCircuitBreakerThreshold());
        breaker.registerFailure(delivery.hookId, threshold);
        failed.incrementAndGet();
        int nextAttempt = delivery.attempt + 1;
        if (nextAttempt > hook.getMaxAttempts()) {
            parkDelivery(delivery.event, delivery.hookId, hook, reason);
            record(delivery.hookId, new RecentDelivery(delivery.event.id(), delivery.event.type(),
                delivery.attempt, httpStatus, "parked:" + reason, 0L, Map.of("attempt", delivery.attempt)));
            parked.incrementAndGet();
            return;
        }
        long delay = tryShift(hook.getBaseDelayMs(), delivery.attempt);
        long jitter = deterministicJitter(delivery.hookId + ":" + delivery.event.id() + ":" + delivery.attempt,
            hook.getJitterMs());
        long delayWithJitter = Math.max(50L, delay + jitter);
        scheduleRetry(delivery, delayWithJitter);
        record(delivery.hookId, new RecentDelivery(delivery.event.id(), delivery.event.type(),
            delivery.attempt, httpStatus, "retry:" + reason, delayWithJitter, Map.of("nextDelayMs", delayWithJitter)));
    }

    private long tryShift(long base, int attempt) {
        long delay = base;
        for (int i = 1; i < attempt; i++) {
            delay = delay << 1;
            if (delay > 60_000L) return 60_000L;
        }
        return delay;
    }

    /** Deterministic hash → unsigned long → modulo jitter+1. Same key, same jitter — every call. */
    private static long deterministicJitter(String key, long jitterMs) {
        if (jitterMs <= 0) return 0L;
        long h = fnv1a64(key.getBytes(StandardCharsets.UTF_8));
        return Long.remainderUnsigned(h, jitterMs + 1);
    }

    private static long fnv1a64(byte[] bytes) {
        long hash = 0xcbf29ce484222325L;
        for (byte b : bytes) {
            hash ^= (b & 0xffL);
            hash *= 0x100000001b3L;
        }
        return hash;
    }

    /**
     * D978: defer the retry on a bounded monotonic min-heap instead of spawning one naked daemon
     * thread per failed attempt that slept for the backoff and then offered straight back to the
     * queue. Three faults die here: (1) one OS thread per failure (unbounded; sleep parks a kernel
     * thread),
     * (2) a direct queue.offer that ignored the backpressure bound, (3) an InterruptedException that
     * returned silently and dropped the delivery. The heap is capped at maxQueue — a full heap parks
     * to the DLQ, never grows without bound, never loses a message; drainTick promotes due entries
     * only into spare capacity.
     */
    private void scheduleRetry(ScheduledDelivery delivery, long delayMs) {
        ScheduledDelivery retry = new ScheduledDelivery(delivery.event, delivery.hookId,
            delivery.attempt + 1);
        int cap = Math.max(1, props.getMaxQueue());
        if (pendingRetries.get() >= cap) {
            // Bounded: never grow the deferred heap past maxQueue. Park to DLQ, do not lose it.
            parkDelivery(retry.event, retry.hookId, props.getHooks().get(retry.hookId), "retry_heap_full");
            parked.incrementAndGet();
            return;
        }
        if (!running) {
            // shutdown() already snapshotted+cleared the heap; accepting a late retry here would
            // strand an entry no future drainTick will ever consume. Park it instead.
            parkDelivery(retry.event, retry.hookId, props.getHooks().get(retry.hookId), "shutdown_deferred");
            parked.incrementAndGet();
            return;
        }
        pendingRetries.incrementAndGet();
        retryHeap.offer(new DelayedRetry(retry,
            System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delayMs)));
    }

    public void parkDelivery(DomainEvent event, String hookId, HookProperties.Hook hook, String reason) {
        record(hookId, new RecentDelivery(event.id(), event.type(), 0, 0, "parked:" + reason, 0L, Map.of()));
    }

    private void record(String hookId, RecentDelivery entry) {
        ConcurrentLinkedDeque<RecentDelivery> deque = recent.computeIfAbsent(hookId, k -> new ConcurrentLinkedDeque<>());
        deque.addFirst(entry);
        while (deque.size() > 64) deque.removeLast();
    }

    private long msSince(long start) { return Math.max(0L, System.currentTimeMillis() - start); }

    private record ScheduledDelivery(DomainEvent event, String hookId, int attempt) {}

    /** D978: one deferred retry on the min-heap, ordered by a monotonic nanoTime deadline. */
    private static final class DelayedRetry implements Delayed {
        private final ScheduledDelivery delivery;
        private final long readyAtNanos;

        DelayedRetry(ScheduledDelivery delivery, long readyAtNanos) {
            this.delivery = delivery;
            this.readyAtNanos = readyAtNanos;
        }

        @Override
        public long getDelay(TimeUnit unit) {
            return unit.convert(readyAtNanos - System.nanoTime(), TimeUnit.NANOSECONDS);
        }

        @Override
        public int compareTo(Delayed other) {
            return Long.compare(this.readyAtNanos, ((DelayedRetry) other).readyAtNanos);
        }
    }

    private record RecentDelivery(String eventId, String type, int attempt,
                                  int httpStatus, String outcome, long ms,
                                  Map<String, Object> meta) {
        Map<String, Object> toMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("eventId", eventId);
            out.put("type", type);
            out.put("attempt", attempt);
            out.put("status", httpStatus);
            out.put("outcome", outcome);
            out.put("ms", ms);
            out.put("meta", meta);
            return out;
        }
    }
}
