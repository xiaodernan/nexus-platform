#!/usr/bin/env node
/**
 * NEXUS D1127 arms — the console-plane script census, measured against itself.
 * Usage: node scripts/falsify_console_script.mjs
 * Exit:  0 every arm held; 1 an arm missed; 2 no arm ran (a copied path is missing).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSpawnFailure, safeRemove, spawnReason } from './spawn_guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_console_script.mjs');
const FIX = join(tmpdir(), 'nexus-console-script-falsify');

const TABLES = ['apps/ai/nexus_ai/nlu/canonical.py', 'apps/ai/nexus_ai/nlu/lexicon.py'];
const LIB = 'apps/web/src/lib';
const ROOTS = [...TABLES, LIB];

const missing = ROOTS.filter((r) => !existsSync(join(ROOT, r)));
if (missing.length) {
  console.log(`RESULT: NOT CHECKED — ${missing.length} of ${ROOTS.length} path(s) absent: ${missing.join(', ')}. No arm was run.`);
  process.exit(2);
}

safeRemove(FIX);
mkdirSync(FIX, { recursive: true });

function copyTree(src, dest) {
  if (statSync(src).isFile()) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); return; }
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const a = join(src, e.name);
    const b = join(dest, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else copyFileSync(a, b);
  }
}

function fixture(slug, roots = ROOTS) {
  const dir = join(FIX, slug.replace(/[^\w]+/g, '_').slice(0, 44));
  for (const r of roots) copyTree(join(ROOT, r), join(dir, r));
  return dir;
}

const read = (dir, rel) => ({ abs: join(dir, rel), text: readFileSync(join(dir, rel), 'utf8') });

function append(dir, rel, ...lines) {
  const { abs, text } = read(dir, rel);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(abs, `${text.replace(/\s*$/, '')}${eol}${lines.join(eol)}${eol}`, 'utf8');
}

function writeFile(dir, rel, text) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function runArgv(extra = []) {
  try {
    return { out: execFileSync(process.execPath, [CHECKER, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 }), code: 0 };
  } catch (e) {
    if (isSpawnFailure(e)) {
      console.log(`RESULT: NOT CHECKED — the checker could not be started (${spawnReason(e)}).`);
      process.exit(2);
    }
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status === undefined ? -1 : e.status };
  }
}
const runChecker = (dir, extraArgs = []) => runArgv([`--plane=${dir}`, ...extraArgs]);
const BASE = runChecker(fixture('baseline')).out;
if (!/RESULT: PASS/.test(BASE)) {
  console.log(`RESULT: NOT CHECKED — the unmutated plane does not pass: ${BASE.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  process.exit(2);
}

const ARMS = [
  {
    name: 'control: the repaired console fixture plane as it stands',
    apply: () => {},
    expect: 0,
    must: [/RESULT: PASS — 0 simplified character\(s\) over the console fixture plane/],
  },
  {
    name: 'the defect: a Simplified character inside a fixture string literal',
    apply: (d) => append(d, 'apps/web/src/lib/console-fixtures.ts', "export const canary = '我有双层包装';"),
    expect: 1,
    must: [/RESULT: FAIL — 2 simplified character\(s\) in 1 literal\(s\)/, /console-fixtures\.ts:\d+/],
  },
  {
    name: 'the mirror: only the excluded 台 character added to a fixture literal',
    apply: (d) => append(d, 'apps/web/src/lib/console-fixtures.ts', "export const canary = '我有台案';"),
    expect: 0,
    must: [/RESULT: PASS/],
  },
  {
    name: 'prose vs copy: a comment carrying 双 is not charged',
    apply: (d) => append(d, 'apps/web/src/lib/console-fixtures.ts', '// 我有双层包装\n', 'const canary = 1;'),
    expect: 0,
    must: [/RESULT: PASS/],
  },
  {
    name: 'prose vs copy: the same two characters in a literal ARE charged',
    apply: (d) => append(d, 'apps/web/src/lib/console-fixtures.ts', "const canary = '我有双层包装';"),
    expect: 1,
    must: [/RESULT: FAIL/],
  },
  {
    name: 'population discipline: the defect in a .test.ts is not charged',
    apply: (d) => writeFile(d, 'apps/web/src/lib/console-canary.test.ts', "const fixture = { subject: '双层' };\nexport default fixture;\n"),
    expect: 0,
    must: [/RESULT: PASS/],
  },
  {
    name: 'population discipline: the defect in console-canary.ts IS charged',
    apply: (d) => writeFile(d, 'apps/web/src/lib/console-canary.ts', "export const fixture = '双层';\n"),
    expect: 1,
    must: [/RESULT: FAIL — 2 simplified character\(s\) in 1 literal\(s\)/, /console-canary\.ts:\d+/],
  },
  {
    name: 'THE REFUSAL: the pair-table file deleted entirely',
    apply: (d) => safeRemove(join(d, 'apps/ai/nexus_ai/nlu/lexicon.py')),
    expect: 2,
    must: [/lexicon\.py|no lexicon\.py/],
  },
  {
    name: 'an unknown flag — the reader refuses rather than guess the plane',
    apply: () => {},
    args: ['--banana'],
    expect: 2,
    must: [/unknown option|--banana/],
  },
];

const results = [];
for (const arm of ARMS) {
  const dir = fixture(arm.name);
  arm.apply(dir);
  const { out, code } = runChecker(dir, arm.args ?? []);
  const missed = (arm.must ?? []).filter((re) => !re.test(out));
  results.push({ arm, code, missed, ok: code === arm.expect && missed.length === 0, out });
}

let fails = 0;
for (const { arm, code, missed, ok, out } of results) {
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${arm.expect} expected, ${code} printed   ${arm.name}`);
  if (!ok) {
    fails += 1;
    const shown = () => out.split('\n').filter((l) => /RESULT|console|lexicon|flags/.test(l)).slice(0, 3).join(' | ');
    console.log(`        verdict differs -- the arm printed: ${shown()}`);
    for (const m of missed) console.log(`        expected text missing: ${m}   -- printed: ${shown()}`);
  }
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped reader as a subprocess on its own copy of the two AI');
console.log('           pair tables and the fixture tree; every arm asserts on a plant the reader itself knows.');
if (fails) {
  console.log('\nRESULT: FAIL -- the console script census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- every arm held');
process.exit(0);
