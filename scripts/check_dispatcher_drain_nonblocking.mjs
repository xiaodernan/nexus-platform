#!/usr/bin/env node
/**
 * NEXUS D975 — the webhook dispatcher's drain tick must never starve its own stream consumer.
 *
 * D973 shipped a bounded queue + leave-unacked backpressure on the webhook dispatcher. D975 found
 * the hole in that promise: DispatcherWorker.drainTick submitted up to 10 deliveries to drainPool
 * and then called future.get(20 SECONDS) ON the Spring @Scheduled thread. Spring Boot's default
 * scheduling pool has ONE thread, shared with DispatcherReader.pollOnce (the nexus:events consumer
 * that XACKs and replays the pending list). One slow/hung hook held that only thread for up to
 * 10 x 20 s; the poll loop was never scheduled, un-ACKed entries never drained, and the backpressure
 * signal the reader emitted had no consumer able to act on it — a positive-feedback congestion.
 *
 * THIS reader holds the structural claims an offline JUnit probe cannot autonomously persist: the
 * drain tick dispatches fire-and-forget (CompletableFuture.runAsync + whenComplete) and never calls
 * future.get on the scheduling thread; inFlight is decremented in each completion callback so the
 * queue.size()+inFlight backpressure gauge stays exact; the offline probe keeps a single-thread
 * scheduler + a gate HttpClient + a legacy synchronous control arm.
 *
 * SELF-TEST: --self-test plants corruptions in memory — restore the synchronous future.get, drop
 * the whenComplete callback, drop the inFlight decrement, remove the completion-gauge add, collapse
 * the injection seam, delete each probe arm, cut CI/ATLAS/ledger wiring — and requires EACH to
 * redden for the RIGHT reason while the real plane holds. A D954 no-op guard rejects any corruption
 * that changes no byte; a GREEN control proves a legitimate comment edit does not redden.
 *
 * WHAT THIS DOES NOT SAY: that any webhook fired, that any latency number holds, or that the stream
 * ever had traffic. The falsifier is "did the code speak the non-blocking shape it claims?"
 *
 * Usage:  node scripts/check_dispatcher_drain_nonblocking.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const WORKER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherWorker.java';
const APP = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherApplication.java';
const PROBE = 'services/cloud/dispatcher-service/src/test/java/com/nexus/cloud/dispatcher/DispatcherWorkerDrainTest.java';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_dispatcher_drain_nonblocking.mjs';
const PATHS = [WORKER, APP, PROBE, CI, ATLAS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the dispatcher-drain plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  // Each offender carries its expect tag so the self-test can assert a RIGHT reason (not just any red).
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

  /* R1 — Spring really does schedule on this class, so the single-thread fact is load-bearing. */
  has(APP, '@EnableScheduling', 'scheduling enabled on the sidecar', 'ENABLE-SCHEDULING');

  /* R2 — the drain tick dispatches fire-and-forget, never future.get on the scheduling thread. */
  has(WORKER, 'CompletableFuture.runAsync(() -> attempt(delivery), drainPool)',
      'delivery dispatched async on the drain pool', 'ASYNC-DISPATCH');
  has(WORKER, '.whenComplete((unused, error) -> {',
      'a completion callback maintains the gauge', 'WHEN-COMPLETE');
  absent(WORKER, 'future.get(', 'no synchronous future.get on the scheduling thread', 'NO-FUTURE-GET');
  absent(WORKER, 'List<Future<?>>', 'no collected future list (the pre-fix shape)', 'NO-FUTURE-LIST');
  absent(WORKER, 'inFlight.addAndGet(-batch.size())',
      'no batch-wide gauge decrement (would mis-count), use per-completion', 'NO-BATCH-DECREMENT');

  /* R3 — inFlight stays exact: armed on dispatch, released once per completion. */
  has(WORKER, 'inFlight.addAndGet(batch.size())', 'gauge armed on dispatch', 'GAUGE-ARM');
  countAtLeast(WORKER, 'inFlight.decrementAndGet()', 1,
      'gauge released in completion callback', 'GAUGE-RELEASE');
  // D978 extended the predicate with +pendingRetries (deferred retries now occupy a slot). The
  // D975 claim is that queue+inFlight are STILL in the gate and it still refuses at maxQueue;
  // assert that invariant on whatever the current predicate is, not on the old two-term literal
  // (which would make D975 red on a healthy D978 plane — a stale-citation failure, not a defect).
  has(WORKER, 'queue.size() + inFlight.get() + pendingRetries.get() >= props.getMaxQueue()',
      'backpressure predicate survives (D978 three-term)', 'BACKPRESSURE');

  /* R4 — the offline injection seam (no probe ever touches the network). */
  has(WORKER, 'DispatcherWorker(HookProperties props, HttpClient httpClient, ExecutorService drainPool)',
      'package-visible offline injection seam', 'INJECT-SEAM');

  /* R5 — D973 contracts that must NOT regress under the non-blocking rewrite. */
  has(WORKER, '@Scheduled(fixedDelayString = "${nexus.dispatcher.drain-ms:50}"',
      'fixed-cadence drain retained', 'SCHEDULE');
  has(WORKER, 'batch.size() < 10', 'bounded batch retained', 'BATCH-CAP');
  has(WORKER, 'drainLock.tryLock()', 'drain serialisation retained', 'DRAIN-LOCK');
  has(WORKER, 'scheduleRetry(delivery, delayWithJitter)', 'exponential-backoff retry retained', 'RETRY');
  has(WORKER, 'parkDelivery(delivery.event, delivery.hookId, hook, reason)',
      'DLQ park at attempt cap retained', 'DLQ');
  has(WORKER, 'breaker.registerFailure', 'circuit-breaker failure retained', 'BREAKER');

  /* R6 — the offline probe: single-thread scheduler + gate client + legacy control + 5 contracts. */
  countAtLeast(PROBE, 'Executors.newSingleThreadExecutor(named("probe-scheduler"))', 2,
      'single-thread scheduler stands in for Spring default pool', 'PROBE-SCHEDULER');
  has(PROBE, 'GateHttpClient.blocking(200, entered, release)',
      'gate HttpClient parks a hung hook on a latch', 'GATE-CLIENT');
  has(PROBE, 'void aHungHookDoesNotStarveThePollLoop()',
      'positive arm: hung hook still frees the scheduler', 'ARM-HUNG');
  has(PROBE, 'void aSynchronousDrainWouldStarveTheSingleSchedulerThread()',
      'legacy control: synchronous get really starves', 'ARM-LEGACY');
  has(PROBE, 'pollRan.await(3, TimeUnit.SECONDS)).isTrue()',
      'positive arm asserts the poll probe RAN', 'POS-ASSERT');
  has(PROBE, 'pollRan.await(1, TimeUnit.SECONDS)).isFalse()',
      'legacy control asserts the poll probe starved', 'LEGACY-ASSERT');
  has(PROBE, 'void aFastHookLeavesTheSingleSchedulerThreadHealthy()',
      'healthy control arm', 'ARM-FAST');
  has(PROBE, 'void inFlightReturnsToZeroForEveryCompletedDelivery()',
      'gauge exactness arm', 'ARM-GAUGE');
  has(PROBE, 'void backpressureIsReleasedOnlyWhenInFlightDrains()',
      'backpressure-release arm', 'ARM-BP');
  has(PROBE, 'void aSuccessfulDeliveryIsStillSignedAndCounted()',
      'signed-delivery contract arm', 'ARM-SIGN');
  has(PROBE, 'void anExhaustedDeliveryIsStillParkedNotSilentlyDropped()',
      'DLQ contract arm', 'ARM-DLQ');

  /* R7 — the CI self-test chain houses this reader so it cannot rot unchecked. */
  has(CI, 'check_dispatcher_drain_nonblocking.mjs --self-test',
      'cloud job self-test wiring', 'CI-READER');

  /* R8 — ATLAS names both the reader and the runtime probe (reverse census). */
  has(ATLAS, 'scripts/check_dispatcher_drain_nonblocking.mjs', 'ATLAS reader row', 'ATLAS-READER');
  has(ATLAS, 'DispatcherWorkerDrainTest.java', 'ATLAS probe row', 'ATLAS-PROBE');

  /* R9 — the ledger claims the unit on its own line (D959 line-anchored, own prose cannot satisfy). */
  hasHeading(STATUS, /^## 975\. D975(?=\s|$)/m, 'ledger heading for D975', 'LEDGER-HEADING');

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
  console.log('RESULT: PASS — D975 dispatcher drain non-blocking plane wired, ' + verdict.notes.length + ' holds');
  process.exit(0);
}

const live = ran;
const t = (p) => live.files.get(p) ?? '';
const cases = [
  ['synchronous future.get restored', (p) => p.set(WORKER, t(WORKER).replace(
      '// D975: submit only — never future.get on the scheduling thread.',
      '// regression: the pre-fix blocking wait is back\n'
      + '            java.util.List<java.util.concurrent.Future<?>> futures = new java.util.ArrayList<>();\n'
      + '            for (java.util.concurrent.Future<?> future : futures) { future.get(); }')), 'NO-FUTURE-GET'],
  ['future list reintroduced', (p) => p.set(WORKER, t(WORKER).replace(
      'inFlight.addAndGet(batch.size());',
      'inFlight.addAndGet(batch.size()); List<Future<?>> fs = new java.util.ArrayList<>();')), 'NO-FUTURE-LIST'],
  ['batch-wide gauge decrement restored', (p) => p.set(WORKER, t(WORKER).replace(
      'inFlight.addAndGet(batch.size());',
      'inFlight.addAndGet(batch.size()); inFlight.addAndGet(-batch.size());')), 'NO-BATCH-DECREMENT'],
  ['whenComplete callback dropped', (p) => p.set(WORKER, t(WORKER).replace(
      '.whenComplete((unused, error) -> {', '.thenApply(x -> {')), 'WHEN-COMPLETE'],
  ['async dispatch flattened', (p) => p.set(WORKER, t(WORKER).replace(
      'CompletableFuture.runAsync(() -> attempt(delivery), drainPool)',
      'CompletableFuture.completedFuture(attempt(delivery))')), 'ASYNC-DISPATCH'],
  ['gauge arm removed', (p) => p.set(WORKER, t(WORKER).replace(
      'inFlight.addAndGet(batch.size());', '/* gauge arm removed */')), 'GAUGE-ARM'],
  ['gauge release removed', (p) => p.set(WORKER, t(WORKER).replaceAll(
      'inFlight.decrementAndGet();', '/* gauge release removed */')), 'GAUGE-RELEASE'],
  ['backpressure predicate removed', (p) => p.set(WORKER, t(WORKER).replace(
      'queue.size() + inFlight.get() + pendingRetries.get() >= props.getMaxQueue()', 'false')), 'BACKPRESSURE'],
  ['injection seam collapsed', (p) => p.set(WORKER, t(WORKER).replace(
      'DispatcherWorker(HookProperties props, HttpClient httpClient, ExecutorService drainPool)',
      'DispatcherWorker(HookProperties props, HttpClient httpClient)')), 'INJECT-SEAM'],
  ['scheduling disabled', (p) => p.set(APP, t(APP).replace(
      '@EnableScheduling', '/* no scheduling */')), 'ENABLE-SCHEDULING'],
  ['batch cap removed', (p) => p.set(WORKER, t(WORKER).replace(
      'batch.size() < 10', 'batch.size() < Integer.MAX_VALUE - 1')), 'BATCH-CAP'],
  ['drain lock removed', (p) => p.set(WORKER, t(WORKER).replace(
      'if (!drainLock.tryLock()) return;', '/* no lock */')), 'DRAIN-LOCK'],
  ['retry dropped', (p) => p.set(WORKER, t(WORKER).replace(
      'scheduleRetry(delivery, delayWithJitter);', '/* retry dropped */')), 'RETRY'],
  ['DLQ park dropped', (p) => p.set(WORKER, t(WORKER).replace(
      'parkDelivery(delivery.event, delivery.hookId, hook, reason);', '/* park dropped */')), 'DLQ'],
  ['positive arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aHungHookDoesNotStarveThePollLoop()', 'void disabledPositiveArm()')), 'ARM-HUNG'],
  ['legacy control removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aSynchronousDrainWouldStarveTheSingleSchedulerThread()', 'void disabledLegacyArm()')), 'ARM-LEGACY'],
  ['positive assertion weakened', (p) => p.set(PROBE, t(PROBE).replaceAll(
      'pollRan.await(3, TimeUnit.SECONDS)).isTrue()', 'pollRan.await(30, TimeUnit.SECONDS)).isTrue()')), 'POS-ASSERT'],
  ['legacy assertion weakened', (p) => p.set(PROBE, t(PROBE).replace(
      'pollRan.await(1, TimeUnit.SECONDS)).isFalse()', 'pollRan.await(30, TimeUnit.SECONDS)).isFalse()')), 'LEGACY-ASSERT'],
  ['gate client removed', (p) => p.set(PROBE, t(PROBE).replace(
      'GateHttpClient.blocking(200, entered, release)', 'GateHttpClient.instant(200)')), 'GATE-CLIENT'],
  ['single-thread scheduler removed', (p) => p.set(PROBE, t(PROBE).replaceAll(
      'Executors.newSingleThreadExecutor(named("probe-scheduler"))',
      'Executors.newCachedThreadPool(named("probe-scheduler"))')), 'PROBE-SCHEDULER'],
  ['healthy control arm removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aFastHookLeavesTheSingleSchedulerThreadHealthy()', 'void disabledFastArm()')), 'ARM-FAST'],
  ['gauge arm probe removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void inFlightReturnsToZeroForEveryCompletedDelivery()', 'void disabledGaugeArm()')), 'ARM-GAUGE'],
  ['backpressure probe removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void backpressureIsReleasedOnlyWhenInFlightDrains()', 'void disabledBpArm()')), 'ARM-BP'],
  ['signature probe removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void aSuccessfulDeliveryIsStillSignedAndCounted()', 'void disabledSignArm()')), 'ARM-SIGN'],
  ['DLQ probe removed', (p) => p.set(PROBE, t(PROBE).replace(
      'void anExhaustedDeliveryIsStillParkedNotSilentlyDropped()', 'void disabledDlqArm()')), 'ARM-DLQ'],
  ['CI self-test wiring cut', (p) => p.set(CI, t(CI).replace(
      'check_dispatcher_drain_nonblocking.mjs --self-test', '')), 'CI-READER'],
  ['ATLAS reader row erased', (p) => p.set(ATLAS, t(ATLAS).replaceAll(
      'scripts/check_dispatcher_drain_nonblocking.mjs', '')), 'ATLAS-READER'],
  ['ATLAS probe row erased', (p) => p.set(ATLAS, t(ATLAS).replaceAll(
      'DispatcherWorkerDrainTest.java', '')), 'ATLAS-PROBE'],
  ['the ledger claim removed', (p) => p.set(STATUS, t(STATUS).replace(
      /^## 975\. D975.*$/m, '## 975. D975-superseded')), 'LEDGER-HEADING'],
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
  console.log(`  self-test  ${label.padEnd(46)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expectNeedle}"${changed ? '' : ' NO-OP'}`);
  if (!pass) allReddened = false;
  if (redOk && !rightReason) for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o);
}
// GREEN control: a legitimate comment edit must NOT redden (guards against a vacuous, overfit judge).
{
  const p = new Map(live.files);
  const realComment = '// D975: submit only — never future.get on the scheduling thread.';
  const p0 = t(WORKER);
  if (!p0.includes(realComment)) {
    console.log('  self-test  GREEN control source comment missing           DEFECT');
    allReddened = false;
  } else {
    p.set(WORKER, p0.replace(realComment,
        '// D975: dispatch is non-blocking on the scheduling thread.'));
    const out = judgeLocal(p, live.present);
    const greenOk = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN             ${greenOk ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
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
