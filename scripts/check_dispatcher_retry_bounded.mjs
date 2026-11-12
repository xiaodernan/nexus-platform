#!/usr/bin/env node
/**
 * NEXUS D978 — a webhook dispatcher's deferred retry must be bounded, backpressure-visible,
 * and never silently dropped at shutdown.
 *
 * D973 shipped a bounded queue + leave-unacked backpressure. D975 made the drain tick
 * non-blocking. D978 found the remaining hole in that promise: DispatcherWorker.scheduleRetry
 * spawned `new Thread(() -> { Thread.sleep(delayMs); queue.offer(retry); })` per failed attempt.
 * Three faults: (1) one OS thread per failure — an unbounded kernel-thread-per-attempt shape under
 * a persistent 5xx storm, with sleep parking a thread that could serve real work; (2) the sleeping
 * retry was invisible to the `queue.size()+inFlight` gauge and offered straight back onto the
 * bounded queue, bypassing D973's backpressure; (3) an InterruptedException returned silently and
 * dropped the delivery, and shutdown() never touched those naked threads at all.
 *
 * THIS reader holds the structural claims an offline JUnit probe cannot autonomously persist:
 * retries defer on a bounded DelayQueue keyed by a monotonic nanoTime deadline; pendingRetries is
 * in the backpressure predicate; due entries promote ONLY into spare capacity; a full heap parks
 * to the DLQ; shutdown snapshots+clears ALL entries (DelayQueue.drainTo is expired-only — a real
 * trap the probe caught) and parks them; a!running guard strands no late retry. The probe keeps a
 * LEGACY invisible-gauge control and a LEGACY naked-thread control so its positive arms are
 * load-bearing, not detectors that can never fire.
 *
 * SELF-TEST: --self-test plants corruptions in memory — restore the naked thread/sleep, remove
 * pendingRetries from the gauge, drop the capacity-gated promote, swap monotonic nanoTime for
 * wall-clock, replace toArray()+clear() with expired-only drainTo, remove the !running guard,
 * delete the cap guard, weaken each probe arm, cut CI/ATLAS/ledger wiring — and requires EACH to
 * redden for the RIGHT reason while the real plane holds. A D954 no-op guard rejects any
 * corruption that changes no byte; a GREEN control proves a legitimate comment edit does not
 * redden.
 *
 * WHAT THIS DOES NOT SAY: that any webhook fired, that any latency number holds, or that the
 * stream ever had traffic. The falsifier is "did the code speak the bounded-retry shape it claims?"
 *
 * Usage:  node scripts/check_dispatcher_retry_bounded.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const W = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherWorker.java';
const PROBE = 'services/cloud/dispatcher-service/src/test/java/com/nexus/cloud/dispatcher/DispatcherWorkerRetryTest.java';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_dispatcher_retry_bounded.mjs';
const PATHS = [W, PROBE, CI, ATLAS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the dispatcher-retry plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };
  const countAtLeast = (p, needle, min, label, expect) => {
    const n = t(p).split(needle).length - 1;
    if (n < min) offenders.push(`MISSING — ${p}: ${label} (found ${n}, need >=${min})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const hasHeading = (p, re, label, expect) => {
    if (!re.test(t(p))) offenders.push(`MISSING — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* R1 — no naked per-attempt thread/sleep survives in the product (statement-shaped needles so a
   *  Javadoc that quotes the old shape cannot make the real plane red — a vacuity the self-test
   *  caught on the first run). */
  absent(W, 'Thread.sleep(delayMs);', 'no per-attempt Thread.sleep statement', 'NO-SLEEP');
  absent(W, '"dispatcher-retry-"', 'no naked dispatcher-retry thread name in product', 'NO-NAKED-THREAD');

  /* R2 — the deferred heap is bounded and monotonic. */
  has(W, 'new DelayQueue<>()', 'bounded deferred min-heap field', 'DELAY-HEAP');
  has(W, 'private final AtomicInteger pendingRetries', 'exact deferred occupancy gauge', 'PENDING-GAUGE');
  has(W, 'implements Delayed', 'deferred entry implements Delayed', 'DELAYED-IFACE');
  has(W, 'public long getDelay(TimeUnit unit)', 'Delayed.getDelay deadline', 'GET-DELAY');
  has(W, 'public int compareTo(Delayed other)', 'Delayed.compareTo orders by deadline', 'COMPARE-TO');
  countAtLeast(W, 'System.nanoTime()', 2, 'monotonic nanoTime deadline (offer + getDelay)', 'MONOTONIC-CLOCK');
  absent(W, 'System.currentTimeMillis() + TimeUnit.MILLISECONDS.toNanos(delayMs)',
      'no wall-clock retry deadline', 'NO-WALLCLOCK-DEADLINE');

  /* R3 — the backpressure predicate sees deferred retries (the D978 core). */
  has(W, 'queue.size() + inFlight.get() + pendingRetries.get() >= props.getMaxQueue()',
      'three-term backpressure predicate', 'BACKPRESSURE-3');
  has(W, 'int room = props.getMaxQueue() - queue.size() - inFlight.get() - pendingRetries.get()',
      'promote only into spare capacity', 'PROMOTE-ROOM');
  has(W, 'while (room > 0 && (due = retryHeap.poll()) != null)',
      'due promotion is capacity-gated', 'PROMOTE-GATED');
  has(W, 'queue.offer(due.delivery);', 'promoted retry enters the bounded queue', 'PROMOTE-QUEUE');
  has(W, 'pendingRetries.decrementAndGet();', 'gauge released on promotion', 'GAUGE-DECREMENT');

  /* R4 — bounded heap cap parks overflow; shutdown strands nothing. */
  has(W, 'if (pendingRetries.get() >= cap)', 'heap cap guard', 'HEAP-CAP');
  has(W, '"retry_heap_full"', 'overflow parks to DLQ with reason', 'OVERFLOW-PARK');
  has(W, 'pendingRetries.incrementAndGet();', 'gauge armed on defer', 'GAUGE-INCREMENT');
  has(W, 'retryHeap.toArray()', 'shutdown snapshots ALL deferred entries', 'SHUTDOWN-SNAPSHOT');
  has(W, 'retryHeap.clear()', 'shutdown clears the heap (not expired-only)', 'SHUTDOWN-CLEAR');
  absent(W, 'retryHeap.drainTo(abandoned)',
      'shutdown does NOT rely on expired-only drainTo', 'NO-EXPIRED-ONLY-DRAIN');
  has(W, '"shutdown_deferred"', 'shutdown-park reason', 'SHUTDOWN-PARK-REASON');
  countAtLeast(W, 'if (!running)', 2, 'running guards (tick + late-retry park)', 'RUNNING-GUARD');
  has(W, 'out.put("pendingRetries", pendingRetries.get())',
      'state() exposes the deferred gauge', 'STATE-GAUGE');

  /* R5 — every D973/D975 contract that must NOT regress. */
  has(W, 'CompletableFuture.runAsync(() -> attempt(delivery), drainPool)',
      'D975 fire-and-forget dispatch retained', 'ASYNC-DISPATCH');
  has(W, '.whenComplete((unused, error) -> {', 'D975 completion callback retained', 'WHEN-COMPLETE');
  absent(W, 'future.get(', 'no synchronous future.get on the scheduling thread', 'NO-FUTURE-GET');
  has(W, 'inFlight.addAndGet(batch.size())', 'D975 gauge arm retained', 'GAUGE-ARM');
  has(W, 'inFlight.decrementAndGet();', 'D975 gauge release retained', 'GAUGE-RELEASE');
  has(W, 'batch.size() < 10', 'D973 bounded batch retained', 'BATCH-CAP');
  has(W, 'drainLock.tryLock()', 'D973 drain serialisation retained', 'DRAIN-LOCK');
  has(W, 'scheduleRetry(delivery, delayWithJitter)', 'exponential-backoff retry retained', 'RETRY-WIRED');
  has(W, 'Long.remainderUnsigned', 'D973 deterministic jitter retained', 'JITTER');
  has(W, 'parkDelivery(delivery.event, delivery.hookId, hook, reason)',
      'D973 DLQ park at attempt cap retained', 'DLQ-PARK');
  has(W, 'breaker.registerFailure', 'D973 circuit-breaker failure retained', 'BREAKER');
  has(W, '"sha256=" + Signature.sha256Hex', 'D973 HMAC-SHA256 signing retained', 'HMAC');

  /* R6 — the offline probe: 8 arms, LEGACY controls, no network/Redis/JVM container. */
  has(PROBE, 'class DispatcherWorkerRetryTest', 'offline JUnit probe class', 'PROBE-CLASS');
  has(PROBE, 'void aDeferredRetryIsVisibleToBackpressure()',
      'positive arm: deferred retry occupies a gauge slot', 'ARM-VISIBLE');
  has(PROBE, 'void aLegacyInvisibleDeferredWouldAcceptUnboundedWork()',
      'LEGACY control: invisible gauge would accept work', 'ARM-LEGACY-GAUGE');
  has(PROBE, 'void failureBurstSpawnsNoNakedThreads()',
      'bounded-thread positive arm', 'ARM-NO-THREADS');
  has(PROBE, 'void legacyNakedThreadShapeReallySpawnsAThreadPerFailure()',
      'LEGACY control: naked-thread detector is load-bearing', 'ARM-LEGACY-THREAD');
  has(PROBE, 'void shutdownParksEveryDeferredRetry()',
      'no-silent-loss positive arm', 'ARM-SHUTDOWN');
  has(PROBE, 'void aDueRetryStillReturnsAndDispatches()',
      'due-retry-survival arm', 'ARM-DUE');
  has(PROBE, 'void anExhaustedDeliveryIsStillParkedNotRetried()',
      'attempt-cap contract arm', 'ARM-EXHAUST');
  has(PROBE, 'void aFullHeapParksTheOverflowToTheDlq()',
      'bounded-heap cap-guard arm', 'ARM-CAP');
  has(PROBE, 'Thread.getAllStackTraces()', 'naked-thread detector used', 'THREAD-DETECTOR');
  has(PROBE, 'awaitWithTicks', 'fixed-cadence tick driver', 'TICK-DRIVER');

  /* R7 — the CI self-test chain houses this reader so it cannot rot unchecked. */
  has(CI, 'check_dispatcher_retry_bounded.mjs --self-test', 'cloud job self-test wiring', 'CI-READER');

  /* R8 — ATLAS names both the reader and the runtime probe (reverse census). */
  has(ATLAS, 'scripts/check_dispatcher_retry_bounded.mjs', 'ATLAS reader row', 'ATLAS-READER');
  has(ATLAS, 'DispatcherWorkerRetryTest.java', 'ATLAS probe row', 'ATLAS-PROBE');

  /* R9 — the ledger claims the unit on its own D959 line-anchored heading. */
  hasHeading(STATUS, /^## 978\. D978(?=\s|$)/m, 'ledger heading for D978', 'LEDGER-HEADING');

  return { offenders, notes };
}

function livePlane() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    if (existsSync(join(ROOT, p))) {
      files.set(p, readFileSync(join(ROOT, p), 'utf8'));
      present.add(p);
    }
  }
  return { files, present };
}

const judgeLocal = (files, present) => judge(files, present);
const ran = livePlane();
const verdict = judgeLocal(ran.files, ran.present);

if (verdict.unchecked) {
  console.log('RESULT: NOT CHECKED — ' + verdict.unchecked);
  process.exit(2);
}
if (!SELF_TEST) {
  if (verdict.offenders.length) {
    for (const off of verdict.offenders) console.log('  offender: ' + off);
    console.log('RESULT: FAIL — ' + verdict.offenders.length + ' structural offender(s)');
    process.exit(1);
  }
  console.log('RESULT: PASS — D978 dispatcher retry-bounded plane wired, ' + verdict.notes.length + ' holds');
  process.exit(0);
}

const live = ran;
const t = (p) => live.files.get(p) ?? '';
const cases = [
  ['per-attempt Thread.sleep restored', (p) => p.set(W, t(W).replace(
      'pendingRetries.incrementAndGet();\n        retryHeap.offer(new DelayedRetry(retry,',
      'Thread.sleep(delayMs);\n        queue.offer(retry);\n        pendingRetries.incrementAndGet();\n        retryHeap.offer(new DelayedRetry(retry,')), 'NO-SLEEP'],
  ['naked retry thread name restored', (p) => p.set(W, t(W).replace(
      'private final DelayQueue<DelayedRetry> retryHeap',
      'private final String naked = "dispatcher-retry-";\n    private final DelayQueue<DelayedRetry> retryHeap')), 'NO-NAKED-THREAD'],
  ['wall-clock retry deadline', (p) => p.set(W, t(W).replace(
      'System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delayMs)',
      'System.currentTimeMillis() + TimeUnit.MILLISECONDS.toNanos(delayMs)')), 'NO-WALLCLOCK-DEADLINE'],
  ['monotonic clock removed', (p) => p.set(W, t(W).replaceAll(
      'System.nanoTime()', 'System.currentTimeMillis()')), 'MONOTONIC-CLOCK'],
  ['three-term gauge flattened to two', (p) => p.set(W, t(W).replace(
      'queue.size() + inFlight.get() + pendingRetries.get() >= props.getMaxQueue()',
      'queue.size() + inFlight.get() >= props.getMaxQueue()')), 'BACKPRESSURE-3'],
  ['deferred gauge field removed', (p) => p.set(W, t(W).replace(
      'private final AtomicInteger pendingRetries', 'private final int pendingRetries_unused')), 'PENDING-GAUGE'],
  ['capacity-gated promote removed', (p) => p.set(W, t(W).replace(
      'int room = props.getMaxQueue() - queue.size() - inFlight.get() - pendingRetries.get()',
      'int room = Integer.MAX_VALUE')), 'PROMOTE-ROOM'],
  ['promote gate unconditional', (p) => p.set(W, t(W).replace(
      'while (room > 0 && (due = retryHeap.poll()) != null)',
      'while ((due = retryHeap.poll()) != null)')), 'PROMOTE-GATED'],
  ['heap cap guard removed', (p) => p.set(W, t(W).replace(
      'if (pendingRetries.get() >= cap) {', 'if (false) {')), 'HEAP-CAP'],
  ['overflow park reason removed', (p) => p.set(W, t(W).replace(
      '"retry_heap_full"', '"dropped_quietly"')), 'OVERFLOW-PARK'],
  ['shutdown snapshot weakened to expired-only drainTo', (p) => p.set(W, t(W).replace(
      'Object[] deferred = retryHeap.toArray();\n        retryHeap.clear();',
      'java.util.List<DelayedRetry> deferred = new java.util.ArrayList<>();\n        retryHeap.drainTo(deferred);')), 'SHUTDOWN-SNAPSHOT'],
  ['shutdown clear removed', (p) => p.set(W, t(W).replace(
      'retryHeap.clear();', '/* no clear — strand late entries */')), 'SHUTDOWN-CLEAR'],
  ['shutdown park reason removed', (p) => p.set(W, t(W).replaceAll(
      '"shutdown_deferred"', '"never_recorded"')), 'SHUTDOWN-PARK-REASON'],
  ['running guard removed', (p) => p.set(W, t(W).replaceAll(
      'if (!running) {', 'if (false) {')), 'RUNNING-GUARD'],
  ['state deferred gauge removed', (p) => p.set(W, t(W).replace(
      'out.put("pendingRetries", pendingRetries.get());', '')), 'STATE-GAUGE'],
  ['D975 async dispatch flattened', (p) => p.set(W, t(W).replace(
      'CompletableFuture.runAsync(() -> attempt(delivery), drainPool)',
      'CompletableFuture.completedFuture(attempt(delivery))')), 'ASYNC-DISPATCH'],
  ['Delayed interface dropped from entry', (p) => p.set(W, t(W).replace(
      'private static final class DelayedRetry implements Delayed {',
      'private static final class DelayedRetry {')), 'DELAYED-IFACE'],
  ['CI self-test wiring cut', (p) => p.set(CI, t(CI).replace(
      'check_dispatcher_retry_bounded.mjs --self-test', '')), 'CI-READER'],
  ['ATLAS reader row erased', (p) => p.set(ATLAS, t(ATLAS).replaceAll(
      'scripts/check_dispatcher_retry_bounded.mjs', '')), 'ATLAS-READER'],
  ['ATLAS probe row erased', (p) => p.set(ATLAS, t(ATLAS).replaceAll(
      'DispatcherWorkerRetryTest.java', '')), 'ATLAS-PROBE'],
  ['positive gauge-visibility arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aDeferredRetryIsVisibleToBackpressure()', 'void disabledVisibleArm()')), 'ARM-VISIBLE'],
  ['LEGACY gauge control removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aLegacyInvisibleDeferredWouldAcceptUnboundedWork()', 'void disabledLegacyGaugeArm()')), 'ARM-LEGACY-GAUGE'],
  ['bounded-thread arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void failureBurstSpawnsNoNakedThreads()', 'void disabledThreadsArm()')), 'ARM-NO-THREADS'],
  ['LEGACY thread control removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void legacyNakedThreadShapeReallySpawnsAThreadPerFailure()', 'void disabledLegacyThreadArm()')), 'ARM-LEGACY-THREAD'],
  ['shutdown arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void shutdownParksEveryDeferredRetry()', 'void disabledShutdownArm()')), 'ARM-SHUTDOWN'],
  ['due-retry arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aDueRetryStillReturnsAndDispatches()', 'void disabledDueArm()')), 'ARM-DUE'],
  ['exhaust arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void anExhaustedDeliveryIsStillParkedNotRetried()', 'void disabledExhaustArm()')), 'ARM-EXHAUST'],
  ['cap-guard arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aFullHeapParksTheOverflowToTheDlq()', 'void disabledCapArm()')), 'ARM-CAP'],
  ['thread detector removed', (p) => p.set(PROBE, t(PROBE).replace(
      'Thread.getAllStackTraces()', 'java.util.Collections.emptyMap()')), 'THREAD-DETECTOR'],
  ['tick driver removed', (p) => p.set(PROBE, t(PROBE).replaceAll(
      'awaitWithTicks', 'awaitStateOnly')), 'TICK-DRIVER'],
  ['the ledger claim removed', (p) => p.set(STATUS, t(STATUS).replace(
      /^## 978\. D978.*$/m, '## 978. D978-superseded')), 'LEDGER-HEADING'],
];

let allReddened = true;
for (const [label, plant, expectNeedle] of cases) {
  const p = new Map(live.files);
  if (typeof plant === 'function') plant(p);
  // D954 no-op guard: a corruption that changes no byte is a defect, not a pass.
  let changed = false;
  for (const [path, text] of p) if (text !== live.files.get(path)) { changed = true; break; }
  const out = judgeLocal(p, live.present);
  const joined = out.offenders.join(' | ');
  const redOk = (out.offenders.length > 0 || out.unchecked);
  const rightReason = joined.includes(expectNeedle);
  const pass = changed && redOk && rightReason;
  console.log(`  self-test  ${label.padEnd(50)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expectNeedle}"${changed ? '' : ' NO-OP'}`);
  if (!pass) allReddened = false;
  if (redOk && !rightReason) for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o);
}
// GREEN control: a legitimate comment edit must NOT redden (guards against an overfit judge).
{
  const p = new Map(live.files);
  const realComment = ' *  D978: before pulling the new batch, due entries leave the deferred heap ONLY into the free';
  const p0 = t(W);
  if (!p0.includes(realComment)) {
    console.log('  self-test  GREEN control source comment missing            DEFECT');
    allReddened = false;
  } else {
    p.set(W, p0.replace(realComment, ' *  D978: due entries leave the deferred heap only into spare capacity.'));
    const out = judgeLocal(p, live.present);
    const greenOk = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN              ${greenOk ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!greenOk) allReddened = false;
  }
}
// Guard: the real plane still holds.
{
  const out = judgeLocal(live.files, live.present);
  const realGreen = out.offenders.length === 0;
  console.log(`  self-test  legitimate plane stays GREEN                      green offenders=${out.offenders.length}`);
  if (!realGreen) allReddened = false;
}
console.log(`  self-test  all arms redden for cause + guards green: ${allReddened} (${cases.length} arms)`);
process.exit(allReddened ? 0 : 1);
