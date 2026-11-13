#!/usr/bin/env node
/**
 * NEXUS D1052 — "the provider did not report cache accounting" is not "nothing was cached".
 *
 * Measured on the operator's proxy (wkapi.pro / gpt-6-sol, 2026-11-13), eight byte-identical
 * requests: `prompt_tokens=4529` on all eight, `cached_tokens=4352` on five, and no
 * `prompt_tokens_details` at all on the other three. The ledger persisted those three as
 * `cached_tokens=0`, so the console divided 5x4352 by 8x4529 and showed 60% — the operator's
 * "the cache hit rate is far too low". The cache was fine; the accounting was not.
 *
 * This reader holds the distinction end to end, because one dropped link silently restores
 * the misleading number:
 *
 *   (a) the adapter marks whether the provider answered (and both transports agree);
 *   (b) the ledger row and the INSERT carry the flag, so the fact survives the write;
 *   (c) migration V14 adds the column additively (no rewrite, no backfill);
 *   (d) both cache queries and the controller divide over reporting calls only, falling back
 *       to the raw pair when nothing reported — never turning a real ledger into null;
 *   (e) the web derives the same way, and the offline pins (py + ts) hold the measurement.
 *
 * Self-test plants one corruption per claim; an arm that reddens without its expect tag, or
 * that did not change a byte (D954 no-op guard), is a defect in this reader, not a pass.
 *
 * Exit: 0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const BASE = 'apps/ai/nexus_ai/models/base.py';
const OPENAI = 'apps/ai/nexus_ai/models/openai.py';
const ROUTER = 'apps/ai/nexus_ai/models/router.py';
const RUNS = 'apps/ai/nexus_ai/api/runs.py';
const MIGRATION = 'infra/db/migrations/V14__llm_calls_cache_reported.sql';
const REPO = 'services/platform/src/main/java/com/nexus/admin/AdminAiRepository.java';
const CONTROLLER = 'services/platform/src/main/java/com/nexus/admin/AdminAiController.java';
const WEB = 'apps/web/src/lib/console-admin.ts';
const TEST_PY = 'apps/ai/tests/test_cache_reporting_is_not_a_miss.py';
const D980_TEST = 'apps/ai/tests/test_d980_usage_is_bounded.py';
const TEST_TS = 'apps/web/src/lib/console-admin.test.ts';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1052_cache_reporting_truth.mjs';
const PATHS = [BASE, OPENAI, ROUTER, RUNS, MIGRATION, REPO, CONTROLLER, WEB, TEST_PY, D980_TEST,
  TEST_TS, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1052\. D1052(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1052 plane is empty or unreadable — a census that found nothing cleared nothing' };
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
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* (a) the adapter answers the question the ledger needs */
  has(BASE, 'cache_reported: bool = False', 'the response carries a reporting flag', 'FIELD');
  has(OPENAI, 'cache_reported = isinstance(cached_raw, (int, float))', 'the adapter computes the flag from the wire', 'ADAPTER');
  has(OPENAI, 'cache_reported=cache_reported,', 'the adapter passes the flag to the response', 'ADAPTER-PASS');
  absent(OPENAI, 'cache_reported = cached_raw is not None',
      'silence is not allowed to be read as a report', 'ADAPTER-SEMANTICS');

  /* (b) the fact survives the ledger write */
  has(ROUTER, '"cache_reported": bool(getattr(r, "cache_reported", False)),',
      'the ledger row carries the flag', 'ROW');
  has(RUNS, 'cached_tokens, cache_reported)', 'the INSERT names the column', 'INSERT-COL');
  has(RUNS, 'VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      'the INSERT binds twelve parameters', 'INSERT-ARGS');
  has(RUNS, 'bool(row.get("cache_reported") or False),', 'the INSERT binds the flag', 'INSERT-BIND');

  /* (c) the column exists, additively */
  has(MIGRATION, 'ADD COLUMN IF NOT EXISTS cache_reported boolean NOT NULL DEFAULT false',
      'V14 adds the column additively', 'MIGRATION');
  const migration = t(MIGRATION).toLowerCase();
  for (const forbidden of ['update llm_calls', 'drop column', 'alter column', 'truncate']) {
    if (migration.includes(forbidden)) {
      offenders.push(`REWRITE — ${MIGRATION}: the migration mutates existing rows (${forbidden})${tag('MIGRATION-ADDITIVE')}`);
    }
  }

  /* (d) the aggregates divide over the calls that reported */
  has(REPO, 'as reporting_calls', 'the totals query counts reporting calls', 'SQL-CALLS');
  has(REPO, 'as reporting_prompt_tokens', 'the totals query sums the honest denominator', 'SQL-PROMPT');
  has(REPO, 'as reporting_cached_tokens', 'the totals query sums the honest numerator', 'SQL-CACHED');
  has(CONTROLLER, 'double rateBase = reported > 0 ? reported : prompt;',
      'the rate falls back to the raw pair only when nothing reported', 'RATE');
  has(CONTROLLER, 'totals.put("reporting_calls"', 'the console payload states its coverage', 'RATE-COVERAGE');
  has(CONTROLLER, 'reporting_cached_tokens / "', 'the payload documents the new divisor', 'RATE-DOC');

  /* (e) the web derives with the same rule, and the offline pins hold the measurement */
  has(WEB, 'export function cacheHitRateOf(', 'the web has the reporting-aware derivation', 'WEB-FN');
  has(WEB, 'cache_hit_rate: cacheHitRateOf(row, cachedTokens, promptTokens),',
      'per-model rows use the reporting-aware rate', 'WEB-ROW');
  has(WEB, 'cache_hit_rate: cacheHitRateOf(totalsRow, cachedTokens, promptTokens),',
      'totals use the reporting-aware rate', 'WEB-TOTALS');
  has(TEST_PY, 'def test_a_provider_that_omits_the_detail_is_not_a_miss(', 'the offline pin holds silence', 'TEST-PY');
  has(TEST_PY, 'def test_a_provider_that_reports_zero_is_reported_and_is_a_real_miss(',
      'the offline pin holds a reported zero as a real miss', 'TEST-ZERO');
  has(TEST_TS, "describe('cache coverage — silence is not a miss (D1052)'", 'the web pin holds the measurement', 'TEST-TS');
  // Found while measuring: D1044 made SSE the default, and this module's fake response has
  // only `.json()` — the three direct-wire arms would redden `uv run pytest -q`.
  has(D980_TEST, 'def _direct_json_transport(monkeypatch):',
      'the direct-wire usage probe opts out of the SSE default', 'TEST-D980');

  /* (f) the gates hold the unit */
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  has(ATLAS, MIGRATION, 'ATLAS lists the V14 migration', 'ATLAS-MIGRATION');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1052. D1052\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1052 heading line');

  return { offenders, notes, paths: PATHS };
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

const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) {
    return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  }
  f.set(p, text.split(from).join(to));
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
    ['the response loses its reporting flag',
      mutate(real, BASE, 'cache_reported: bool = False', 'cache_reported_absent: bool = False'), 'FIELD'],
    ['the adapter stops computing the flag',
      mutate(real, OPENAI, 'cache_reported = isinstance(cached_raw, (int, float))',
             'cache_reported_absent = isinstance(cached_raw, (int, float))'), 'ADAPTER'],
    ['the adapter stops passing the flag',
      mutate(real, OPENAI, 'cache_reported=cache_reported,', 'cache_reported=True,'), 'ADAPTER-PASS'],
    ['silence is read as a report',
      mutate(real, OPENAI, 'cache_reported = isinstance(cached_raw, (int, float))',
             'cache_reported = cached_raw is not None'), 'ADAPTER-SEMANTICS'],
    ['the ledger row drops the flag',
      mutate(real, ROUTER, '"cache_reported": bool(getattr(r, "cache_reported", False)),',
             '"cache_reported_absent": False,'), 'ROW'],
    ['the INSERT stops naming the column',
      mutate(real, RUNS, 'cached_tokens, cache_reported)', 'cached_tokens)'), 'INSERT-COL'],
    ['the INSERT stops binding the flag',
      mutate(real, RUNS, 'bool(row.get("cache_reported") or False),', 'False,'), 'INSERT-BIND'],
    ['the migration rewrites instead of adding', (() => {
      const f = new Map(real);
      const text = f.get(MIGRATION) ?? '';
      f.set(MIGRATION, `${text}\nUPDATE llm_calls SET cache_reported = false;\n`);
      return { files: f };
    })(), 'MIGRATION-ADDITIVE'],
    ['the totals query stops scoping to reporting calls',
      mutate(real, REPO, 'as reporting_prompt_tokens', 'as reporting_prompt_tokenz'), 'SQL-PROMPT'],
    ['the controller divides over every call',
      mutate(real, CONTROLLER, 'double rateBase = reported > 0 ? reported : prompt;',
             'double rateBase = prompt;'), 'RATE'],
    ['the payload stops stating its coverage',
      mutate(real, CONTROLLER, 'totals.put("reporting_calls"', 'totals.put("reporting_calls_absent"'), 'RATE-COVERAGE'],
    ['the web falls back to the raw pair unconditionally',
      mutate(real, WEB, 'cache_hit_rate: cacheHitRateOf(row, cachedTokens, promptTokens),',
             'cache_hit_rate: cacheHitRate(cachedTokens, promptTokens),'), 'WEB-ROW'],
    ['the web totals fall back to the raw pair',
      mutate(real, WEB, 'cache_hit_rate: cacheHitRateOf(totalsRow, cachedTokens, promptTokens),',
             'cache_hit_rate: cacheHitRate(cachedTokens, promptTokens),'), 'WEB-TOTALS'],
    ['the offline silence pin is deleted',
      mutate(real, TEST_PY, 'def test_a_provider_that_omits_the_detail_is_not_a_miss(',
             'def test_silence_erased_replaced('), 'TEST-PY'],
    ['the web measurement pin is deleted',
      mutate(real, TEST_TS, "describe('cache coverage — silence is not a miss (D1052)'",
             "describe('cache coverage erased'"), 'TEST-TS'],
    ['the direct-wire probe loses its transport opt-out',
      mutate(real, D980_TEST, 'def _direct_json_transport(monkeypatch):',
             'def _transport_erased_replaced(monkeypatch):'), 'TEST-D980'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1052_cache_reporting_truth_erased.mjs'), 'ATLAS-READER'],
    ['CI invocation cut',
      mutate(real, CI, CI_SELFTEST, 'node scripts/a_reader_that_does_not_exist.mjs --self-test'), 'CI-READER'],
    ['the ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];

  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(50)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const changed = [...arm.files.entries()].some(([k, v]) => real.get(k) !== v);
    const out = judge(arm.files, present);
    const rightCause = out.offenders.some((o) => o.includes(`[${expectTag}]`));
    const ok = changed && out.offenders.length > 0 && rightCause;
    console.log(`  self-test  ${label.padEnd(50)} ${ok ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!ok) {
      if (!changed) console.log('               no-op arm — the plant changed nothing (D954)');
      else if (!rightCause) console.log(`               red for the wrong cause: ${out.offenders[0]}`);
      allReddened = false;
    }
  }
  {
    const p = new Map(real);
    p.set(CONTROLLER, (p.get(CONTROLLER) ?? '').replace(
      'out.put("as_of", Instant.now().toString());',
      'out.put("as_of",  Instant.now().toString());'));
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN               ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!ok) allReddened = false;
  }
  console.log(`  self-test  all arms redden for cause + control green: ${allReddened} (${arms.length} arms)`);
  process.exit(allReddened ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE D1052 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1052 cache reporting truth wired, ${result.notes.length} holds`);
process.exit(0);
