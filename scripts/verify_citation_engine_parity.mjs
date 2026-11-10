#!/usr/bin/env node
/**
 * NEXUS D888 — prove that the fast blob engine did not change the census.
 *
 * The performance pass replaced 1316 `git show HEAD:<path>` spawns with one `git ls-tree` and one
 * `git cat-file --batch`. A faster reader that reports a DIFFERENT census is not an optimisation,
 * it is a regression with a nicer stopwatch. This runner executes both engines against the same
 * real ledger excerpt and diffs their stdout byte for byte; it also falsifies its own comparison
 * function, because a diff that cannot detect a planted difference proves nothing.
 *
 * The excerpt is taken from `docs/DECISIONS.md` (real citations, including bare basenames and
 * paths not at HEAD) but is deliberately small: the legacy engine costs ~440ms PER citation on
 * this host, so a parity check nobody can afford to run is not a gate.
 *
 * Usage:  node scripts/verify_citation_engine_parity.mjs [--lines N] [--verbose]
 * Exit:   0 the engines agree and the comparator is falsifiable · 1 an offender · 2 uncheckable.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READER = join(ROOT, 'scripts', 'check_citation_supports_sentence.mjs');
const lineArg = process.argv.find((a) => a.startsWith('--lines='));
// 3600 is the first stretch of DECISIONS.md with a real citation population (23 citations;
// the first 260 lines contain none). Small enough that the 440ms-per-spawn legacy engine
// finishes in seconds, large enough that bare basenames and unresolved paths both occur.
const LINES = Number(lineArg ? lineArg.split('=')[1] : 3600);
const VERBOSE = process.argv.includes('--verbose');
const offenders = [];

if (!Number.isFinite(LINES) || LINES < 40 || LINES > 20000) {
  console.log('RESULT: NOT CHECKED — --lines must be between 40 and 20000');
  process.exit(2);
}

const source = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8')
  .replace(/\r\n/g, '\n').split('\n').slice(0, LINES).join('\n');
const dir = mkdtempSync(join(tmpdir(), 'nexus-cite-parity-'));
const ledger = join(dir, 'excerpt.md');
writeFileSync(ledger, source, 'utf8');
if (!isAbsolute(ledger)) throw new Error('the parity ledger must be absolute for the reader');

/** The comparison under test. Isolated so the falsifier exercises the same function. */
function compare(legacy, batch) {
  if (legacy.status !== 0 || batch.status !== 0) {
    return [`an engine did not exit 0 (legacy=${legacy.status}, batch=${batch.status})`];
  }
  const a = legacy.stdout;
  const b = batch.stdout;
  if (a === b) return [];
  const al = a.split('\n');
  const bl = b.split('\n');
  const rows = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
    if (al[i] !== bl[i]) rows.push(`line ${i + 1}: legacy ${JSON.stringify(al[i])} / batch ${JSON.stringify(bl[i])}`);
  }
  return rows;
}

function run(engine) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [READER, `--engine=${engine}`, `--ledger=${ledger}`, '--limit=6'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms: Date.now() - started };
}

const legacy = run('legacy');
const batch = run('batch');
// A NOT CHECKED on BOTH sides is an empty population, not an agreement. Two readers that never
// looked at a citation cannot certify each other; the honest verdict is exit 2.
if (legacy.stdout.includes('NOT CHECKED') && batch.stdout.includes('NOT CHECKED')) {
  console.log('RESULT: NOT CHECKED — the excerpt contains no citation for either engine to judge');
  console.log('  raise --lines; the first citation in docs/DECISIONS.md is at line 1076');
  process.exit(2);
}
const drift = compare(legacy, batch);
if (drift.length) offenders.push(...drift.map((d) => `ENGINE DRIFT — ${d}`));

console.log('NEXUS — citation census engine parity (D888)');
console.log(`  ledger          docs/DECISIONS.md, first ${LINES} lines (${source.split('\n').length} lines)`);
console.log(`  legacy engine   ${legacy.ms}ms, exit ${legacy.status}`);
console.log(`  batch engine    ${batch.ms}ms, exit ${batch.status}`);
if (batch.ms > 0 && legacy.ms > 0) console.log(`  speedup         ${(legacy.ms / batch.ms).toFixed(1)}x on the same input`);
console.log(`  stdout          ${legacy.stdout.split('\n').length} lines, ${legacy.stdout.length} chars`);
console.log(`  drift           ${drift.length} differing line(s)`);
for (const d of drift.slice(0, 8)) console.log(`    - ${d}`);

/* A falsifier the gate must pass: the SAME comparator, fed a deliberately corrupted batch copy. */
const planted = { status: batch.status, stdout: batch.stdout.replace('sharing nothing', 'sharing SOMETHING') };
const detected = compare(legacy, planted).length > 0;
console.log(`  self-test       planted one changed word -> comparator reports: ${detected}`);
if (!detected) offenders.push('SELF-TEST — the comparator did not notice a planted stdout difference');
if (VERBOSE) {
  console.log('');
  console.log('  --- legacy stdout (first 12 lines) ---');
  for (const l of legacy.stdout.split('\n').slice(0, 12)) console.log(`  ${l}`);
}

if (offenders.length) {
  console.log(`\nRESULT: FAIL — ${offenders.length} offender(s)`);
  for (const o of offenders) console.log(`  - ${o}`);
  process.exitCode = 1;
} else {
  console.log('\nWHAT THIS DOES NOT SAY: that the census is CORRECT (it is a census, not a verdict),');
  console.log('  that every possible flag combination was diffed, or that the full 38k-line ledger');
  console.log('  was run through the legacy engine. It says the two engines agree HERE, byte for byte.');
  console.log('\nRESULT: PASS — identical census, and the comparison can be falsified');
  process.exitCode = 0;
}
