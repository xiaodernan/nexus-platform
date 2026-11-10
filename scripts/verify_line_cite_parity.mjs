#!/usr/bin/env node
/**
 * NEXUS D891 — the line-drift reader's two engines still agree, byte for byte.
 *
 * D890 replaced thousands of `git show` spawns with one prefetched batch, and kept
 * `--no-prefetch` so the old path stays runnable. The comparison was measured by hand in D890 and
 * again across the falsifier's 16 scratch arms, but a measurement nobody can repeat is not a gate.
 * This runner executes both engines over the SAME real ledger excerpt and diffs their stdout.
 *
 * It also falsifies its own comparator with one planted changed word, because a diff function that
 * cannot detect a difference proves nothing. Both engines must exit 0 and must actually judge the
 * plane: two NOT CHECKED refusals are not an agreement.
 *
 * WHAT THIS DOES NOT SAY: that the census is CORRECT (it is a report with strict=none), that the
 * full two-ledger sweep was diffed (only docs/DECISIONS.md is used, so the legacy path stays
 * affordable), or that a cold-cache CI host is as fast as this one. It says the two engines agree
 * HERE, byte for byte.
 *
 * Usage:  node scripts/verify_line_cite_parity.mjs [--verbose]
 * Exit:   0 identical and falsifiable · 1 drift or a failed comparator · 2 uncheckable.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READER = join(ROOT, 'scripts', 'check_line_cite_drift.mjs');
const LEDGER = 'docs/DECISIONS.md';
const VERBOSE = process.argv.includes('--verbose');

function compare(plain, prefetched) {
  if (plain.status !== 0 || prefetched.status !== 0) {
    return [`an engine did not exit 0 (no-prefetch=${plain.status}, prefetch=${prefetched.status})`];
  }
  const a = plain.stdout;
  const b = prefetched.stdout;
  if (a === b) return [];
  const al = a.split('\n');
  const bl = b.split('\n');
  const rows = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
    if (al[i] !== bl[i]) rows.push(`line ${i + 1}: no-prefetch ${JSON.stringify(al[i])} / prefetch ${JSON.stringify(bl[i])}`);
  }
  return rows;
}

function run(extra) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [READER, `--ledgers=${LEDGER}`, ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms: Date.now() - started };
}

const plain = run(['--no-prefetch']);
const prefetched = run([]);
const offenders = [];
if (plain.stdout.includes('NOT CHECKED') || prefetched.stdout.includes('NOT CHECKED')) {
  console.log('RESULT: NOT CHECKED — an engine refused to judge the ledger; two refusals are not an agreement');
  console.log(`  no-prefetch: ${plain.stdout.split('\n').filter(Boolean).pop() ?? '(no output)'}`);
  console.log(`  prefetch:    ${prefetched.stdout.split('\n').filter(Boolean).pop() ?? '(no output)'}`);
  process.exit(2);
}
const drift = compare(plain, prefetched);
if (drift.length) offenders.push(...drift.map((d) => `ENGINE DRIFT — ${d}`));

console.log('NEXUS — line-drift engine parity (D891)');
console.log(`  ledger          ${LEDGER}`);
console.log(`  no-prefetch     ${plain.ms}ms, exit ${plain.status}`);
console.log(`  prefetch        ${prefetched.ms}ms, exit ${prefetched.status}`);
if (prefetched.ms > 0 && plain.ms > 0) console.log(`  speedup         ${(plain.ms / prefetched.ms).toFixed(1)}x on the same input`);
console.log(`  stdout          ${plain.stdout.length} chars`);
console.log(`  drift           ${drift.length} differing line(s)`);
for (const d of drift.slice(0, 8)) console.log(`    - ${d}`);

const planted = { status: prefetched.status, stdout: prefetched.stdout.replace('EXACT ', 'EXACTLY ') };
const detected = compare(plain, planted).length > 0;
console.log(`  self-test       planted one changed word -> comparator reports: ${detected}`);
if (!detected) offenders.push('SELF-TEST — the comparator did not notice a planted stdout difference');
if (VERBOSE) {
  console.log('');
  console.log('  --- prefetch stdout (first 10 lines) ---');
  for (const l of prefetched.stdout.split('\n').slice(0, 10)) console.log(`  ${l}`);
}

if (offenders.length) {
  console.log(`\nRESULT: FAIL — ${offenders.length} offender(s)`);
  for (const o of offenders) console.log(`  - ${o}`);
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS — identical census, and the comparison can be falsified');
  process.exitCode = 0;
}
