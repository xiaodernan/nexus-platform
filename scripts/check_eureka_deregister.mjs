#!/usr/bin/env node
/**
 * NEXUS D965 — the AI service's graceful shutdown must AWAIT the Eureka de-registration.
 *
 * THE HOLE. `apps/ai/nexus_ai/discovery.py::Registration.stop` is `async def`, and its client
 * (the object `await ec.init_async(...)` returns) has an `async def stop()`: cancelling the
 * py-eureka heartbeat AND sending the DOWN register + DELETE are coroutine bodies that run
 * ONLY when awaited. Before D965 the shutdown hook called `self.client.stop()` BARE. Calling
 * an `async def` merely creates a coroutine — it does not schedule it — so on graceful
 * shutdown the de-registration DELETE was never sent, the client's heartbeat timer was never
 * cancelled, and Python exited with `RuntimeWarning: coroutine was never awaited`. The
 * surrounding `try/except Exception` could not help: a bare async call raises nothing.
 * Under the opt-in registry plane (`NEXUS_AI_EUREKA_ENABLED=true`) a killed AI replica stayed
 * listed in Eureka until its 10s lease self-expired. This is the inverse of D962: there a
 * blocking sync call sat on the async loop; here an async call was left off the loop.
 *
 * THE FIX (D965). `await asyncio.wait_for(self.client.stop(), timeout=_DEREGISTER_TIMEOUT_S)`.
 * The await makes the de-registration actually leave the process; the bound keeps the
 * documented "shutdown must never hang on a down registry" contract (a hanging registry
 * times out and the 10s lease self-expires). `asyncio.TimeoutError` IS an `Exception`, so the
 * existing `except Exception` still logs-and-degrades. The caller chain is unchanged: the
 * FastAPI lifespan `await stop_eureka(...) -> await registration.stop()` stays awaited.
 *
 * WHAT THIS DOES NOT CLAIM. That a live Eureka DELETE was observed, that any test ran today,
 * that a FastAPI worker was actually shut down, or any timing/latency number. The behavioural
 * proof is the offline pytest probe `apps/ai/tests/test_eureka_deregister_is_awaited.py`
 * (positive: a stub's async stop() sets its flag; falsifier: drop the coroutine instead of
 * awaiting it — one flipped variable — and require the flag to stay clear + RuntimeWarning;
 * plus a hanging-registry arm and a heartbeat-cancel arm) run on the CI `ai` job's
 * `uv run pytest -q`. This reader judges only source text and wiring.
 *
 * SELF-TEST. `judge` is pure over a (path -> text) map. `--self-test` plants corruptions in
 * memory: revert the await to a bare call, drop the timeout bound (bare `await client.stop()`),
 * remove the bound constant, de-async the hook, narrow the exception guard, break the caller
 * await, erase each probe arm, cut the CI/ATLAS/ledger bindings, and remove the reader. Every
 * arm carries an `expect` substring the offender MUST contain (red-for-the-wrong-reason still
 * fails), a D954 no-op snapshot guard (a corruption that changes no byte is a defect), and a
 * D959 line-anchored ledger-heading match (this reader's own prose quotes the heading, so a
 * plain `.includes` would be a vacuous needle). One GREEN control (a harmless constant change
 * must NOT redden the reader) guards the other side.
 *
 * Usage:  node scripts/check_eureka_deregister.mjs [--self-test] [--report]
 * Exit:   0 every claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const DISCOVERY = 'apps/ai/nexus_ai/discovery.py';
const APP = 'apps/ai/nexus_ai/api/app.py';
const PROBE = 'apps/ai/tests/test_eureka_deregister_is_awaited.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_eureka_deregister.mjs';
const PATHS = [DISCOVERY, APP, PROBE, CI, ATLAS, STATUS, SELF];

/* Exact source needles. */
const AWAIT_BOUND = 'await asyncio.wait_for(self.client.stop(), timeout=_DEREGISTER_TIMEOUT_S)';
const BARE_CALL = 'self.client.stop()';
const BOUND_CONST = '_DEREGISTER_TIMEOUT_S = 2.0';
const AWAIT_UNBOUND = 'await self.client.stop()';
const CI_SELFTEST = `node ${SELF} --self-test`;
// The `m` flag is load-bearing: judge tests this against the WHOLE STATUS text, so without it
// `^` anchors only at string start and the heading needle can never match (a D954-class dead
// needle that the self-test's clean-plane precondition refuses to let through). The self-test's
// dropHeadingLine still filters one line at a time, where `m` is harmless.
const HEADING_RE = /^## 965\. D965(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the eureka-deregister plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the shutdown hook awaits the client's coroutine, under a bound; no bare call remains. */
  has(DISCOVERY, 'async def stop(self) -> None:', 'the shutdown hook stays async', 'ASYNC-HOOK');
  has(DISCOVERY, AWAIT_BOUND, 'the client stop() coroutine is awaited under a timeout', 'AWAIT-BOUND');
  has(DISCOVERY, BOUND_CONST, 'a positive bounded deregister timeout is declared', 'BOUND-CONST');
  // A bare `self.client.stop()` on its OWN line is the defect. It must be line-anchored:
  // the fixed AWAIT_BOUND line legitimately CONTAINS `self.client.stop()` as an argument.
  const bareLine = /^[ \t]*self\.client\.stop\(\)[ \t]*$/m.test(t(DISCOVERY));
  if (bareLine) offenders.push('STALE — discovery.py: a bare `self.client.stop()` line remains — the coroutine is never scheduled [NO-BARE]');
  else notes.push('held no bare client.stop() line remains');
  absent(DISCOVERY, AWAIT_UNBOUND, 'the de-registration is not awaited without a bound', 'NO-UNBOUND-AWAIT');
  has(DISCOVERY, 'import asyncio', 'asyncio is imported for wait_for', 'ASYNCIO-IMPORT');

  /* 2 — the fail-open contract survives: a down registry degrades, never hangs or crashes boot. */
  has(DISCOVERY, 'except Exception:', 'the graceful-degrade guard survives', 'DEGRADE-GUARD');
  has(DISCOVERY, 'the lease expires on its own', 'the lease-self-expiry rationale is preserved', 'LEASE-RATIONALE');
  has(DISCOVERY, 'await self.client.send_heartbeat()', 'the renew task the hook cancels is present', 'HEARTBEAT');

  /* 3 — the caller chain stays awaited: FastAPI lifespan -> stop_eureka -> registration.stop(). */
  has(APP, 'await stop_eureka(eureka_registration)', 'the lifespan awaits the eureka teardown', 'CALLER-AWAIT');
  has(DISCOVERY, 'async def stop_eureka(', 'the teardown helper is present', 'STOP-EUREKA');
  has(DISCOVERY, 'await registration.stop()', 'the helper awaits Registration.stop()', 'HELPER-AWAIT');

  /* 4 — the runnable behavioural proof + its one-flipped-variable falsifier ship. */
  has(PROBE, 'def test_graceful_stop_awaits_deregistration():', 'the positive arm exists', 'PROBE-POSITIVE');
  has(PROBE, 'def test_without_await_de_registration_is_silently_skipped(monkeypatch):', 'the falsifier arm exists', 'PROBE-FALSIFIER');
  has(PROBE, 'def test_hanging_registry_cannot_hang_shutdown(caplog):', 'the bounded-shutdown arm exists', 'PROBE-TIMEOUT');
  has(PROBE, 'def test_shutdown_bound_is_configured():', 'the bound-configuration arm exists', 'PROBE-BOUND');
  has(PROBE, 'monkeypatch.setattr(discovery.asyncio, "wait_for", drop, raising=True)',
      'the falsifier flips exactly one variable (wait_for -> drop)', 'FLIP-VARIABLE');
  has(PROBE, 'assert stub.de_registered is True', 'the positive arm asserts de-registration ran', 'POSITIVE-ASSERT');
  has(PROBE, 'assert stub.de_registered is False', 'the falsifier asserts de-registration was skipped', 'FALSIFIER-ASSERT');
  has(PROBE, 'never awaited', 'the never-awaited RuntimeWarning signature is asserted', 'NEVER-AWAITED');

  /* 5 — wiring: CI runs this reader AND the ai-job pytest probe; docs + ledger. */
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(CI, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  // EOL-agnostic, line-ANCHORED heading: this reader's own prose quotes the heading inline.
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push('MISSING — docs/STATUS.md: no `## 965. D965` heading line [LEDGER-HEADING]');
  } else notes.push('held the ledger holds a §965 heading line');

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
    ['await reverted to bare call (pre-D965)', mutate(real, DISCOVERY, AWAIT_BOUND, BARE_CALL), 'NO-BARE'],
    ['await dropped but left unbound', mutate(real, DISCOVERY, AWAIT_BOUND, AWAIT_UNBOUND), 'NO-UNBOUND-AWAIT'],
    ['bound timeout constant erased', mutate(real, DISCOVERY, BOUND_CONST, '_DEREGISTER_TIMEOUT_S = 0;'), 'BOUND-CONST'],
    ['shutdown hook de-async-ed', mutate(real, DISCOVERY, 'async def stop(self) -> None:', 'def stop(self) -> None:'), 'ASYNC-HOOK'],
    ['graceful-degrade guard removed', mutate(real, DISCOVERY, 'the lease expires on its own', '/* rationale removed */'), 'LEASE-RATIONALE'],
    ['caller await cut', mutate(real, APP, 'await stop_eureka(eureka_registration)', 'stop_eureka(eureka_registration)'), 'CALLER-AWAIT'],
    ['helper await cut', mutate(real, DISCOVERY, 'await registration.stop()', 'registration.stop()'), 'HELPER-AWAIT'],
    ['probe positive arm erased', mutate(real, PROBE, 'def test_graceful_stop_awaits_deregistration():', 'def _positive_removed():'), 'PROBE-POSITIVE'],
    ['probe falsifier arm erased', mutate(real, PROBE, 'def test_without_await_de_registration_is_silently_skipped(monkeypatch):', 'def _falsifier_removed(monkeypatch):'), 'PROBE-FALSIFIER'],
    ['probe timeout arm erased', mutate(real, PROBE, 'def test_hanging_registry_cannot_hang_shutdown(caplog):', 'def _timeout_removed(caplog):'), 'PROBE-TIMEOUT'],
    ['falsifier flip-variable weakened', mutate(real, PROBE, 'monkeypatch.setattr(discovery.asyncio, "wait_for", drop, raising=True)', 'monkeypatch.setattr(discovery.asyncio, "wait_for", discovery.asyncio.wait_for, raising=True)'), 'FLIP-VARIABLE'],
    ['CI self-test chain cut', mutate(real, CI, CI_SELFTEST, ''), 'CI-READER'],
    ['CI pytest probe schedule cut', mutate(real, CI, 'uv run pytest -q', 'uv run true'), 'CI-PROBE'],
    ['ATLAS reader row erased', mutate(real, ATLAS, SELF, 'scripts/_removed.mjs'), 'ATLAS-READER'],
    ['ledger §965 heading line removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  // reader-absent changes only `present`, not file bytes.
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [labelText, arm, tag] of arms) {
    // The mutation arms carry `expect` in the THIRD tuple slot; the reader-absent arm carries
    // it as `arm.expect`. Read either shape — D962's first self-test run bound only `arm.expect`
    // and silently made 13 arms vacuous (red for cause, scored undefined). Never repeat that.
    const expect = arm.expect ?? tag;
    if (arm.skipped) { console.log(`  self-test  ${labelText.padEnd(44)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) { // D954 invariant: a corruption that changes nothing is a defect, never a pass
      console.log(`  self-test  ${labelText.padEnd(44)} NO-OP (defect!)`);
      allCaught = false;
      continue;
    }
    const j = judge(arm.files, arm.present ?? present);
    const joined = j.offenders.join(' | ');
    const red = j.unchecked !== null || j.offenders.length > 0;
    const rightReason = joined.includes(expect);
    const pass = red && rightReason;
    if (!pass) allCaught = false;
    console.log(`  self-test  ${labelText.padEnd(44)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${j.offenders.length} expect=${JSON.stringify(expect)}`);
    if (red && !rightReason) for (const o of j.offenders.slice(0, 2)) console.log('      got: ' + o);
  }

  // GREEN control: a harmless constant change must NOT redden the reader (it judges the
  // de-registration call shape, not the unrelated heartbeat interval).
  const control = mutate(real, DISCOVERY, '_HEARTBEAT_INTERVAL_S = 5.0', '_HEARTBEAT_INTERVAL_S = 6.0');
  const controlJudge = judge(control.files ?? real, present);
  const controlGreen = controlJudge.offenders.length === 0 && controlJudge.unchecked === null;
  if (!controlGreen) allCaught = false;
  console.log(`  self-test  ${'harmless heartbeat-constant change stays GREEN'.padEnd(44)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${controlJudge.offenders.length}`);
  if (!controlGreen) for (const o of controlJudge.offenders.slice(0, 4)) console.log('      ' + o);

  console.log(`  self-test  all arms redden for cause + control green: ${allCaught} (${arms.length} corruption arms + 1 control)`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`FALSE EUREKA-DEREGISTER WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D965 Eureka de-registration awaited + bounded, ${result.notes.length} holds`);
process.exit(0);
