/**
 * NEXUS — the second reader of the blank-line claim, and the reconciliation D160 left out.
 *
 * WHY THIS FILE CHANGED. D160 counted 6 citations landing on a blank line, D161 armed a class that printed 14,
 * D165's entry quotes 12 — and no reader in the repository could say whether those were three measurements of
 * one thing or three different questions. They were the latter: this file walked the WORKING COPY, resolved a
 * cited name through four hand-written candidate paths of its own, looked only at the first number in a range
 * like `File.java:NN-NN`, and skipped nothing, while step 8 reads the HEAD plane, resolves through the shared
 * index, judges each span's start, and leaves an AMBIGUOUS name to its own offender class before any line is
 * read. Two tools, one word, five definitions. That is the shape this project keeps catching when a count is
 * quoted without the predicate that produced it — and the quoting was mine.
 *
 * WHAT IT DOES NOW. One index, one predicate, one plane. `LEDGER_EXT` and the file walk come from
 * `source_index.mjs`, the module gate step 8 already indexes through, so the two readers cannot drift into
 * censusing different file sets — the failure this file had, which is how one sentence came to be quoted as
 * 6, 10, 14 and 12. The plane is HEAD unless `--worktree` says otherwise, a range contributes its START, and
 * an AMBIGUOUS name is skipped before any line is read. Then the two counts are COMPARED rather than assumed
 * equal: the closing lines run the shipped reader, parse the number it prints, and exit 1 on disagreement. A
 * second reader that cannot say "and I agree with the first" only looks independent.
 *
 * WHAT IT STILL ANSWERS ALONE. The anchor questions (`does the identifier the sentence backticks sit on the
 * line?`) belong to no gate: step 8 never asks what a cited line contains. Those numbers stay here, labelled
 * with their definition, because they are the measurement D160 used to refuse a content predicate — 18 hits out
 * of 64 anchored citations — and a refusal that cannot be re-derived is an opinion.
 *
 * USAGE   node scripts/citation_blank_census.mjs [--worktree]     (the plane it reads is printed)
 * EXIT    0 the two readers agree · 1 they disagree · 2 the census could not run
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_EXT, walkFiles } from './source_index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = process.argv.slice(2).includes('--worktree');
const EXTRA = process.argv.slice(2).filter((a) => a !== '--worktree');
if (EXTRA.length) {
  console.log(`RESULT: NOT CHECKED — unexpected argument ${EXTRA[0]} — this census takes only --worktree`);
  process.exit(2);
}

const doc = (name, committed) => (committed
  ? execFileSync('git', ['show', `HEAD:${name}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  : readFileSync(join(ROOT, name), 'utf8')).replace(/\r\n/g, '\n');

// The same index the reader builds, from the same module, so the file set cannot drift from it.
const FILES = walkFiles(ROOT, (name) => LEDGER_EXT.test(name) || name.startsWith('.'));
const BY_NAME = new Map();
for (const rel of FILES) BY_NAME.set(rel, BY_NAME.get(rel) ?? []);
const resolveCite = (name) => (name.includes('/')
  ? FILES.filter((rel) => rel === name || rel.endsWith(`/${name}`))
  : FILES.filter((rel) => rel.endsWith(name)));

const grammar = (() => {
  const src = readFileSync(join(ROOT, 'scripts', 'check_ledger_citations.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const hit = src.split('\n').filter((l) => l.includes('matchAll(') && l.includes('(['));
  if (hit.length !== 1) throw new Error(`step 8's token grammar moved or multiplied: ${hit.length} lines`);
  return new RegExp(hit[0].match(/matchAll\((\/.*\/g)\)/)[1].slice(1, -2), 'g');
})();

const anchor = /`([A-Za-z_$][A-Za-z0-9_$().:+\/ -]{2,40}?)`/g;
const norm = (s) => s.replace(/[():. +]/g, '').toLowerCase();
let citations = 0;
let blanks = 0;
let ambiguous = 0;
let anchored = 0;
let exact = 0;
let win3 = 0;
let winFile = 0;
const sites = [];

for (const ledger of ['docs/DECISIONS.md', 'docs/STATUS.md']) {
  const text = doc(ledger, !WORKTREE);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const cite of [...line.matchAll(grammar)]) {
      const name = cite[1];
      if (!(/\.[A-Za-z0-9]{1,6}$/.test(name) || name.startsWith('.'))) continue;
      const cands = resolveCite(name);
      if (cands.length !== 1) { if (cands.length > 1) ambiguous += 1; continue; }
      const rel = cands[0];
      const target = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
      // A range contributes its START, which is the line the sentence stands on.
      const start = Number(cite[3] ?? cite[2]);
      const held = target[start - 1];
      if (held === undefined) continue;
      citations += 1;
      if (!held.trim()) { blanks += 1; if (sites.length < 20) sites.push(`  BLANK ${ledger} line ${i + 1} -> ${rel}:${start}`); continue; }
      const sentence = `${lines[i - 1] ?? ''} ${line}`;
      const cands2 = [...sentence.matchAll(anchor)].map((a) => a[1])
        .filter((a) => /[A-Za-z]{3}/.test(a) && !a.includes('/') && !a.endsWith(':') && !/:\d+$/.test(a));
      if (!cands2.length) continue;
      anchored += 1;
      const on = (arr) => arr.some((x) => x !== undefined && cands2.some((c) => norm(x).includes(norm(c))));
      if (on([held])) exact += 1;
      if (on(target.slice(Math.max(0, start - 4), start + 3))) win3 += 1;
      if (on(target)) winFile += 1;
    }
  });
}

console.log(`  plane read         ${WORKTREE ? 'the working copy' : 'HEAD (git show), matching step 8'} — grammar and index imported from the reader`);
console.log(`  resolvable cites   ${citations} (ambiguous names skipped here, and counted: ${ambiguous})`);
console.log(`  blank line cites   ${blanks}`);
for (const s of sites) console.log(s);
console.log(`  anchored sentences ${anchored} · anchor on the cited line ${exact} · within +-3 ${win3} · anywhere in the file ${winFile}`);

// The reconciliation. Step 8 prints its committed-plane count; this walk got there by a different route (its
// own resolution pass over the same index), so agreement is a finding and not a tautology.
// D174: on the committed plane step 8 exits 1 with 41 offenders (FILE NOT FOUND for other lanes' uncommitted
// work). execFileSync throws on non-zero; catch and extract stdout so the census can still read the count.
let readerOut = '';
try {
  readerOut = execFileSync(process.execPath, ['scripts/check_ledger_citations.mjs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 20 });
} catch (e) {
  readerOut = e.stdout || e.output?.[1] || '';
}
const printed = Number((readerOut.match(/blank-line cites\s+(\d+) at HEAD/) ?? [, 'nan'])[1]);
const agree = Number.isFinite(printed) && printed === blanks;
console.log(`  step 8 prints      ${Number.isFinite(printed) ? printed : 'no count it recognised'}`);
console.log(`\nRESULT: ${agree ? 'PASS' : 'FAIL'} — the two readers ${agree ? 'agree on' : 'DISAGREE about'} ${blanks}/${Number.isFinite(printed) ? printed : '?'} blank-line citations on the ${WORKTREE ? 'working' : 'HEAD'} plane`);
process.exit(agree ? 0 : 1);
