#!/usr/bin/env node
/**
 * NEXUS D117 — show that check_status_citations.mjs can fail, for each of the reasons it claims to exist,
 * and that the mention/citation split is a witnessed rule rather than an assumption.
 *
 * Every arm runs the SHIPPED checker as a subprocess against its own fixture directory, so no arm can
 * redden another and none of them touches this tree. The fixture dirs contain only the files an arm needs,
 * so the printed counts are that arm's own numbers rather than the repository's.
 *
 * Usage: node scripts/falsify_status_citations.mjs
 * Exit: 0 every arm held · 1 at least one did not.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_status_citations.mjs');
const FIX = join(tmpdir(), 'nexus-d117-falsify');
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

/** A fixture tree with the given relative files; returns its root. */
const tree = (name, files) => {
  const dir = join(FIX, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return dir;
};

const CTRL = 'package com.nexus.catalog;\n// see STATUS §%s for the report\npublic class Ctrl {}\n';

// D199: the exclusion this reader shares with steps 7, 8 and 9 is the only thing that keeps a citation in
// generated build output out of its plane, so the arm needs both halves — the shipped reader declining to read
// it, and a reader that answers the directory question for itself charging it. The mutant is the shipped bytes
// with ONE substitution: the shared import becomes the private nine-name list this file carried until D199. It
// is written under `.scratch/`, which no census walks (D197) and which holds no tracked file, because the reader
// resolves its own repository from the script's location and `git show HEAD:docs/STATUS.md` has to keep working.
const MUTANT_DIR = join(ROOT, '.scratch');
const MUTANT = join(MUTANT_DIR, 'd199_private_list_reader.mjs');
const privateListReader = () => {
  const src = readFileSync(CHECKER, 'utf8');
  const swaps = [
    ["import { VENDOR_DIRS } from './source_index.mjs';",
      "const VENDOR_DIRS = new Set(['node_modules', 'target', '.next', 'dist', 'out', 'build', '.venv', '__pycache__', '.mvn']);"],
    ["from './cli_args.mjs'", `from '${pathToFileURL(join(HERE, 'cli_args.mjs')).href}'`],
  ];
  let out = src;
  for (const [from, to] of swaps) {
    const hits = out.split(from).length - 1;
    if (hits !== 1) throw new Error(`mutant swap expected exactly 1 site, got ${hits}: ${from}`);
    out = out.replace(from, to);
  }
  mkdirSync(MUTANT_DIR, { recursive: true });
  writeFileSync(MUTANT, out, 'utf8');
  return MUTANT;
};
privateListReader();
const EXC_PLANT = tree('excluded', {
  'data/seed/out_smoke/Plant.java': CTRL.replace('%s', '99999'),
  'services/catalog/Ctrl.java': CTRL.replace('%s', '121'),
});
const ARMS = [
  // The control arm deliberately does not pin this tree's token counts. The census includes the harness
  // that runs it — writing a line that mentions `STATUS §NN` in a script adds a mention to the very
  // count an arm would assert — so a pinned count here would be a date, not a constant (D116 found that
  // the same way, one unit ago). What it pins is the two sites §149 repointed. Until §149 this arm
  // asserted they were BAD and said so in this comment: "this arm goes green only when the platform lane
  // fixes them, which is #79 closing." The first half of #79 has now closed, so the claim flipped with
  // it — an `ok` line naming each file, line and the heading it now points at. That is the stable form:
  // it is green while the fix holds and reddens the moment either comment reverts to §106.
  { name: 'this tree: both offenders repointed at §121', dir: ROOT, expect: 0,
    must: [/RESULT: PASS/,
      /ok\s+services\/platform\/src\/main\/java\/com\/nexus\/catalog\/CollectionsController\.java:186: STATUS §121/,
      /ok\s+services\/platform\/src\/test\/java\/com\/nexus\/catalog\/CollectionsReadTest\.java:188: STATUS §121/] },
  { name: 'a two-file fixture whose comments say §121: green, with its counts pinned', fix: tree('fixed', {
      'services/catalog/Ctrl.java': CTRL.replace('%s', '121'),
      'services/catalog/CtrlTest.java': CTRL.replace('%s', '121') }), expect: 0,
    must: [/RESULT: PASS/, /citations\s+2\b/, /mentions\s+0\b/] },
  { name: 'a citation to a section that is not there', fix: tree('bogus', {
      'services/catalog/Ctrl.java': CTRL.replace('%s', '99999') }), expect: 1,
    must: [/BAD/, /## 99999\. /, /RESULT: FAIL/] },
  { name: 'the same token inside a code span: a mention, not judged', fix: tree('mention', {
      'docs/NOTE.md': 'the bad form is written `STATUS §99999` in the source\n' }), expect: 0,
    must: [/citations\s+0\b/, /mentions\s+1\b/, /RESULT: PASS/] },
  { name: 'a tree with no spelled token at all', fix: tree('quiet', {
      'services/catalog/Ctrl.java': 'package com.nexus.catalog;\npublic class Ctrl {}\n' }), expect: 2,
    must: [/NOT CHECKED/, /saw no `STATUS §NN` token/] },
  { name: 'a HEAD revision that does not resolve', headRev: 'no-such-rev-4f2a', dir: ROOT, expect: 2,
    must: [/NOT CHECKED/] },
  { name: 'the shared exclusion is this reader\'s directory answer: a plant under data/seed/out_smoke is not read, its control is',
    fix: EXC_PLANT, expect: 0, must: [/RESULT: PASS/, /files scanned\s+1\b/, /citations\s+1\b/, /ok .*Ctrl\.java:2: STATUS §121/],
    absent: [/99999/] },
  { name: 'the same fixture through a copy of this reader given back its private list: the plant is charged (D199 witnesses itself)',
    fix: EXC_PLANT, reader: MUTANT, expect: 1, must: [/RESULT: FAIL/, /## 99999\. /, /files scanned\s+2\b/] },
];

let fails = 0;
for (const arm of ARMS) {
  const args = [arm.reader || CHECKER, '--head-rev', arm.headRev || 'HEAD'];
  if (arm.fix) args.push('--dir', arm.fix);
  let out, code;
  try {
    out = execFileSync('node', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
    code = 0;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = arm.must.filter((re) => !re.test(out));
  // `absent` is a claim too: an arm that says a string must not appear has to be the one that looks for it,
  // otherwise the field is decoration and the arm green regardless (D196's vocabulary list, arriving here).
  const found = (arm.absent || []).filter((re) => re.test(out));
  const ok = code === arm.expect && missed.length === 0 && found.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${arm.expect} expected, ${code} printed   ${arm.name}`);
  if (code !== arm.expect) console.log(`        verdict differs — printed: ${(out.match(/RESULT.*/) || ['<no RESULT line>']).join(' | ')}`);
  for (const m of missed) console.log(`        expected text missing: ${m}\n${out.split('\n').slice(0, 8).map((l) => '        | ' + l).join('\n')}`);
  for (const m of found) console.log(`        text that must not appear was found: ${m}`);
}
rmSync(MUTANT, { force: true });
console.log(`\n  ${ARMS.length} arms · ${ARMS.length - fails} held · ${fails} missed`);
console.log('  grammar: a citation is `STATUS §NN` outside a code span and must resolve to a `## N. ` heading at');
console.log('           HEAD; the same string inside backticks is a mention of it, counted and printed, not');
console.log('           judged — otherwise this repository would red on the sections that report the defect.');
if (fails) { console.log('\nRESULT: FAIL — the citation checker does not do what its arms claim'); process.exit(1); }
console.log('\nRESULT: PASS — reddens on a pointer to a section that is not there, stays green on the fix and on a quotation');
