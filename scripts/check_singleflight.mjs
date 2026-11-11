#!/usr/bin/env node
/**
 * NEXUS D944 — singleflight request coalescing, and stays WIRED.
 *
 * A bounded cache (D933's ApiKeyService verify LRU) remembers a FINISHED answer but does nothing about N
 * concurrent MISSES for the same cold key: the map lock guards the lookup and is released BEFORE the DB query,
 * so N callers each run the SELECT — a cache-penetration / thundering-herd stampede. D944 adds a pure,
 * reusable in-process `Singleflight<K,V>` primitive that collapses N concurrent loads for one key into ONE,
 * and wires it (opt-in, default OFF) into ApiKeyService.verify()'s miss path.
 *
 * THIS reader holds the structural claims a thread smoke cannot: the atomic PUT-IF-ABSENT merge is really the
 * in-flight election (a get-then-put would be a TOCTOU double load), the loader runs OUTSIDE any map lock, the
 * future is completed AND completed-exceptionally so every joiner shares the result or the failure, the finally
 * uses the conditional remove(key, future) so a slow owner cannot erase a newer in-flight entry, and the
 * opt-in flag is DEFAULT FALSE with the D933 7-arg constructor preserved. The positive property (LOADS=1 for
 * N misses, failure reaches all, cleanup lets the next call reload) and the FALSIFIER (delete the merge ->
 * LOADS=N) live in the two thread smokes and the two JUnit suites; this reader starts no JVM thread and claims
 * no test ran today.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory — the merge
 * swapped for get-then-put, exception completion dropped, conditional remove swapped for a plain remove,
 * default flipped TRUE, the ApiKeyService branch removed, a golden assertion weakened, CI/census bindings cut
 * — and requires EACH to redden while the real plane holds. A seam whose proof can vanish unnoticed is not a
 * seam.
 *
 * WHAT THIS DOES NOT SAY: that any smoke ran today, that a JVM thread was scheduled, that a real Postgres
 * stampede was measured, any latency/throughput number, or cross-process/cross-node coalescing (the table is
 * per-JVM). This is not a cache — it stores no value after the call returns.
 *
 * Usage:  node scripts/check_singleflight.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const PRIM = 'services/platform/src/main/java/com/nexus/platform/Singleflight.java';
const SVC = 'services/platform/src/main/java/com/nexus/merchant/ApiKeyService.java';
const YAML = 'services/platform/src/main/resources/application.yml';
const PRIM_TEST = 'services/platform/src/test/java/com/nexus/platform/SingleflightTest.java';
const WIRE_TEST = 'services/platform/src/test/java/com/nexus/merchant/ApiKeyServiceSingleflightTest.java';
const SMOKE = 'scripts/singleflight_smoke.sh';
const FALSIFIER = 'scripts/falsify_singleflight_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD = 'docs/CLOUD.md';
const CENSUS = 'docs/cloud_claims.yaml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_singleflight.mjs';
const PATHS = [PRIM, SVC, YAML, PRIM_TEST, WIRE_TEST, SMOKE, FALSIFIER, CI, ATLAS, CLOUD, CENSUS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the singleflight plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the ATOMIC in-flight merge is really putIfAbsent (a get-then-put would be a TOCTOU double load). */
  const run = /public V run\(K key, Supplier<\? extends V> loader\) \{([\s\S]*?)\n    \}/.exec(t(PRIM));
  if (!run) offenders.push('MISSING — the Singleflight.run(K,Supplier) body could not be isolated');
  else {
    if (!run[1].includes('inflight.putIfAbsent(key, fresh)')) {
      offenders.push('MISSING — run() does not elect ONE owner via the atomic putIfAbsent merge');
    } else notes.push('held run() elects one owner via atomic putIfAbsent');
    if (/inflight\.get\(key\)/.test(run[1]) && /inflight\.put\(key/.test(run[1])) {
      offenders.push('STALE — run() reverted to a get-then-put check-then-act (TOCTOU double-load window)');
    } else notes.push('held run() has no get-then-put TOCTOU window');
    if (!run[1].includes('mine = fresh')) offenders.push('MISSING — the winning owner adopts the fresh future');
    else notes.push('held the owner adopts its fresh future');
    if (!run[1].includes('mine.complete(loader.get())')) offenders.push('MISSING — the owner completes the future with the loader value');
    else notes.push('held the owner completes the shared future');
    if (!run[1].includes('mine.completeExceptionally(t)')) offenders.push('MISSING — a loader failure is completed exceptionally for ALL joiners');
    else notes.push('held loader failure propagates via completeExceptionally');
    if (!run[1].includes('inflight.remove(key, mine)')) {
      offenders.push('MISSING — the finally does not conditionally remove the in-flight entry (dead-future lockout)');
    } else notes.push('held the conditional remove(key, future) clears in-flight on success AND failure');
    if (!run[1].includes('return mine.join()')) offenders.push('MISSING — every caller joins the ONE shared future');
    else notes.push('held owner and followers return the same join()ed future');
    // The loader must run on the caller's thread OUTSIDE a CHM bin / global lock — that is the whole point vs computeIfAbsent.
    if (!run[1].includes('loader.get()')) offenders.push('MISSING — the loader is actually invoked');
    else notes.push('held the loader runs on the owning caller, not inside a map mapping-function lock');
  }
  has(PRIM, 'new ConcurrentHashMap<>()', 'the in-flight table is a ConcurrentHashMap');
  has(PRIM, 'import java.util.concurrent.CompletableFuture', 'the primitive uses CompletableFuture');
  has(PRIM, 'int inFlightCount()', 'the primitive exposes in-flight count for observability/tests');
  has(PRIM, 'key == null', 'null keys are rejected (CHM cannot hold them)');

  /* 2 — opt-in wiring into ApiKeyService.verify()'s miss path, DEFAULT FALSE, D933 path preserved. */
  has(SVC, 'import com.nexus.platform.Singleflight', 'ApiKeyService imports the primitive');
  has(SVC, '@Autowired\n    public ApiKeyService(', 'the 8-arg Spring primary constructor is explicit (D931 lesson)');
  has(SVC, '@Value("${nexus.api_key.verify-singleflight-enabled:false}") boolean verifySingleflightEnabled',
      'the singleflight flag defaults to OFF');
  has(SVC, 'private final Singleflight<String, Optional<Principal>> verifySingleflight',
      'ApiKeyService owns a typed singleflight table');
  has(SVC, 'this(jdbc, permissions, audit, verifyCacheTtlMs, verifyCacheMax, touchThrottleMs, touchThrottleMax, false);',
      'the 7-arg D933 compatibility constructor delegates with singleflight OFF');
  has(SVC, 'verifySingleflight.run(cacheKey, () -> loadForTenant(tenant, hash))',
      'the verify() MISS path coalesces the DB load by cache key');
  has(SVC, ': loadForTenant(tenant, hash);', 'the OFF branch keeps the direct D933 load');
  absent(SVC, 'computeIfAbsent', 'no CHM computeIfAbsent mapping-function lock was introduced');
  has(YAML, 'verify-singleflight-enabled: ${NEXUS_API_KEY_SINGLEFLIGHT_ENABLED:false}',
      'application config defaults singleflight OFF');

  /* 3 — the JUnit arms (primitive + wiring) exist. */
  for (const arm of ['coalescesConcurrentMissesIntoOneLoad', 'withoutCoalescingTheLoaderRunsNTimes',
                     'failurePropagatesToAllAndClearsInFlight', 'differentKeysRunInParallel',
                     'nullValueAndKeyAndHygiene']) {
    has(PRIM_TEST, `void ${arm}()`, `the primitive ${arm} arm exists`);
  }
  for (const arm of ['onCoalescesTheColdKeyMiss', 'offReproducesTheNPenetration']) {
    has(WIRE_TEST, `void ${arm}()`, `the wiring ${arm} arm exists`);
  }

  /* 4 — the TWO thread-level smokes: load-bearing assertions + source compilation. */
  has(SMOKE, 'javac -d "$BUILD/classes"', 'the positive smoke COMPILES the actual source with javac');
  has(SMOKE, 'com/nexus/platform/Singleflight.java', 'the positive smoke uses the real Singleflight.java, not a copy');
  has(SMOKE, 'CountDownLatch', 'the positive smoke pins the miss window with real thread latches');
  has(SMOKE, 'LOADS=1', 'the positive smoke emits the loader count');
  has(SMOKE, '[ "$LOADS" -eq 1 ]', 'the positive smoke asserts N misses collapse to ONE load');
  has(SMOKE, '[ "$WAITERS" -eq "$N" ]', 'the positive smoke asserts every caller got the shared value');
  has(SMOKE, '[ "$SAW_FAILURE" -eq "$N" ]', 'the positive smoke asserts failure reached all joiners');
  has(SMOKE, '[ "$RECOVERY" = "recovered" ]', 'the positive smoke asserts the failed future was cleared (next call reloads)');
  has(FALSIFIER, 'putIfAbsent', 'the falsifier requires the atomic merge line to exist before corrupting it');
  has(FALSIFIER, 'inflight.put(key, fresh)', 'the falsifier plants the no-merge (everyone-loads) corruption');
  has(FALSIFIER, '[ "$broken_loads" -eq "$N" ]', 'the falsifier asserts the merge-less source restores the N-fold stampede');
  has(FALSIFIER, '[ "$intact_loads" -eq 1 ]', 'the falsifier control: the intact source still collapses to 1');

  /* 5 — wiring into CI, docs, machine census and the ledger (four corners + this ledger). */
  has(CI, 'scripts/singleflight_smoke.sh', 'CI runs the positive thread smoke');
  has(CI, 'scripts/falsify_singleflight_smoke.sh', 'CI runs the thread falsifier');
  has(CI, 'node scripts/check_singleflight.mjs --self-test', 'CI runs this reader (reachability)');
  has(ATLAS, 'scripts/check_singleflight.mjs', 'ATLAS lists this reader');
  has(ATLAS, 'scripts/singleflight_smoke.sh', 'ATLAS lists the positive thread smoke');
  has(ATLAS, 'scripts/falsify_singleflight_smoke.sh', 'ATLAS lists the thread falsifier');
  has(CLOUD, 'check_singleflight.mjs', 'CLOUD.md lists this reader');
  has(CLOUD, 'singleflight_smoke.sh', 'CLOUD.md lists the positive thread smoke');
  has(CLOUD, 'falsify_singleflight_smoke.sh', 'CLOUD.md lists the thread falsifier');
  has(CLOUD, 'D944', 'CLOUD.md records the D944 seam');
  has(CENSUS, '- id: D944', 'the machine census indexes D944');
  has(CENSUS, 'smoke: singleflight_smoke.sh', 'the census binds the positive thread smoke');
  has(CENSUS, 'falsifier: falsify_singleflight_smoke.sh', 'the census binds the thread falsifier');
  has(CENSUS, 'gate: check_singleflight.mjs', 'the census binds this reader as the gate');
  has(CENSUS, 'honesty_anchor: D944', 'D944 binds an exact honesty anchor');
  has(STATUS, '## 944. D944', 'the ledger holds §944');

  return { offenders, notes, unchecked: null, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const mutate = (path, from, to) => {
    const f = new Map(real);
    const text = f.get(path);
    if (!text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${path}` };
    f.set(path, text.replace(from, to));
    return { files: f };
  };
  const arms = [
    ['atomic merge -> get-then-put', mutate(PRIM, 'inflight.putIfAbsent(key, fresh)',
      'inflight.get(key); inflight.put(key, fresh)')],
    ['exception completion dropped', mutate(PRIM, 'mine.completeExceptionally(t);', '/* swallowed */')],
    ['conditional remove lost', mutate(PRIM, 'inflight.remove(key, mine);', '/* no cleanup */')],
    ['opt-in default flipped TRUE', mutate(SVC,
      '@Value("${nexus.api_key.verify-singleflight-enabled:false}") boolean verifySingleflightEnabled',
      '@Value("${nexus.api_key.verify-singleflight-enabled:true}") boolean verifySingleflightEnabled')],
    ['verify miss branch removed', mutate(SVC,
      'verifySingleflight.run(cacheKey, () -> loadForTenant(tenant, hash))',
      'loadForTenant(tenant, hash)')],
    ['golden coalescing assertion weakened', mutate(SMOKE, '[ "$LOADS" -eq 1 ]', '[ "$LOADS" -eq 2 ]')],
    ['wire smoke dropped from CI', mutate(CI, ' && bash scripts/singleflight_smoke.sh', '')],
    ['census wire-falsifier unbound', mutate(CENSUS, 'falsifier: falsify_singleflight_smoke.sh', 'falsifier: none')],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(38)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(38)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught}`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`FALSE SINGLEFLIGHT WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D944 singleflight wired, ${result.notes.length} holds`);
process.exit(0);
