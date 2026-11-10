#!/usr/bin/env node
/**
 * NEXUS D893 — the ledger citation reader's two blob engines still agree, byte for byte.
 *
 * `check_ledger_citations.mjs` used to ask `git show HEAD:<path>` once for every distinct cited
 * target on the COMMITTED plane. D893 prefetches those targets through the shared
 * `scripts/git_blobs.mjs` batch reader and keeps `--no-prefetch` as the old engine. This runner
 * executes both engines over the SAME full two-ledger plane and diffs their stdout.
 *
 * WHY THE FULL PLANE, NOT AN EXCERPT. With `--text=<ledger>` the reader deliberately skips its
 * committed-plane census (that mode exists for planted witnesses), so neither engine would ever
 * read a HEAD blob and the comparison would prove nothing. Only the default two-ledger run reaches
 * `fileText(rel, true)`. `--report` keeps both sides at exit 0 so an offender in the census cannot
 * be mistaken for an engine crash.
 *
 * It also falsifies its own comparator with one planted changed word. A diff that cannot detect a
 * difference proves nothing. Both sides must actually judge the plane: two NOT CHECKED refusals are
 * not an agreement.
 *
 * WHAT THIS DOES NOT SAY: that the census is CORRECT (it is a census with a stated backlog), that
 * a fixture plane with `--head-dir` was diffed, or that a cold-cache CI host shows the same speedup.
 *
 * Usage:  node scripts/verify_ledger_cite_parity.mjs [--verbose]
 * Exit:   0 identical and falsifiable · 1 drift or a failed comparator · 2 uncheckable.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READER = join(ROOT, 'scripts', 'check_ledger_citations.mjs');
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
  const res = spawnSync(process.execPath, [READER, ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms: Date.now() - started };
}

const plain = run(['--no-prefetch', '--report']);
const prefetched = run(['--report']);
const offenders = [];
if (plain.stdout.includes('NOT CHECKED') || prefetched.stdout.includes('NOT CHECKED')) {
  console.log('RESULT: NOT CHECKED — an engine refused to judge the plane; two refusals are not an agreement');
  console.log(`  no-prefetch: ${plain.stdout.split('\n').filter(Boolean).pop() ?? '(no output)'}`);
  console.log(`  prefetch:    ${prefetched.stdout.split('\n').filter(Boolean).pop() ?? '(no output)'}`);
  process.exit(2);
}
const drift = compare(plain, prefetched);
if (drift.length) offenders.push(...drift.map((d) => `ENGINE DRIFT — ${d}`));

console.log('NEXUS — ledger citation engine parity (D893)');
console.log('  plane           the full committed + working-copy two-ledger census');
console.log(`  no-prefetch     ${plain.ms}ms, exit ${plain.status}`);
console.log(`  prefetch        ${prefetched.ms}ms, exit ${prefetched.status}`);
if (prefetched.ms > 0 && plain.ms > 0) console.log(`  speedup         ${(plain.ms / prefetched.ms).toFixed(1)}x on the same input`);
console.log(`  stdout          ${plain.stdout.length} chars`);
console.log(`  drift           ${drift.length} differing line(s)`);
for (const d of drift.slice(0, 8)) console.log(`    - ${d}`);

const planted = { status: prefetched.status, stdout: prefetched.stdout.replace('NEXUS —', 'NEXUS X —') };
const detected = compare(plain, planted).length > 0;
console.log(`  self-test       planted one changed word -> comparator reports: ${detected}`);
if (!detected) offenders.push('SELF-TEST — the comparator did not notice a planted stdout difference');
if (VERBOSE) {
  console.log('');
  console.log('  --- prefetch stdout (first 8 lines) ---');
  for (const l of prefetched.stdout.split('\n').slice(0, 8)) console.log(`  ${l}`);
}

if (offenders.length) {
  console.log(`\nRESULT: FAIL — ${offenders.length} offender(s)`);
  for (const o of offenders) console.log(`  - ${o}`);
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS — identical census, and the comparison can be falsified');
  process.exitCode = 0;
}
