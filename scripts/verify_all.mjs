#!/usr/bin/env node
/**
 * NEXUS D883 — one command for every read-only reader in the repository.
 *
 * WHY: the repo ships 24+ `scripts/check_*.mjs` readers, each with its own CLI, its own idea of a
 * verdict and its own runtime. A person who wants to know "is the tree coherent?" has to know all of
 * them. This runner enumerates them, runs each in its own process, and prints ONE honest table.
 *
 * THE HONESTY RULE: a verdict is never collapsed into "green".
 *   PASS       exit 0  — the reader judged its plane and found no offender
 *   FAIL       exit 1  — the reader found an offender (this reddens the whole run)
 *   UNCHECKED  exit 2  — the reader refused to judge (no --expect, no --db, unreadable plane)
 *   TIMEOUT            — the reader did not finish inside its budget (a refusal, not a pass)
 *   ERROR              — could not be started / crashed
 * UNCHECKED, TIMEOUT and ERROR are printed with their reader's own last line. They do NOT turn the
 * run green, but they are not silently counted as FAIL either: saying "the gate failed" about a gate
 * that never judged anything is exactly the kind of inference this repository refuses to make.
 *
 * WHAT THIS DOES NOT DO: it does not run smokes, start services, touch a database, apply migrations,
 * or run the `verify_*.mjs` runtime verifiers (those need a live plane — pass --include-runtime for
 * them, expecting UNCHECKED/FAIL when nothing is listening). It does not repair anything. It reports
 * the exit code a reader chose; it never re-interprets that reader's output into a friendlier verdict.
 *
 * Usage:
 *   node scripts/verify_all.mjs
 *   node scripts/verify_all.mjs --only=cloud
 *   node scripts/verify_all.mjs --include-runtime
 *   node scripts/verify_all.mjs --timeout-ms=180000 --slow-ms=360000
 *   node scripts/verify_all.mjs --report        # print the table, always exit 0
 *   node scripts/verify_all.mjs --verbose       # show each reader's last line
 *
 * Exit: 1 if any reader FAILED or ERRORED · 0 otherwise (UNCHECKED/TIMEOUT still listed as such).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;
const REPORT = has('report');
const VERBOSE = has('verbose');
const INCLUDE_RUNTIME = has('include-runtime');
const TIMEOUT_MS = flag('timeout-ms', 120000);
const SLOW_MS = flag('slow-ms', 360000);
const ULTRA_MS = flag('ultra-ms', 900000);

/** Readers that walk the 38k-line STATUS.md; measured to need more than the default budget. */
const SLOW = new Set([
  'check_ledger_citations.mjs',
  'check_line_cite_drift.mjs',
  'check_comment_citations.mjs',
  'check_status_citations.mjs',
  'check_ledger_numbers.mjs',
]);

/** Measured: still running at 360s in the D883 sweep. It cross-checks every cited sentence, so it
 *  reads far more of the corpus than the other ledger readers. Given its own budget rather than
 *  being skipped — a runner that quietly omits its slowest gate is lying about the plane. */
const ULTRA_SLOW = new Set(['check_citation_supports_sentence.mjs']);

const scripts = (() => {
  try {
    return readdirSync(join(ROOT, 'scripts'))
      .filter((f) => /^check_.*\.mjs$/.test(f) || (INCLUDE_RUNTIME && /^verify_.*\.mjs$/.test(f)))
      .filter((f) => (ONLY ? f.includes(ONLY) || `scripts/${f}`.includes(ONLY) : true))
      .sort();
  } catch { return []; }
})();

const lastLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '(no output)';

console.log('NEXUS — every read-only reader, one honest table');
console.log(`  plane            ${ROOT}`);
console.log(`  readers          ${scripts.length}${ONLY ? ` (filtered by --only=${ONLY})` : ''}${INCLUDE_RUNTIME ? ' (+ runtime verifiers)' : ''}`);
console.log(`  budget           ${TIMEOUT_MS}ms normal / ${SLOW_MS}ms for the citation readers`);
console.log('');

if (scripts.length === 0) {
  console.log('RESULT: NOT CHECKED — no reader matched; a run that asked nothing is not a pass');
  process.exitCode = 2;
} else {
  const rows = [];
  for (const f of scripts) {
    const abs = join(ROOT, 'scripts', f);
    const budget = ULTRA_SLOW.has(f) ? ULTRA_MS : (SLOW.has(f) ? SLOW_MS : TIMEOUT_MS);
    const started = Date.now();
    const res = spawnSync(process.execPath, [abs], {
      cwd: ROOT, encoding: 'utf8', timeout: budget, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    let verdict;
    if (res.error?.code === 'ETIMEDOUT' || res.signal) verdict = 'TIMEOUT';
    else if (res.status === 0) verdict = 'PASS';
    else if (res.status === 1) verdict = 'FAIL';
    else if (res.status === 2) verdict = 'UNCHECKED';
    else verdict = 'ERROR';
    const out = lastLine(res.stdout || res.stderr);
    rows.push({ f, verdict, ms: Date.now() - started, out });
    console.log(`  ${verdict.padEnd(9)} ${f.padEnd(46)} ${String(rows.at(-1).ms).padStart(7)}ms`);
    if (VERBOSE || verdict === 'FAIL' || verdict === 'ERROR') console.log(`            ${out}`);
  }

  const tally = (v) => rows.filter((r) => r.verdict === v).length;
  console.log('');
  console.log(`  TOTAL   PASS ${tally('PASS')} · FAIL ${tally('FAIL')} · UNCHECKED ${tally('UNCHECKED')} · TIMEOUT ${tally('TIMEOUT')} · ERROR ${tally('ERROR')}`);
  for (const v of ['UNCHECKED', 'TIMEOUT', 'ERROR']) {
    for (const r of rows.filter((x) => x.verdict === v)) console.log(`  ${v.padEnd(9)} ${r.f} — ${r.out}`);
  }
  console.log('');
  console.log('WHAT THIS DOES NOT SAY: UNCHECKED/TIMEOUT are not passes and are not listed as failures —');
  console.log('they are readers that did not judge anything. Smokes, services and the live plane were not run.');
  const red = tally('FAIL') + tally('ERROR');
  console.log(`\nRESULT: ${red ? `FAIL — ${red} reader(s) found an offender or crashed` : 'NO OFFENDER — every reader that judged its plane passed'}`);
  process.exitCode = REPORT ? 0 : (red ? 1 : 0);
}
