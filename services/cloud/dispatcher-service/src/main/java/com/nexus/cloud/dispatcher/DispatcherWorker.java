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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
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
    private final AtomicInteger inFlight = new AtomicInteger(0);
    private final AtomicLong dispatched = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong parked = new AtomicLong();
    private final ConcurrentHashMap<String, ConcurrentLinkedDeque<RecentDelivery>> recent = new ConcurrentHashMap<>();
    private final ReentrantLock drainLock = new ReentrantLock();
    private volatile boolean running = true;

    public DispatcherWorker(HookProperties props) {
        this.props = props;
        this.breaker = new CircuitBreaker();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(2_500L))
                .build();
        int workers = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2));
        ThreadFactory factory = r -> {
            Thread t = new Thread(r, "dispatcher-drainer");
            t.setDaemon(true);
            return t;
        };
        this.drainPool = Executors.newFixedThreadPool(workers, factory);
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
            if (queue.size() + inFlight.get() >= props.getMaxQueue()) {
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
        drainPool.shutdown();
        try {
            if (!drainPool.awaitTermination(5, TimeUnit.SECONDS)) drainPool.shutdownNow();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            drainPool.shutdownNow();
        }
    }

    /** Fixed-cadence drain. Each tick promotes at most 10 deliveries through the drain pool. */
    @Scheduled(fixedDelayString = "${nexus.dispatcher.drain-ms:50}",
               initialDelayString = "${nexus.dispatcher.initial-drain-ms:250}")
    public void drainTick() {
        if (!running) return;
        if (!drainLock.tryLock()) return;
        try {
            List<ScheduledDelivery> batch = new ArrayList<>();
            while (!queue.isEmpty() && batch.size() < 10) {
                ScheduledDelivery next = queue.poll();
                if (next != null) batch.add(next);
            }
            if (batch.isEmpty()) return;
            inFlight.addAndGet(batch.size());
            List<Future<?>> futures = new ArrayList<>(batch.size());
            for (ScheduledDelivery delivery : batch) {
                futures.add(drainPool.submit(() -> attempt(delivery)));
            }
            for (Future<?> future : futures) {
                try { future.get(20, TimeUnit.SECONDS); }
                catch (Exception e) { log.warn("dispatcher drain future failed: {}", e.toString()); }
            }
            inFlight.addAndGet(-batch.size());
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

    private void scheduleRetry(ScheduledDelivery delivery, long delayMs) {
        ScheduledDelivery retry = new ScheduledDelivery(delivery.event, delivery.hookId,
            delivery.attempt + 1);
        Thread t = new Thread(() -> {
            try { Thread.sleep(delayMs); } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            }
            queue.offer(retry);
        }, "dispatcher-retry-" + delivery.attempt);
        t.setDaemon(true);
        t.start();
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
