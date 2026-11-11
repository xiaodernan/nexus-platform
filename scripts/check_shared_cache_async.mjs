#!/usr/bin/env node
/**
 * NEXUS D962 — the opt-in shared tool-result cache must not block the asyncio event loop.
 *
 * THE HOLE. `tools/redis_tier.py` deliberately uses the SYNCHRONOUS redis-py client: `get()` and
 * `set()` are blocking socket I/O (socket_timeout=1.0s), wrapped in try/except so a Redis outage
 * degrades to "no shared tier". That is a sound library choice — but `Registry.dispatch` is
 * `async def` and runs on the uvicorn event loop, and D922 wired those two blocking methods in
 * BARE (no await, no offload). With `NEXUS_AI_SHARED_CACHE=redis` on (the multi-replica case the
 * tier exists for), every shared-cache hit/read froze the loop for up to a socket timeout: all
 * concurrent requests on that worker were serialised behind one Redis RTT, and the per-tool
 * `asyncio.wait_for(handler, timeout=...)` could not fire during that non-await window. The
 * existing tests only checked hit/TTL/degrade with a serial `asyncio.run`, so loop starvation was
 * invisible. This reader holds the structural half of the fix; the runnable half is the pytest
 * probe `apps/ai/tests/test_shared_cache_does_not_block_event_loop.py` (heartbeat stays alive
 * while a blocking shared read is in flight; its falsifier inlines the call and requires RED).
 *
 * THE FIX (D962). Both hot-path calls become `await asyncio.to_thread(self._shared.get/set, ...)`.
 * The sync client, its fail-fast boot `ping()`, the offline-degrade try/except, the `_MISS`/None
 * identity, the canonical key, the TTL and the default-OFF env gate are ALL unchanged, so the
 * default plane stays byte-identical. This reader asserts the offload exists at BOTH sites, that
 * no bare blocking call remains, that the sync-client contract was NOT swapped for an async
 * rewrite (that would be a different design needing a different proof), and that the runtime
 * probe + its one-flipped-variable falsifier ship and are wired.
 *
 * WHAT IT DOES NOT CLAIM. That any test ran today, that a live Redis round trip was measured,
 * any latency/throughput number, that a real FastAPI worker was scheduled, or that a premise
 * about Redis internals is true. The behavioural proof lives in the pytest probe on the CI `ai`
 * job (`uv run pytest -q`); this file only judges source text and wiring.
 *
 * SELF-TEST. `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in
 * memory: remove each offload (recreating the bare call), de-async dispatch, swap the sync client
 * for an async rewrite, delete an offline-degrade branch, drop the wait_for timeout, erase the
 * probe's positive or falsifier arm, cut the CI/ATLAS/ledger bindings, and remove the reader.
 * Every arm carries an `expect` substring the offender MUST contain (so red-for-the-wrong-reason
 * still fails), a D954 no-op snapshot guard (a corruption that changes no byte is a defect), and
 * one GREEN control (a harmless constant change must NOT redden the reader). A plain `.includes`
 * on the section number is NOT used for the ledger: this reader's own prose quotes `## 962. D962`,
 * so the wiring is line-anchored (D959's lesson) and the arm deletes the HEADING line.
 *
 * Usage:  node scripts/check_shared_cache_async.mjs [--self-test] [--report]
 * Exit:   0 every claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const REGISTRY = 'apps/ai/nexus_ai/tools/registry.py';
const TIER = 'apps/ai/nexus_ai/tools/redis_tier.py';
const PROBE = 'apps/ai/tests/test_shared_cache_does_not_block_event_loop.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_shared_cache_async.mjs';
const PATHS = [REGISTRY, TIER, PROBE, CI, ATLAS, STATUS, SELF];

/* Exact source needles: the offload shape, the preserved contract, and the probe's arms. */
const OFFLOAD_GET = 'await asyncio.to_thread(self._shared.get, shared_key[0], shared_key[1])';
const OFFLOAD_SET = 'await asyncio.to_thread(self._shared.set, shared_key[0], shared_key[1],';
const BARE_GET = 'raw = self._shared.get(shared_key[0], shared_key[1])';
const BARE_SET = 'self._shared.set(shared_key[0], shared_key[1], result, spec.cache_ttl_s)';
const CI_SELFTEST = `node ${SELF} --self-test`;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the shared-cache plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${expect ? ` [${expect}]` : ''}`);
    else notes.push(`held ${label}`);
  };
  const count = (p, needle) => t(p).split(needle).length - 1;

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — BOTH hot-path shared-cache calls are offloaded, and no bare blocking call remains. */
  has(REGISTRY, 'async def dispatch(', 'dispatch stays async', 'ASYNC-DISPATCH');
  has(REGISTRY, OFFLOAD_GET, 'the shared GET is offloaded to a thread', 'OFFLOAD-GET');
  has(REGISTRY, OFFLOAD_SET, 'the shared SET is offloaded to a thread', 'OFFLOAD-SET');
  absent(REGISTRY, BARE_GET, 'no bare blocking shared GET remains in dispatch', 'BARE-GET');
  absent(REGISTRY, BARE_SET, 'no bare blocking shared SET remains in dispatch', 'BARE-SET');
  if (count(REGISTRY, 'asyncio.to_thread(self._shared.') < 2) {
    offenders.push('MISSING — registry.py: fewer than 2 offloaded shared-cache call sites [OFFLOAD-COUNT]');
  } else notes.push('held both shared-cache call sites are offloaded');

  /* 2 — the fix is an offload, NOT a client rewrite; the sync contract + degrade stay intact. */
  has(TIER, 'import redis', 'the tier still imports the sync redis client', 'SYNC-IMPORT');
  has(TIER, 'redis.Redis.from_url(', 'the tier still constructs the sync Redis client', 'SYNC-CLIENT');
  has(TIER, 'socket_timeout=1.0,', 'the blocking bound is preserved (it is why offload is required)', 'SOCKET-TIMEOUT');
  has(TIER, 'def get(self, spec_name: str, canonical_args: str) -> Any:', 'get() stays a sync method', 'SYNC-GET');
  has(TIER, 'def set(self, spec_name: str, canonical_args: str, value: Any, ttl_s: int) -> None:',
      'set() stays a sync method', 'SYNC-SET');
  absent(TIER, 'redis.asyncio', 'the sync client was NOT silently swapped for an async rewrite', 'NO-ASYNC-REWRITE');
  has(TIER, 'falling back to the local cache', 'the offline-degrade path still logs and falls back', 'DEGRADE');
  has(TIER, 'NEXUS_AI_SHARED_CACHE', 'the shared tier is still opt-in by env var', 'OPT-IN');
  if (count(REGISTRY, 'if self._shared is not None:') < 2) {
    offenders.push('MISSING — registry.py: both shared-cache guards (hit + write) must survive [DEGRADE-GUARD]');
  } else notes.push('held both shared-cache guards survive the offload');
  has(REGISTRY, 'outcome="ok_cached_shared")', 'the shared-cache-hit audit outcome is preserved', 'OUTCOME');
  has(REGISTRY, 'await asyncio.wait_for(handler(args, subject=subject),',
      'the per-tool timeout the offload re-enables is present', 'WAIT-FOR');
  has(REGISTRY, 'import asyncio', 'asyncio is imported for the offload', 'ASYNCIO-IMPORT');

  /* 3 — the runnable behavioural proof + its one-flipped-variable falsifier ship. */
  has(PROBE, 'def test_shared_cache_offload_keeps_event_loop_responsive():',
      'the positive event-loop-responsiveness arm exists', 'PROBE-POSITIVE');
  has(PROBE, 'def test_without_offload_the_loop_is_starved(monkeypatch):',
      'the falsifier arm exists', 'PROBE-FALSIFIER');
  has(PROBE, 'monkeypatch.setattr(asyncio, "to_thread", inline, raising=True)',
      'the falsifier flips exactly one variable (to_thread -> inline)', 'FLIP-VARIABLE');
  has(PROBE, 'time.sleep(BLOCK_S)', 'the probe drives a genuinely blocking sync call', 'BLOCKING-STUB');
  has(PROBE, 'asyncio.create_task(heartbeat())', 'the probe measures loop turnarounds during dispatch', 'HEARTBEAT');
  has(PROBE, 'ticks >= 4', 'the positive arm asserts a responsive loop', 'POSITIVE-ASSERT');
  has(PROBE, 'ticks <= 2', 'the falsifier asserts a starved loop', 'FALSIFIER-ASSERT');

  /* 4 — wiring: CI runs this reader (self-test chain) AND the pytest probe (ai job); docs + ledger. */
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(CI, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  // EOL-agnostic, line-ANCHORED heading: this reader's own prose quotes `## 962. D962` inline.
  if (!new RegExp('^## 962\\. D962(?=\\s|$)', 'm').test(t(STATUS))) {
    offenders.push('MISSING — docs/STATUS.md: no `## 962. D962` heading line [LEDGER-HEADING]');
  } else notes.push('held the ledger holds a §962 heading line');

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

const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');

/* Corruptions are applied to an EOL-agnostic line array and rejoined with '\n' in memory. */
const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  f.set(p, text.replace(from, to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }

  const arms = [
    ['GET offload removed (bare blocking call)', mutate(real, REGISTRY, OFFLOAD_GET, BARE_GET), 'BARE-GET'],
    ['SET offload removed (bare blocking call)', mutate(real, REGISTRY, OFFLOAD_SET, BARE_SET), 'BARE-SET'],
    ['dispatch de-async-ed', mutate(real, REGISTRY, 'async def dispatch(', 'def dispatch('), 'ASYNC-DISPATCH'],
    ['sync client swapped for async rewrite', mutate(real, TIER, 'redis.Redis.from_url(', 'redis.asyncio.Redis.from_url('), 'NO-ASYNC-REWRITE'],
    ['offline-degrade branch erased', mutate(real, TIER, 'falling back to the local cache', '/* degrade removed */'), 'DEGRADE'],
    ['per-tool wait_for timeout dropped', mutate(real, REGISTRY, 'await asyncio.wait_for(handler(args, subject=subject),', 'await handler(args, subject=subject),'), 'WAIT-FOR'],
    ['probe positive arm erased', mutate(real, PROBE, 'def test_shared_cache_offload_keeps_event_loop_responsive():', 'def _positive_removed():'), 'PROBE-POSITIVE'],
    ['probe falsifier arm erased', mutate(real, PROBE, 'def test_without_offload_the_loop_is_starved(monkeypatch):', 'def _falsifier_removed(monkeypatch):'), 'PROBE-FALSIFIER'],
    ['falsifier flip-variable weakened', mutate(real, PROBE, 'monkeypatch.setattr(asyncio, "to_thread", inline, raising=True)', 'monkeypatch.setattr(asyncio, "to_thread", asyncio.to_thread, raising=True)'), 'FLIP-VARIABLE'],
    ['CI self-test chain cut', mutate(real, CI, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, CI, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ledger §962 heading line removed', dropHeadingLine(real, STATUS, /^## 962\. D962(?=\s|$)/), 'LEDGER-HEADING'],
  ];
  // reader-absent changes only `present`, not file bytes.
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [labelText, arm, tag] of arms) {
    // The 13 mutation arms carry their expect tag in the THIRD tuple slot; the
    // reader-absent arm carries it as `arm.expect`. Read either shape — binding only
    // `arm.expect` silently made 13 arms vacuous (red for cause, scored undefined).
    const expect = arm.expect ?? tag;
    if (arm.skipped) { console.log(`  self-test  ${labelText.padEnd(42)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) { // D954 invariant: a corruption that changes nothing is a defect, never a pass
      console.log(`  self-test  ${labelText.padEnd(42)} NO-OP (defect!)`);
      allCaught = false;
      continue;
    }
    const j = judge(arm.files, arm.present ?? present);
    const joined = j.offenders.join(' | ');
    const red = j.unchecked !== null || j.offenders.length > 0;
    const rightReason = joined.includes(expect);
    const pass = red && rightReason;
    if (!pass) allCaught = false;
    console.log(`  self-test  ${labelText.padEnd(42)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${j.offenders.length} expect=${JSON.stringify(expect)}`);
    if (red && !rightReason) for (const o of j.offenders.slice(0, 2)) console.log('      got: ' + o);
  }

  // GREEN control: a harmless constant change must NOT redden the reader (it judges structure,
  // not incidental literals) — the mirror of a no-op guard on the other side.
  const control = mutate(real, PROBE, 'BLOCK_S = 0.06', 'BLOCK_S = 0.07');
  const controlJudge = judge(control.files ?? real, present);
  const controlGreen = controlJudge.offenders.length === 0 && controlJudge.unchecked === null;
  if (!controlGreen) allCaught = false;
  console.log(`  self-test  ${'harmless constant change stays GREEN'.padEnd(42)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${controlJudge.offenders.length}`);
  if (!controlGreen) for (const o of controlJudge.offenders.slice(0, 4)) console.log('      ' + o);

  console.log(`  self-test  all arms redden for cause + control green: ${allCaught} (${arms.length} corruption arms + 1 control)`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`FALSE SHARED-CACHE-ASYNC WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D962 shared-cache async offload wired, ${result.notes.length} holds`);
process.exit(0);
