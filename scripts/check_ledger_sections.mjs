#!/usr/bin/env node
/**
 * NEXUS D116 — #68's class: the two planes of one ledger are allowed to disagree, and nothing said so for three days.
 *
 * `docs/STATUS.md` and `docs/DECISIONS.md` are written from two directions: a lane that stages a
 * HEAD-derived blob and commits it before mirroring (this lane's technique since D109, which is what
 * stranded nine sections — D115), and a lane that edits the working copy and commits it later or not at
 * all (which is what produced §123's merge — §123 is the committed home of the account the working copy
 * wrote as its §108, which is exactly the citation hazard this script's own headings cannot resolve).
 * Both are ordinary. The losses are specific and asymmetric:
 *
 *   HARD  a numbered section present at HEAD but absent from the working copy. Committing the file as it
 *         stands deletes committed history — §86 (e) named exactly this cost, and D115 paid it back.
 *         A duplicated section number is the same class: two sections claim one citation.
 *   NAMED a numbered section on disk but not at HEAD: uncommitted work. Not a failure — the normal
 *         middle of writing an entry — but D115's nine sections sat in that state for three days, so it
 *         is printed with its numbers on every run instead of being silently allowed.
 *
 * Usage: node scripts/check_ledger_sections.mjs [--head-rev <rev>] [--dir <checkout root>]
 * Exit: 0 the planes are consistent · 1 a committed heading is missing or a number is duplicated ·
 *       2 not checkable (D96's own answer: `git show` cannot spawn, a ledger cannot be read, or the
 *       heading pattern matches nothing — a reader that saw no headings did not check the headings).
 *
 * The heading patterns are each file's own house style: `## 42. title` in STATUS, `## D42 title` in
 * DECISIONS. A file whose pattern matches nothing is reported as NOT CHECKED rather than green, because
 * an empty set is what a renamed convention looks like from here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const REV = arg('--head-rev', 'HEAD');
const DIR = resolve(arg('--dir', ROOT));
const LEDGERS = [
  { path: 'docs/STATUS.md', re: /^## (\d+)\. /gm, kind: 'section' },
  { path: 'docs/DECISIONS.md', re: /^## (D\d+) /gm, kind: 'decision' },
];
const notChecked = (why) => { console.error(`RESULT: NOT CHECKED — ${why}`); process.exit(2); };

const headings = (text, re) => {
  const seen = new Map();
  for (const m of text.matchAll(re)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  return seen;
};

const bad = [];
const notes = [];
for (const led of LEDGERS) {
  let headText;
  try {
    headText = execFileSync('git', ['show', `${REV}:${led.path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch (e) {
    notChecked(`cannot read \`git show ${REV}:${led.path}\` — ${String(e.message).split('\n')[0]}`);
  }
  const diskPath = join(DIR, led.path);
  if (!existsSync(diskPath)) { notChecked(`${diskPath} does not exist, so its headings cannot be compared`); }
  const diskText = readFileSync(diskPath, 'utf8').replace(/\r\n/g, '\n');

  const atHead = headings(headText, led.re);
  const onDisk = headings(diskText, led.re);
  if (atHead.size === 0) notChecked(`${led.path} at ${REV} has no \`## N\` ${led.kind} headings — the pattern matched nothing, which is a renamed convention, not an empty ledger`);
  if (onDisk.size === 0) notChecked(`${diskPath} has no \`## N\` ${led.kind} headings — the pattern matched nothing`);

  const missing = [...atHead.keys()].filter((h) => !onDisk.has(h));
  const stranded = [...onDisk.keys()].filter((h) => !atHead.has(h));
  const dupAt = (map) => [...map.entries()].filter(([, n]) => n > 1).map(([h, n]) => `${h}×${n}`);
  const dups = [...dupAt(atHead).map((s) => `at ${REV}: ${s}`), ...dupAt(onDisk).map((s) => `on disk: ${s}`)];

  if (missing.length) bad.push(`${led.path}: ${missing.length} ${led.kind}(s) committed at ${REV} and absent from the working copy — committing the file as it stands deletes them: ${missing.join(', ')}`);
  if (dups.length) bad.push(`${led.path}: duplicated ${led.kind} numbers (${dups.join('; ')}) — two sections answer one citation`);
  if (stranded.length) notes.push(`${led.path}: ${stranded.length} ${led.kind}(s) on disk and not at ${REV} (uncommitted work): ${stranded.join(', ')}`);

  console.log(`  ${led.path.padEnd(18)} ${REV} ${atHead.size} ${led.kind}s · on disk ${onDisk.size}`
    + ` · missing ${missing.length} · uncommitted ${stranded.length} · duplicate numbers ${atHead.size ? dups.length : 0}`);
}

for (const n of notes) console.log(`  NOTE ${n}`);
for (const b of bad) console.log(`  FORK ${b}`);
if (bad.length) { console.log('\nRESULT: FAIL — the ledgers\' two planes disagree in a way that loses committed sections'); process.exit(1); }
console.log('\nRESULT: PASS — every committed heading is present on disk and no number is claimed twice'
  + '  (grammar: a heading is `## N. ` in STATUS, `## D N ` in DECISIONS; missing-from-disk or duplicated is'
  + ' the failure; disk-only is printed and allowed, because writing an entry starts there)');
