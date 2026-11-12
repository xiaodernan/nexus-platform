#!/usr/bin/env node
/**
 * NEXUS D983 — `config.Settings.request_timeout_s` / env `NEXUS_REQUEST_TIMEOUT_S` must be a
 * REAL knob that reaches both live adapters' httpx client, not a parsed-then-dropped value.
 *
 * THE HOLE (found by running the D982 live-intent path against the wkapi.pro `gpt-6-sol`
 * proxy): `config.load_settings()` parsed `request_timeout_s` (default 12) and the operator's
 * env, but `models/factory.py::build_adapters` constructed BOTH `OpenAIAdapter` and
 * `AnthropicAdapter` without `timeout_s`, so `HttpLLMAdapter.__init__`'s hard-coded 20.0s won.
 * The knob was dead, and the 20s ceiling made the D982 live path degrade to `mock` on most
 * turns. The `_POOL_CACHE` key also omitted the timeout, so even a repaired value would have
 * handed back the stale httpx client.
 *
 * THE FIX: `factory.py` threads `_request_timeout(settings)` into both adapters (via `getattr`
 * so the §105 ladder's bare dummy settings still work), raises the default to 45s, and puts
 * the timeout in the cache key; `config.py` default 12 -> 45 (env `NEXUS_REQUEST_TIMEOUT_S`).
 * Live evidence (opt-in, key-env-only, NOT a CI test): same soba query, single variable the
 * now-live timeout — 20s -> 0/4 live (all `mock`/`degraded=true`); 60s -> 4/4 live
 * (`provider=openai`, `category=soba`, `degraded=false`); `adapter_timeout_s` and the real
 * `httpx_client.read` both tracked the env value.
 *
 * WHAT THIS reader HOLDS: the product shape (both adapters get `timeout_s`, cache key carries
 * it, `getattr` fallback, config default/env, the §105 mock floor + ladder order untouched,
 * the honest-wire adapters intact) and that the offline falsifiable probe
 * `apps/ai/tests/test_request_timeout_reaches_the_adapters.py` ships its positive, env-flow,
 * cache-identity, fallback, zero-regression and one-variable-falsifier arms; plus CI / ATLAS /
 * ledger wiring. A jsdom-free, DB-free source gate.
 *
 * SELF-TEST: --self-test plants corruptions in memory — drop `timeout_s` from either adapter,
 * restore the stale cache key, hardcode the `getattr` fallback away, revert the config default,
 * erase a probe arm, cut CI/ATLAS/ledger wiring — and requires EACH to redden for the RIGHT
 * expect tag while the real plane holds. D954 no-op guard, D959 line-anchored `## 983.` heading,
 * and a GREEN control (a legitimate comment edit) keep the judge honest.
 *
 * WHAT THIS DOES NOT SAY: that a live proxy was called by CI (it is not); that 45s is the right
 * production value (operators tune it); that any bill was paid; or that the §7.1 Intent schema
 * changed (D982 owns that). The falsifier is "did the code speak the wired-timeout shape?"
 *
 * Usage:  node scripts/check_d983_request_timeout_wired.mjs [--self-test] [--report] [--ci=<path>]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const CI_OVERRIDE = argv.find((a) => a.startsWith('--ci='))?.slice('--ci='.length);

const FACTORY = 'apps/ai/nexus_ai/models/factory.py';
const CONFIG = 'apps/ai/nexus_ai/config.py';
const BASE = 'apps/ai/nexus_ai/models/base.py';
const PROBE = 'apps/ai/tests/test_request_timeout_reaches_the_adapters.py';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d983_request_timeout_wired.mjs';
const PATHS = [FACTORY, CONFIG, BASE, PROBE, CI, ATLAS, STATUS, SELF];

const CI_SELFTEST = `node ${SELF} --self-test`;
const HEADING_RE = /^## 983\. D983(?=\s|$)/m;

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the timeout-wiring plane is empty or unreadable — a census that found nothing cleared nothing' };
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
  const countAtLeast = (p, needle, min, label, expect) => {
    const got = t(p).split(needle).length - 1;
    if (got < min) offenders.push(`MISSING — ${p}: ${label} (found ${got}, need >= ${min})${tag(expect)}`);
    else notes.push(`held ${label} (${got})`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`, `ABSENT — ${p}`);

  /* 1 — the factory threads the operator timeout into BOTH live adapters (symmetric). */
  has(FACTORY, 'DEFAULT_REQUEST_TIMEOUT_S = 45.0', 'the shared default lives in the factory', 'DEFAULT');
  has(FACTORY, 'def _request_timeout(settings: Any) -> float:',
      'the settings->timeout helper exists', 'HELPER');
  has(FACTORY, 'return float(getattr(settings, "request_timeout_s", DEFAULT_REQUEST_TIMEOUT_S))',
      'the helper reads the knob with a safe dummy-settings fallback', 'GETATTR');
  countAtLeast(FACTORY, 'timeout_s=timeout_s,', 2,
      'BOTH live adapters receive timeout_s', 'TWO-ADAPTERS');
  has(FACTORY, 'timeout_s = _request_timeout(settings)', 'build_adapters resolves the timeout once', 'RESOLVE');

  /* 2 — the pool cache identity carries the timeout, else a repaired knob hands back a stale client. */
  has(FACTORY, '|{_request_timeout(settings)}', 'the cache key includes the timeout', 'CACHE-KEY');

  /* 3 — config default + env parser raised together; the knob is parseable. */
  has(CONFIG, 'request_timeout_s: float = 45.0', 'the Settings default is the bounded 45s', 'CFG-DEFAULT');
  has(CONFIG, 'float(_env("NEXUS_REQUEST_TIMEOUT_S") or 45)', 'the env parser feeds the knob', 'CFG-ENV');

  /* 4 — honest-wire contracts survive: the httpx client is built from self.timeout_s, the
     degrade ladder floor + order are untouched, and the adapters keep their real shape. */
  has(BASE, 'self.timeout_s = timeout_s', 'the adapter stores the deadline', 'STORE');
  has(BASE, 'httpx.AsyncClient(timeout=self.timeout_s)', 'the real httpx client uses the deadline', 'HTTPX');
  has(BASE, 'timeout_s: float = 20.0', 'the base default remains a safe fallback for direct ctors', 'BASE-DEFAULT');
  has(FACTORY, 'pool["mock"] = MockAdapter()', 'the §105 mock floor is still installed', 'MOCK-FLOOR');
  has(BASE, 'class HttpLLMAdapter', 'the honest wire adapter base still exists', 'HONEST-BASE');
  has(FACTORY, 'from nexus_ai.models.openai import OpenAIAdapter', 'openai adapter import intact', 'IMP-OAI');
  has(FACTORY, 'from nexus_ai.models.anthropic import AnthropicAdapter', 'anthropic adapter import intact', 'IMP-ANTH');

  /* 5 — the offline falsifiable probe ships every arm. */
  has(PROBE, 'def test_both_live_adapters_receive_the_operator_timeout():', 'both-adapters arm', 'P-BOTH');
  has(PROBE, 'def test_env_value_flows_from_load_settings_through_the_pool_to_the_client(monkeypatch):', 'env->wire arm', 'P-ENV');
  has(PROBE, 'def test_a_changed_timeout_is_a_different_pool_entry_not_the_stale_client():', 'cache-identity arm', 'P-CACHE');
  has(PROBE, 'def test_the_same_timeout_still_hits_the_cache():', 'cache-determinism arm', 'P-CACHED');
  has(PROBE, 'def test_dummy_settings_without_the_attr_fall_back_safely_and_mock_floor_holds():', 'dummy-fallback arm', 'P-FALLBACK');
  has(PROBE, 'def test_zero_regression_the_gradient_ladder_and_degrade_contract_are_untouched():', '§105 zero-regression arm', 'P-LADDER');
  has(PROBE, 'def test_falsifier_dropping_the_timeout_would_strand_the_knob():', 'one-variable falsifier arm', 'P-FALSIFIER');
  has(PROBE, 'assert _read_timeout(old_shape) != 37.0', 'falsifier asserts the old shape ignored the knob', 'P-FALSIFIER-ASSERT');

  /* 6 — wiring: CI runs this reader; ATLAS lists reader + probe; ledger line-anchored. */
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ciPath, 'uv run pytest -q', 'CI runs the ai-job pytest suite that executes the probe', 'CI-PROBE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, PROBE, 'ATLAS lists the runtime probe', 'ATLAS-PROBE');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 983. D983\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D983 heading line');

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
  f.set(p, text.split(from).join(to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const ciPath = CI_OVERRIDE ?? CI;
  const base = judge(real, present, ciPath);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['default constant reverted', mutate(real, FACTORY, 'DEFAULT_REQUEST_TIMEOUT_S = 45.0', 'DEFAULT_REQUEST_TIMEOUT_S = 20.0'), 'DEFAULT'],
    ['_request_timeout helper erased', mutate(real, FACTORY, 'def _request_timeout(settings: Any) -> float:', 'def _request_timeout_disabled(settings):'), 'HELPER'],
    ['getattr fallback hardened away', mutate(real, FACTORY, 'getattr(settings, "request_timeout_s", DEFAULT_REQUEST_TIMEOUT_S)', 'settings.request_timeout_s'), 'GETATTR'],
    ['both adapters timeout_s dropped', mutate(real, FACTORY, 'timeout_s=timeout_s,', '# timeout_s dropped'), 'TWO-ADAPTERS'],
    ['cache key timeout dropped', mutate(real, FACTORY, '|{_request_timeout(settings)}', ''), 'CACHE-KEY'],
    ['config default reverted', mutate(real, CONFIG, 'request_timeout_s: float = 45.0', 'request_timeout_s: float = 12.0'), 'CFG-DEFAULT'],
    ['config env parser cut', mutate(real, CONFIG, 'float(_env("NEXUS_REQUEST_TIMEOUT_S") or 45)', '12.0'), 'CFG-ENV'],
    ['httpx client built without deadline', mutate(real, BASE, 'httpx.AsyncClient(timeout=self.timeout_s)', 'httpx.AsyncClient()'), 'HTTPX'],
    ['mock floor removed', mutate(real, FACTORY, 'pool["mock"] = MockAdapter()', 'pool["_gone"] = None'), 'MOCK-FLOOR'],
    ['probe both-adapters arm erased', mutate(real, PROBE, 'def test_both_live_adapters_receive_the_operator_timeout():', 'def _both_removed():'), 'P-BOTH'],
    ['probe env-flow arm erased', mutate(real, PROBE, 'def test_env_value_flows_from_load_settings_through_the_pool_to_the_client(monkeypatch):', 'def _env_removed(monkeypatch):'), 'P-ENV'],
    ['probe cache-identity arm erased', mutate(real, PROBE, 'def test_a_changed_timeout_is_a_different_pool_entry_not_the_stale_client():', 'def _cache_removed():'), 'P-CACHE'],
    ['probe fallback arm erased', mutate(real, PROBE, 'def test_dummy_settings_without_the_attr_fall_back_safely_and_mock_floor_holds():', 'def _fallback_removed():'), 'P-FALLBACK'],
    ['probe falsifier arm erased', mutate(real, PROBE, 'def test_falsifier_dropping_the_timeout_would_strand_the_knob():', 'def _falsifier_removed():'), 'P-FALSIFIER'],
    ['probe falsifier assertion weakened', mutate(real, PROBE, 'assert _read_timeout(old_shape) != 37.0', 'assert True'), 'P-FALSIFIER-ASSERT'],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, 'node scripts/_absent.mjs --self-test'), 'CI-READER'],
    ['ATLAS reader row erased', mutate(real, ATLAS, `\`${SELF}\``, '`scripts/_removed.mjs`'), 'ATLAS-READER'],
    ['ATLAS probe row erased', mutate(real, ATLAS, PROBE, 'apps/ai/tests/_removed.py'), 'ATLAS-PROBE'],
    ['ledger D983 heading removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [label, arm, tagName] of arms) {
    const expect = arm.expect ?? tagName;
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(44)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) { console.log(`  self-test  ${label.padEnd(44)} NO-OP (defect!)`); allCaught = false; continue; }
    const out = judge(arm.files, arm.present ?? present, ciPath);
    const red = out.offenders.length > 0 || out.unchecked;
    const rightReason = out.offenders.some((o) => o.includes(expect));
    const pass = red && rightReason;
    console.log(`  self-test  ${label.padEnd(44)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expect}"`);
    if (!pass) { allCaught = false; for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o); }
  }
  // GREEN control: a legitimate comment rewording must NOT redden (guards an overfit judge).
  {
    const f = new Map(real);
    f.set(FACTORY, (f.get(FACTORY) ?? '').replace(
        'The knob must survive to BOTH adapters',
        'The operator deadline must survive to BOTH adapters'));
    const out = judge(f, present, ciPath);
    const controlGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate comment rewording stays GREEN'.padEnd(44)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!controlGreen) allCaught = false;
  }
  // Real plane still holds.
  {
    const out = judge(real, present, ciPath);
    const realGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate plane stays GREEN'.padEnd(44)} green offenders=${out.offenders.length}`);
    if (!realGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  console.log(`  self-test  all arms redden for cause + guards green: ${allCaught} (${arms.length} corruption arms)`);
  process.exit(allCaught ? 0 : 1);
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk();
const result = judge(files, present, ciPath);
if (result.unchecked) { console.log('RESULT: NOT CHECKED — ' + result.unchecked); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log('  ' + n);
if (result.offenders.length) {
  console.log(`FALSE TIMEOUT-WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D983 request-timeout knob wired to both adapters, ${result.notes.length} holds`);
