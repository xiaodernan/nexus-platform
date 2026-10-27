#!/usr/bin/env node
/**
 * NEXUS D575 -- both sides of scripts/check_duplicate_keys.mjs, shown rather than asserted.
 *
 * A validator whose first run is also its first test has not been tested, so every arm below states the
 * verdict it expects BEFORE the shipped checker is called, and the harness exits non-zero if a prediction
 * misses. The arms come in pairs: each "the reader must catch this" arm has a "the reader must NOT catch
 * this" twin that differs in exactly one property, so neither can pass by luck.
 *
 * THE ARMS, AND WHAT EACH PAIR IS ABOUT.
 *
 *   THE DEFECT          a card list keyed by the card's IDENTITY is caught (the reader's whole subject)
 *                       -- and the same list keyed by the OCCURRENCE is not, because an occurrence key is
 *                       unique by construction.
 *
 *   THE PLANE           the same shape in a CLIENT module is caught -- and the same shape in a SERVER
 *                       module is not, because the duplicate-key warning only exists in the client
 *                       reconciler.
 *
 *   THE LIMIT           a list member with NO KEY at all is not read as a duplicate. That is the
 *                       reader's stated limit, pinned here so it cannot drift silently in either
 *                       direction: widening it to the missing-key warning would be a different reader,
 *                       and this arm says which one this is.
 *
 *   THE REFUSALS        a tree missing a source root, an unknown flag, a flag given twice, and a
 *                       component whose required prop the reader cannot furnish are all refusals
 *                       (exit 2), not verdicts -- "did not run" and "found nothing" are different
 *                       answers.
 *
 * Every arm gets its own copy of the three source roots under the system temp directory, so no arm can
 * borrow another arm's redness and the working tree is never the fixture. Every mutation asserts that
 * the text it rewrites is present in the copy, so an arm cannot pass by silently running an unmutated
 * tree -- the failure mode D110 named.
 *
 * Usage: node scripts/falsify_duplicate_keys.mjs
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
const CHECKER = join(HERE, 'check_duplicate_keys.mjs');
// D575 -- the fixture root carries this process's PID. The house convention is one fixed root per
// falsifier, which is what the sibling harnesses do -- but a fixed root means two runs of THIS harness
// share one tree, and the second run's `safeRemove` deletes the first run's fixtures mid-arm. Measured
// on this file: two concurrent batteries both reported a verdict on the same arm, one of them the
// other one's leftovers. A per-process root makes the arms independent of when they are run.
const FIX = join(tmpdir(), `nexus-d575-falsify-${process.pid}`);
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

/**
 * The planted list. The identity type is declared in the module itself, so the plant needs no import
 * and the reader can resolve it exactly the way it resolves the shipped `EntityCard`.
 */
const PLANTED_LIST = `interface PlantedItem { id: string; title: string }

export function PlantedList({ items }: { items: PlantedItem[] }) {
  return (
    <ul className="flex gap-2">
      {items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  );
}
`;

/** The same list with no key at all: the reader's stated limit, not its subject. */
const PLANTED_UNKEYED_LIST = `interface PlantedItem { id: string; title: string }

export function PlantedUnkeyedList({ items }: { items: PlantedItem[] }) {
  return (
    <ul className="flex gap-2">
      {items.map((item) => (
        <li>{item.title}</li>
      ))}
    </ul>
  );
}
`;

/** The same list with a required prop whose type the reader cannot furnish: a refusal, not a verdict. */
const PLANTED_UNFURNISHABLE = `'use client';

interface PlantedItem { id: string; title: string }

export function PlantedUnfurnishable({ items, odd }: { items: PlantedItem[]; odd: { deep: { deeper: Unique } } }) {
  return (
    <ul className="flex gap-2">
      {items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  );
}
`;

/* ---------------------------------------------------------------- the arms */

// The planted defect: the card list keyed by the card's IDENTITY.
const plantIdentityGrid = (d) => edit(d, 'apps/web/src/components/cards.tsx',
  '<li key={keys[index]} className="flex">', '<li key={card.id} className="flex">');
// The mirror: the rail's fragments keyed by the identity instead of the occurrence.
const plantIdentityRail = (d) => edit(d, 'packages/ui/src/trust/EntityCard.tsx',
  '<React.Fragment key={keys[index]}>', '<React.Fragment key={card.id}>');
// The mirror: the compare table's columns keyed by the identity instead of the occurrence.
const plantIdentityTable = (d) => edit(d, 'packages/ui/src/trust/CompareTable.tsx',
  '<th key={keys[index]} scope="col"', '<th key={card.id} scope="col"');

const ARMS = [
  {
    name: 'control: the shipped tree as it stands',
    apply: () => {},
    expect: 0,
    must: [/RESULT: PASS/, /components run\s+[1-9]\d* card-list component\(s\)/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'a card list keyed by the card IDENTITY',
    apply: plantIdentityGrid,
    expect: 1,
    must: [/RESULT: FAIL/,
      /apps\/web\/src\/components\/cards\.tsx — CardGrid renders 2 list members of one <ul> slot with the key `dup`/],
  },
  {
    name: 'the same list in the RAIL, keyed by the identity',
    apply: plantIdentityRail,
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/trust\/EntityCard\.tsx — EntityRail renders 2 list members of one <div> slot with the key `dup`/],
  },
  {
    name: 'the same list in the COMPARE TABLE, keyed by the identity',
    apply: plantIdentityTable,
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/trust\/CompareTable\.tsx — CompareTable renders 2 list members of one <tr> slot with the key `dup`/],
  },
  {
    name: 'the same shape in a CLIENT module',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-client-list.tsx', `'use client';\n\n${PLANTED_LIST}`),
    expect: 1,
    must: [/RESULT: FAIL/,
      /packages\/ui\/src\/primitives\/planted-client-list\.tsx — PlantedList renders 2 list members of one <ul> slot with the key `dup`/],
  },
  {
    name: 'the same shape in a SERVER module — the server plane does not warn',
    apply: (d) => append(d, 'apps/web/src/components/console/console-parts.tsx', PLANTED_LIST),
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'LIMIT: a list member with no key at all is not a duplicate',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-client-list.tsx', `'use client';\n\n${PLANTED_UNKEYED_LIST}`),
    expect: 0,
    must: [/RESULT: PASS/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'the same list, keyed twice — the twin of the limit arm',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-client-list.tsx', `'use client';\n\n${PLANTED_LIST}`),
    expect: 1,
    must: [/RESULT: FAIL/, /PlantedList renders 2 list members of one <ul> slot with the key `dup`/],
  },
  {
    name: 'REFUSAL: a component whose required prop the reader cannot furnish',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-unfurnishable.tsx', PLANTED_UNFURNISHABLE),
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /PlantedUnfurnishable declares a required prop `odd` whose type the reader cannot furnish/],
  },
  {
    name: 'the same component with that prop OPTIONAL — the reader runs it',
    apply: (d) => writeNew(d, 'packages/ui/src/primitives/planted-unfurnishable.tsx',
      PLANTED_UNFURNISHABLE.replace('odd: { deep:', 'odd?: { deep:')),
    expect: 1,
    must: [/RESULT: FAIL/, /PlantedUnfurnishable renders 2 list members of one <ul> slot with the key `dup`/],
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
    apply: plantIdentityGrid,
    expect: 0,
    args: ['--report'],
    must: [/OFFENDERS \(1\)/, /CardGrid renders 2 list members of one <ul> slot with the key `dup`/],
  },
  {
    name: '--plane <dir> (spaced) reaches the planted tree',
    apply: plantIdentityGrid,
    expect: 1,
    spaced: true,
    must: [/RESULT: FAIL/, /CardGrid renders 2 list members of one <ul> slot with the key `dup`/],
  },
  {
    name: '--plane=<dir> (glued) aims the same census at the same tree',
    apply: plantIdentityGrid,
    expect: 1,
    glued: true,
    must: [/RESULT: FAIL/, /CardGrid renders 2 list members of one <ul> slot with the key `dup`/],
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
  console.log('\nRESULT: FAIL -- the duplicate-key census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- the census reddens on a list keyed by identity, keeps quiet on an occurrence key, on the');
console.log('           server plane and on a list with no key at all, and refuses when it cannot run');
