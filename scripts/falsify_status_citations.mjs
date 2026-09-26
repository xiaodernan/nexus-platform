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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
const ARMS = [
  // The control arm deliberately does not pin this tree's token counts. The census includes the harness
  // that runs it — writing a line that mentions `STATUS §NN` in a script adds a mention to the very
  // count an arm would assert — so a pinned count here would be a date, not a constant (D116 found that
  // the same way, one unit ago). The two named offenders are the stable claim: they are other lanes'
  // committed files, and this arm goes green only when the platform lane fixes them, which is #79 closing.
  { name: 'this tree: two real defects, both named', dir: ROOT, expect: 1,
    must: [/BAD\s+services\/platform\/src\/main\/java\/com\/nexus\/catalog\/CollectionsController\.java:186/,
      /BAD\s+services\/platform\/src\/test\/java\/com\/nexus\/catalog\/CollectionsReadTest\.java:188/,
      /RESULT: FAIL/] },
  { name: 'the fix §79 asks for: both comments say §121', fix: tree('fixed', {
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
];

let fails = 0;
for (const arm of ARMS) {
  const args = [CHECKER, '--head-rev', arm.headRev || 'HEAD'];
  if (arm.fix) args.push('--dir', arm.fix);
  let out, code;
  try {
    out = execFileSync('node', args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
    code = 0;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = arm.must.filter((re) => !re.test(out));
  const ok = code === arm.expect && missed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${arm.expect} expected, ${code} printed   ${arm.name}`);
  if (code !== arm.expect) console.log(`        verdict differs — printed: ${(out.match(/RESULT.*/) || ['<no RESULT line>']).join(' | ')}`);
  for (const m of missed) console.log(`        expected text missing: ${m}\n${out.split('\n').slice(0, 8).map((l) => '        | ' + l).join('\n')}`);
}
console.log(`\n  ${ARMS.length} arms · ${ARMS.length - fails} held · ${fails} missed`);
console.log('  grammar: a citation is `STATUS §NN` outside a code span and must resolve to a `## N. ` heading at');
console.log('           HEAD; the same string inside backticks is a mention of it, counted and printed, not');
console.log('           judged — otherwise this repository would red on the sections that report the defect.');
if (fails) { console.log('\nRESULT: FAIL — the citation checker does not do what its arms claim'); process.exit(1); }
console.log('\nRESULT: PASS — reddens on a pointer to a section that is not there, stays green on the fix and on a quotation');
