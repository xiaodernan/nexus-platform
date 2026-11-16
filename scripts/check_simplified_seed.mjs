#!/usr/bin/env node
/**
 * NEXUS D1278 — the simplified corpus arm is a one-way fold of the canonical fixture.
 *
 * `apps/web/src/lib/mock/seed-cn.ts` is generated from `../seed.ts`'s DEMO_GUIDES / DEMO_COLLECTIONS
 * by an opencc hk2s+t2s pass (`scripts/gen-simplified-seed.py`). A Traditional fixture edit that
 * does not re-run the fold silently ships stale zh-CN chapter copy — the parity pins in
 * `apps/web/src/lib/simplified-seed.test.ts` and the fold idempotency check catch most of it,
 * but this reader is the standing gate in every sweep, the same shape as `check_simplified_mirror.mjs`.
 *
 *   exit 0 → lockstep · 1 → drift (regenerate with `python scripts/gen-simplified-seed.py`) ·
 *   2 → not checkable (no python/opencc — a plane that cannot fold cannot accuse anyone, D96)
 *
 * Usage: node scripts/check_simplified_seed.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARG = ['scripts/gen-simplified-seed.py', '--check'];

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

console.log('NEXUS — the simplified corpus arm answers to the Traditional fixture');

if (!ran) {
  console.log('RESULT: NOT CHECKED — no python interpreter on this plane; this is not a pass');
  console.log('  fix: install python3 (the fold lives in scripts/gen-simplified-seed.py)');
  process.exit(2);
}

const out = (lastResult.stdout ?? '').trim();
const err = (lastResult.stderr ?? '').trim();
if (out) console.log(out);
if (err) console.log(err);

if (lastResult.status === 0) {
  console.log('RESULT: PASS — seed-cn.ts is exactly the opencc fold of the mock seed fixture');
  process.exit(0);
}
if (lastResult.status === 1) {
  console.log('RESULT: FAIL — the corpus moved Traditional and the arm did not: regenerate with `python scripts/gen-simplified-seed.py`');
  process.exit(1);
}
if (lastResult.status === 2) {
  console.log('RESULT: NOT CHECKED — opencc-python-reimplemented is missing; a plane that cannot fold cannot accuse anyone (D96)');
  process.exit(2);
}
console.log(`RESULT: ERROR — the fold exited ${String(lastResult.status)}; not a verdict either way`);
process.exit(2);
