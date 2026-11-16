#!/usr/bin/env node
/**
 * NEXUS D1276 — the Simplified-Chinese arms are a ONE-WAY fold of the Traditional arms.
 *
 * `apps/web/src/lib/i18n/dict-cn.ts` and `apps/web/src/lib/i18n/trust-labels-cn.ts` are generated from
 * `zhHK` (dict.ts) and `zhLabels` (trust-labels.ts) by an opencc hk2s+t2s pass — never hand-edited. A zh-HK
 * copy change that does not re-run the fold ships a stale Simplified dictionary: the three-arm parity test
 * would still pass (structure is unaffected), and the census would still pass (it trusts declared-Simplified
 * carriers by name) — the drift ONLY this reader catches.
 *
 * The fold lives in `scripts/gen-simplified-arms.py`; this reader is its verify_all-facing wrapper. It refuses
 * to answer when the fold itself cannot run: a machine without opencc cannot have regenerated, so it cannot
 * accuse the committed arms of drift — `UNCHECKED` is its own answer (D96), and a green this plane did not
 * earn is not a pass.
 *
 * Usage: node scripts/check_simplified_mirror.mjs
 * Exit: 0 both arms are exactly the fold of today's zh-HK sources · 1 drift (regenerate:
 *       `python scripts/gen-simplified-arms.py`) · 2 not checkable (python or opencc missing).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARG = ['scripts/gen-simplified-arms.py', '--check'];

const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];

let lastResult = null;
let ran = false;
for (const cmd of candidates) {
  const res = spawnSync(cmd, ARG, { cwd: ROOT, encoding: 'utf8', shell: false, timeout: 120_000, windowsHide: true });
  if (res.error?.code === 'ENOENT') continue;
  ran = true;
  lastResult = res;
  break;
}

console.log('NEXUS — the Simplified-Chinese arms answer to the Traditional arms');

if (!ran) {
  console.log('RESULT: NOT CHECKED — no python interpreter on this plane; this is not a pass');
  console.log('  fix: install python3 (the fold lives in scripts/gen-simplified-arms.py)');
  process.exit(2);
}

const out = (lastResult.stdout ?? '').trim();
const err = (lastResult.stderr ?? '').trim();
if (out) console.log(out);
if (err) console.log(err);

if (lastResult.status === 0) {
  console.log('RESULT: PASS — dict-cn.ts and trust-labels-cn.ts are exactly the opencc fold of zh-HK');
  process.exit(0);
}
if (lastResult.status === 1) {
  console.log('RESULT: FAIL — a zh-HK arm moved and the Simplified arm did not: regenerate with `python scripts/gen-simplified-arms.py`');
  process.exit(1);
}
if (lastResult.status === 2) {
  console.log('RESULT: NOT CHECKED — opencc-python-reimplemented is missing; a plane that cannot fold cannot accuse anyone (D96)');
  process.exit(2);
}
console.log(`RESULT: ERROR — the fold exited ${String(lastResult.status)}; not a verdict either way`);
process.exit(2);
