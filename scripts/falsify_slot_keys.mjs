#!/usr/bin/env node
/**
 * NEXUS D574 -- both sides of scripts/check_slot_keys.mjs, shown rather than asserted.
 *
 * A validator whose first run is also its first test has not been tested, so every arm below states the
 * verdict it expects BEFORE the shipped checker is called, and the harness exits non-zero if a prediction
 * misses. The arms come in pairs: each "the reader must catch this" arm has a "the reader must NOT catch
 * this" twin that differs in exactly one property, so neither can pass by luck.
 *
 * THE ARMS, AND WHAT EACH PAIR IS ABOUT.
 *
 *   THE DEFECT          a node-typed prop rendered bare in a multi-child slot is caught (the reader's
 *                       whole subject) -- and the same slot with the prop's DECLARED TYPE changed to a
 *                       non-node type is not, because what makes a prop node-typed is its type and not
 *                       its name.
 *
 *   THE PLANE           the same shape in a CLIENT module is caught -- and the same shape in a SERVER
 *                       module is not, because the server plane does not warn: there the element is a
 *                       plain element created in the same pass and the array-creation loop marks it
 *                       validated before the renderer walks the array.
 *
 *   THE CLOSURE         a module that is reachable ONLY through the barrel's `export * from` is caught --
 *                       and the same module, with the barrel's re-export deleted, is not. This is the
 *                       D195 defect in a new coat: a closure that reads only `import` declarations
 *                       misses the whole `@nexus/ui` package, and the reader under it would have
 *                       reported zero offenders over 53 modules instead of 56.
 *
 *   THE DISCOVERY       a module nobody has seen before, carrying the directive, is caught -- the plane
 *                       is read out of the source, not written down.
 *
 *   THE LIMITS          a conditional (`{content ? <b/> : null}`) is NOT read as a bare prop. That is
 *                       the reader's stated limit, pinned here so it cannot drift silently in either
 *                       direction: widening it to guesses would be a different reader, and this arm
 *                       says which one this is.
 *
 *   THE REFUSALS        a tree missing a source root, an unknown flag, and a flag given twice are all
 *                       refusals (exit 2), not verdicts -- "did not run" and "found nothing" are
 *                       different answers.
 *
 * Every arm gets its own copy of the three source roots under the system temp directory, so no arm can
 * borrow another arm's redness and the working tree is never the fixture. Every mutation asserts that the
 * text it rewrites is present in the copy, so an arm cannot pass by silently running an unmutated tree --
 * the failure mode D110 named.
 *
 * Usage: node scripts/falsify_slot_keys.mjs
 * Exit:  0 every prediction held; 1 an arm missed (the reader cannot do what its docblock says)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSpawnFailure, safeRemove, spawnReason } from './spawn_guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_slot_keys.mjs');
const FIX = join(tmpdir(), 'nexus-d574-falsify');
const ROOTS = ['apps/web/app', 'apps/web/src', 'packages/ui/src'];

/** Everything the census reads, and nothing else: no `node_modules`, no other lane's pages. */
const missing = ROOTS.filter((r) => !existsSync(join(ROOT, r)));
if (missing.length) {
  console.log(`RESULT: NOT CHECKED — ${missing.length} of ${ROOTS.length} source root(s) this harness copies are `
    + `absent: ${missing.join(', ')}. No arm was run.`);
  process.exit(2);
}

safeRemove(FIX);  // batched: a bulk `rmSync` of >50 files is refused by this host's delete shim
mkdirSync(FIX, { recursive: true });

/**
 * Copy a tree, file by file.
 *
 * `cpSync(src, dest, { recursive: true })` on a DIRECTORY kills this Node process silently with exit 127 on
 * this host -- no output, no stack -- while copying a single FILE works. Measured and recorded in
 * `scripts/spawn_guard.mjs`: the harness that "did nothing" was this. So the copy is done by hand, which
 * takes the same 125 files in well under a second.
 */
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

/** One fixture plane per arm: a copy of the roots the census reads, under the system temp directory. */
function fixture(slug, roots = ROOTS) {
  const dir = join(FIX, slug.replace(/[^\w]+/g, '_').slice(0, 40));
  for (const r of roots) copyTree(join(ROOT, r), join(dir, r));
  return dir;
}

/** Rewrite one occurrence of `from` in the fixture's copy of `p`; refuse when the text is not there. */
function edit(dir, p, from, to) {
  const abs = join(dir, p);
  const before = readFileSync(abs, 'utf8');
  if (!before.includes(from)) {
    throw new Error(`${p} does not hold the text this arm rewrites: ${JSON.stringify(from.slice(0, 70))}`);
  }
  writeFileSync(abs, before.replace(from, () => to), 'utf8');
}

/** Add a component to the end of a file in the fixture; refuse when the file is not there. */
function append(dir, p, text) {
  const abs = join(dir, p);
  if (!existsSync(abs)) throw new Error(`${p} is not in this fixture, so this arm cannot plant into it`);
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n${text}`, 'utf8');
}

/** Add a module that does not exist yet; refuse when it does. */
function writeNew(dir, p, text) {
  const abs = join(dir, p);
  if (existsSync(abs)) throw new Error(`${p} already exists in this fixture, so this arm would not be planting a new module`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** The planted shapes. The client one carries the directive; the server one is appended to a server module. */
const PLANTED_CLIENT = `'use client';

import * as React from 'react';

export function PlantedClientSlot({ content }: { content?: React.ReactNode }) {
  return (
    <span className="flex gap-2">
      <b>planted</b>
      {content}
    </span>
  );
}
`;

const PLANTED_SERVER = `export function PlantedServerSlot({ content }: { content?: ReactNode }) {
  return (
    <span className="flex gap-2">
      <b>planted</b>
      {content}
    </span>
  );
}
`;

/* ---------------------------------------------------------------- the arms */

// The planted defect: a node-typed prop rendered bare in a two-child slot.
const plantBare = (d) => edit(d, 'packages/ui/src/primitives/Badge.tsx',
  '<React.Fragment key="badge-content">{children}</React.Fragment>', '{children}');
// The mirror: the same slot, with the prop's declared type changed to a non-node type.
const plantTypedString = (d) => {
  edit(d, 'packages/ui/src/trust/EntityCard.tsx', '  action?: React.ReactNode;', '  action?: string;');
  edit(d, 'packages/ui/src/trust/EntityCard.tsx',
    '<React.Fragment key="rail-action">{action}</React.Fragment>', '{action}');
};
const plantBareAction = (d) => edit(d, 'packages/ui/src/trust/EntityCard.tsx',
  '<React.Fragment key="rail-action">{action}</React.Fragment>', '{action}');
// The barrel is the ONLY thing that puts Layout.tsx in the client plane.
const plantBareSection = (d) => edit(d, 'packages/ui/src/primitives/Layout.tsx',
  '<React.Fragment key="section-content">{children}</React.Fragment>', '{children}');
const dropBarrelLayout = (d) => edit(d, 'packages/ui/src/index.ts',
  "export * from './primitives/Layout';\n", '');

const ARMS = [
  {
    name: 'control: the shipped tree as it stands',
    apply: () => {},
    expect: 0,
    must: [/RESULT: PASS/, /node-typed props\s+0 prop\(s\) read in a multi-child slot/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'a node-typed prop rendered bare in a multi-child slot',
    apply: plantBare,
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/primitives\/Badge\.tsx:\d+ — Badge renders `children` as a bare member of a 2-child <span> slot/],
  },
  {
    name: 'the same slot, with the prop\'s declared type changed to a non-node type',
    apply: plantTypedString,
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'the mirror of that pair: the node-typed prop, bare',
    apply: plantBareAction,
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/trust\/EntityCard\.tsx:\d+ — EntityRail renders `action` as a bare member of a 2-child <header> slot/],
  },
  {
    name: 'the same shape in a CLIENT module',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-slot.tsx', PLANTED_CLIENT),
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/primitives\/planted-slot\.tsx:\d+ — PlantedClientSlot renders `content` as a bare member of a 2-child <span> slot/],
  },
  {
    name: 'the same shape in a SERVER module — the server plane does not warn',
    apply: (d) => append(d, 'apps/web/src/components/console/console-parts.tsx', PLANTED_SERVER),
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'a module reachable only through the barrel\'s `export * from`',
    apply: plantBareSection,
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/primitives\/Layout\.tsx:\d+ — Section renders `children` as a bare member of a 2-child <section> slot/],
  },
  {
    name: 'the same module with the barrel\'s re-export deleted — it leaves the client plane',
    apply: (d) => { plantBareSection(d); dropBarrelLayout(d); },
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'LIMIT: a conditional is not read as a bare prop',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-slot.tsx',
      PLANTED_CLIENT.replace('{content}', '{content ? <b>yes</b> : null}')),
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'REFUSAL: a tree missing one of the three source roots',
    apply: () => {},
    expect: 2,
    roots: ['apps/web/app'],
    must: [/RESULT: NOT CHECKED/, /source root\(s\) this census reads are absent/],
  },
  {
    name: 'REFUSAL: an unknown flag',
    apply: () => {},
    expect: 2,
    args: ['--nope=1'],
    must: [/RESULT: NOT CHECKED/, /unknown option --nope/],
  },
  {
    name: 'REFUSAL: --plane given twice — which tree is the run',
    apply: () => {},
    expect: 2,
    args: ['--plane=a', '--plane=b'],
    noPlane: true,
    must: [/RESULT: NOT CHECKED/, /--plane was given 2 times/],
  },
  {
    name: '--report over a red plant still prints the offender and exits 0',
    apply: plantBare,
    expect: 0,
    args: ['--report'],
    must: [/OFFENDERS \(1\)/, /Badge renders `children` as a bare member/],
  },
  {
    name: '--plane <dir> (spaced) reaches the planted tree',
    apply: plantBare,
    expect: 1,
    spaced: true,
    must: [/RESULT: FAIL/, /Badge renders `children` as a bare member/],
  },
  {
    name: '--plane=<dir> (glued) aims the same census at the same tree',
    apply: plantBare,
    expect: 1,
    glued: true,
    must: [/RESULT: FAIL/, /Badge renders `children` as a bare member/],
  },
];

const results = [];
for (const arm of ARMS) {
  const dir = fixture(arm.name, arm.roots);
  arm.apply(dir);
  const argv = arm.args ? [...arm.args] : [];
  if (!arm.noPlane) {
    if (arm.spaced) argv.push('--plane', dir);
    else argv.push(`--plane=${dir}`);
  }
  let out;
  let code;
  try {
    out = execFileSync('node', [CHECKER, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26,
    });
    code = 0;
  } catch (e) {
    if (isSpawnFailure(e)) {
      console.log(`RESULT: NOT CHECKED — the checker could not be started (${spawnReason(e)}).`);
      process.exit(2);
    }
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = (arm.must ?? []).filter((re) => !re.test(out));
  const printed = (arm.absent ?? []).filter((re) => re.test(out));
  results.push({ arm, code, missed, printed, out });
}

let fails = 0;
for (const r of results) {
  const ok = r.code === r.arm.expect && r.missed.length === 0 && r.printed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  if (r.code !== r.arm.expect) {
    console.log(`        verdict differs -- the arm printed: ${r.out.split('\n').filter((l) => /RESULT|OFFENDERS|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
  for (const m of r.missed) {
    console.log(`        expected text missing: ${m}   -- printed: ${r.out.split('\n').filter((l) => /RESULT|OFFENDERS|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
  for (const m of r.printed) {
    console.log(`        text printed that must not be: ${m}   -- printed: ${r.out.split('\n').filter((l) => /RESULT|OFFENDERS|^  - /.test(l)).slice(0, 3).join(' | ')}`);
  }
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped checker as a subprocess on its own copy of the three');
console.log('           source roots, so no arm can redden another; each mutation refuses if the text it');
console.log('           rewrites is absent, so no arm can pass by running an unmutated tree.');
if (fails) {
  console.log('\nRESULT: FAIL -- the slot-key census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- the census reddens on a bare node-typed prop, keeps quiet on a non-node type, on the');
console.log('           server plane and on a conditional, follows the barrel\'s re-exports, and refuses when it cannot see');
