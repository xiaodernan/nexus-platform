#!/usr/bin/env node
/**
 * NEXUS — the comment plane's citation census, as a gate step (D93 built the reader, D94 set the convention,
 * this is the two becoming something that runs on its own).
 *
 * WHAT IT READS: citation-shaped tokens inside comments of source files — the prose that cites another file
 * by line. `scripts/check_ledger_citations.mjs` (step 8) scores the ledgers in docs/ and never opens a source
 * comment, so a sentence in a JSDoc block could claim a line that does not exist. D93 measured that plane at
 * 68 tokens with 5 offenders and found all five were grammar examples written in claim shape; D94 retired
 * them under the placeholder convention — a grammar example writes its digits as NN, where a real cite writes
 * digits, so the shape stays legible and does not read as a claim.
 *
 * WHAT IT DOES NOT DO: resolve anything itself. The token grammar is sliced out of the step-8 checker at run
 * time, and the scoring is done by running that same checker over the generated list. One resolver, so this
 * script cannot drift from the gate it feeds — the D85 objection to a second hand list, applied to a regex.
 * The directory exclusion comes from `scripts/source_index.mjs` for the same reason (D180); the one file
 * predicate this script still owns is which extensions carry comments, which is a different question from
 * which directories are the repository's own text.
 *
 * Usage: node scripts/check_comment_citations.mjs [--verbose]
 * Exit:  0 the plane is clean; 1 a citation does not resolve; 2 the scan itself is not trustworthy.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';
import { VENDOR_DIRS, LEDGER_EXT } from './source_index.mjs';

// Flags are read here rather than assumed, and an unrecognised one stops the run: a scan that quietly ignored
// `--plane=/some/dir` reported the repository as clean twice in a row while the operator believed it was
// looking at something else. An option that fails to fail is worse than one that is missing.
function fail(msg) { console.error(`check_comment_citations.mjs: ${msg}`); process.exit(2); }

// D159 closed the second half of that sentence for this reader. Its own loop accepted both spellings but never
// checked what it had just swallowed, so `--plane --verbose` — a caller who asked for a directory and forgot to
// name it — took `--verbose` as the directory, tried to scandir it, and died with an uncaught ENOENT at exit 1.
// A crash is not a refusal: it prints a stack trace instead of a verdict, and exit 1 is this file's code for
// "the citations are wrong", so a mistyped request reported a finding it never computed. The shared parser
// refuses that request by name, and `--verbose` is now read once instead of twice (the tail of this file used
// to ask `process.argv` again, which is how a third dialect gets born).
const FLAGS = {
  '--plane': { kind: 'value', unit: 'directory' },
  '--checker': { kind: 'value', unit: 'reader file' },
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) fail(parsed.reason);
const VERBOSE = parsed.switches.includes('--verbose');
const planeArg = parsed.value['--plane'] ?? null;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// D192 — the resolver below can be aimed at another copy of step 8, for the same reason `--plane` exists: the
// floor that this file's offender count answers to is only trustworthy if the case where the count is absent
// can be reached without editing the shipped bytes. falsify_comment_plane.mjs plants a step 8 whose carrier
// line is renamed; without this seam the floor would have shipped untested, which is the D165 lesson repeated.
const CHECKER = parsed.value['--checker'] ? resolve(parsed.value['--checker'])
  : join(ROOT, 'scripts', 'check_ledger_citations.mjs');

// Which tree's comments are censused. It defaults to the repository the script is installed in, and can be
// pointed at another directory — a worktree, a subproject, or an empty one — while the resolver stays the
// checker this file slices its grammar from. The reason a real flag exists rather than a constant: the
// "nothing was read" guard below is only trustworthy if the empty case can be reached without editing the
// shipped bytes. `--plane` is also the shape D96 named as the acceptable seam: an interface someone would use
// for a reason, which happens to be testable.
const PLANE = planeArg ? resolve(planeArg) : ROOT;
// D208 — measured while arming the rows below: `--plane` at a directory that is not there threw out of the walk
// with an uncaught ENOENT at exit 1, which is this file's code for "a citation is wrong" and prints a stack
// instead of a verdict. D159 ruled on that exact shape for a mistyped value; a mistyped *path* is the same
// request wearing the same wrong code.
try { readdirSync(PLANE); } catch (e) {
  fail(`--plane names a directory this run cannot open (${e.code ?? e.message}): ${PLANE}`);
}

// Comment marker(s) per extension, tested anywhere on the line so a trailing `# see x.py:NN` counts. The cost
// is that a string containing `--` or `//` can read as a comment: this over-reports rather than hides.
const COMMENT = {
  '.sql': [/--/],
  '.sh': [/(^|\s)#/, /\/\//], '.py': [/(^|\s)#/], '.yml': [/(^|\s)#/], '.yaml': [/(^|\s)#/],
  '.java': [/\/\//, /^\s*\*/, /\/\*/], '.mjs': [/\/\//, /^\s*\*/, /\/\*/], '.cjs': [/\/\//, /^\s*\*/, /\/\*/],
  '.js': [/\/\//, /^\s*\*/, /\/\*/], '.ts': [/\/\//, /^\s*\*/, /\/\*/], '.tsx': [/\/\//, /^\s*\*/, /\/\*/],
  // D207 — measured on this repository: at line 36 of `apps/ai/pyproject.toml` a `#` comment cites the CI workflow
  // by file and line, and this table had no `.toml` row, so the census never opened the file. TOML's comment
  // syntax is `#` to end of line, the same shape `.py` and `.yml` already declare. No other name is added on the
  // strength of this unit: the extensions the plane holds but this table does not are printed below as a
  // disclosure, so the next one that ships is seen rather than inferred. (The two files are named without their
  // line numbers on purpose — writing a file-and-line pair in a comment here would add a citation site to the very
  // census whose coverage this row reports, and the claim would then be about my own prose.)
  '.toml': [/(^|\s)#/],
};
// The directory exclusion is `source_index.mjs`'s one list, imported rather than copied. This file kept a
// private 15-name SKIP until the fold ruled at D181 and landed in 656ab7e: the two lists shared 10 names and
// drifted in both directions -- it carried `out_smoke`, `vendor`, `.qoder`, `.specraft` and `logs`, it lacked
// `.pytest_cache`, `.mypy_cache`, `.ruff_cache` and `.tmp-out`, so steps 7 and 8 walked the gitignored
// `data/seed/out_smoke/` while this step skipped it. The fold took the SHORTER list, so all three readers then
// walked those five directories until D197 shipped the union; `source_index.mjs`'s header owns that measurement.
// One list either way, so a directory that is not the repository's own text is excluded by all three or none.
// docs/ is step 8's own plane; scoring it from here too would count its citations twice and blame the wrong
// section when one fails.
const EXCLUDE_PREFIX = ['docs/'];

/** The step-8 grammar, read out of the shipped file rather than copied into this one. */
function grammar() {
  // D192: `--checker` makes this open a file the operator named, and an unreadable one threw out of the reader
  // at exit 1 — a crash wearing this file's code for "a citation is wrong", which is D159's defect arriving at
  // a brand-new seam. Refuse with 2 and say which file could not be opened.
  let text;
  try { text = readFileSync(CHECKER, 'utf8'); } catch (e) {
    fail(`the step-8 reader named by --checker could not be opened (${e.code ?? e.message}): ${CHECKER}`);
  }
  const lines = text.split(/\r?\n/);
  const hit = lines.filter((l) => l.includes('matchAll(') && l.includes('(['));
  if (hit.length !== 1) throw new Error(`step 8's token grammar moved or multiplied: ${hit.length} lines match`);
  const lit = hit[0].match(/matchAll\((\/.*\/g)\)/);
  if (!lit) throw new Error(`cannot read the regex literal out of: ${hit[0].trim()}`);
  const body = lit[1].slice(1, -2);
  console.log(`  grammar sliced   out of scripts/check_ledger_citations.mjs (${body.length} chars, /g)`);
  return new RegExp(body, 'g');
}

/** Extensions the plane holds that COMMENT has no row for, and how many files of each: collected by the same walk
 *  that produces the census, so the count below cannot describe a narrower scan than the one that ran. */
const unmapped = new Map();
const mappedFiles = { count: 0 };
// D210 — mapped files this census skips by PATH. `EXCLUDE_PREFIX` was applied at read time (in `collect`), while
// `mappedFiles.count` was incremented at walk time for every file whose extension the table holds, so the coverage
// row said "N file(s) read" for files it then never opened. Measured today: 0 of the 12 mapped extensions has a
// file under `docs/`, so the count happened to be true — and a `.md` vocabulary row, which is the obvious next
// addition to this table, would silently turn 512 ledger citations into "read" numbers with none of the prose
// scored. Now the skip is decided where the file is seen, the skipped half is named, and the number can only
// describe files the census actually read.
// D211 — and a third: a file this census's table DOES hold, which step 8 nevertheless names as its own prose.
// `walk` consulted `LEDGER_FILES` only in the branch for extensions the table lacks, while the row below printed
// "and not one of the N file(s) step 8 names as prose ... a citation here is read by neither reader" for the
// path-skipped group without ever asking. Measured before this row existed: a step 8 whose declaration adds the
// plane's `docs/probe.py` prints `.py(1 file(s), 1 token(s))` in that group and still claims none of them is its
// prose, because the sentence was composed, not computed. Today it is true by accident — 0 of the 12 mapped
// extensions has a file under `docs/`, and both ledgers are `.md`, which the table lacks — and the same accident
// holds for the mirror case: a mapped-extension ledger OUTSIDE `docs/` would be read by both readers and its
// citations scored twice. So the identity is asked before the path, and the answer is its own group.
const ledges = { into: new Map(), outside: new Map(), skipped: new Map(), proseSkip: new Map(), opened: new Set() };

/** D208 — which files step 8 opens as *citing* prose, sliced out of step 8's own bytes.
 *
 *  The row D207 added reported only this table's own gaps, so it conflated two different fates: an extension with
 *  no row here is not necessarily prose nobody reads, because step 8 reads the files it names itself. Measured on
 *  this working copy: 30 `.md`, 9 `.txt` and 31 `.json` files sit outside `COMMENT` while `LEDGER_EXT` accepts them
 *  as cite targets, and between them they hold 99 citation-shaped tokens no reader ever scores — against 96 tokens
 *  this whole census does score. `docs/PLAN.md` alone accounts for 48 of them. The number that claim needs is the
 *  list step 8 reads, and that list is one line in step 8's file, so it is read from there rather than copied here
 *  (the same objection D85 raised against a second hand list, and the reason the grammar above is sliced too).
 *
 *  A slice that cannot find its declaration refuses the run: reporting a gap "measured against the ledgers" while
 *  having read no ledger list would print a number that may describe any population at all, which is the D157
 *  failure mode — a check that fails to fail. */
function ledgerFiles() {
  let text;
  try { text = readFileSync(CHECKER, 'utf8'); } catch (e) {
    fail(`the step-8 reader named by --checker could not be opened (${e.code ?? e.message}): ${CHECKER}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.includes('const LEDGERS ='));
  if (lines.length !== 1) {
    fail(`cannot say which prose step 8 reads — its ledger declaration matched ${lines.length} line(s) in ${CHECKER},`
      + ' and the "no reader opens these" row below is only true against the list that reader actually walks');
  }
  const lit = lines[0].match(/=== null \? \[([^\]]*)\]/);
  if (!lit) fail(`cannot read the default ledger array out of: ${lines[0].trim()}`);
  const names = [...lit[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) {
    fail(`step 8's ledger list sliced to 0 file(s) from ${CHECKER} — refusing to report a gap measured against no prose`);
  }
  return new Set(names);
}
const LEDGER_FILES = ledgerFiles();

/** Citation-shaped tokens in a file, counted the way the census counts them: per line, same grammar, same name
 *  filter. The grammar anchors on `^`, so matching the whole text at once is a different scan. */
function citeCount(abs, rx) {
  let lines;
  try { lines = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n'); } catch { return null; }
  let n = 0;
  for (const line of lines) {
    for (const m of line.matchAll(rx)) {
      const name = m[1];
      if (!(/\.[A-Za-z0-9]{1,6}$/.test(name) || name.startsWith('.'))) continue;
      n += 1;
    }
  }
  return n;
}

/** The two fates an extension with no `COMMENT` row can have, split by the other reader's own predicate. */
function tally(group, ext, tokens) {
  const cur = group.get(ext) ?? { files: 0, tokens: 0 };
  cur.files += 1;
  cur.tokens += tokens ?? 0;
  group.set(ext, cur);
}

function* walk(dir, rx) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!VENDOR_DIRS.has(e.name)) yield* walk(join(dir, e.name), rx); continue; }
    if (!e.isFile()) continue;
    const abs = join(dir, e.name);
    const rel = relative(PLANE, abs).replace(/\\/g, '/');
    const dot = e.name.lastIndexOf('.');
    const ext = dot < 0 ? '(no extension)' : e.name.slice(dot);
    if (!COMMENT[ext]) {
      unmapped.set(ext, (unmapped.get(ext) ?? 0) + 1);
      if (LEDGER_FILES.has(rel)) ledges.opened.add(rel);
      else tally(LEDGER_EXT.test(e.name) ? ledges.into : ledges.outside, ext, citeCount(abs, rx));
      continue;
    }
    // D210 — the path exclusion decides here, where the file is first seen, and the file it skips is named rather
    // than counted as read. `citeCount` is the same scan the unmapped rows use, so a skipped file's citations are
    // counted by the reader's grammar and not by a second guess at it.
    // D211 — identity before path: a file step 8 reads as its own prose is not this census's comment plane, and
    // that is true wherever it lives, not only under the prefix. The path rule was protecting the two ledgers by
    // accident (`docs/` holds no mapped-extension file); asking the declaration is what keeps the row below true
    // when a vocabulary row lands whose names step 8 also reads.
    const isProse = LEDGER_FILES.has(rel);
    if (isProse || EXCLUDE_PREFIX.some((p) => rel.startsWith(p))) {
      tally(isProse ? ledges.proseSkip : ledges.skipped, ext, citeCount(abs, rx));
      continue;
    }
    mappedFiles.count += 1;
    yield [abs, ext];
  }
}

/** One `<ext>(N)` name list per group, capped so a build-output plane cannot print four hundred columns at the
 *  operator. The cap is counted, never silently dropped. */
function nameList(map, cap) {
  const names = [...map.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]));
  const shown = names.slice(0, cap).map(([e, c]) => `${e}(${c.files} file(s), ${c.tokens} token(s))`).join(' ');
  const rest = names.length - Math.min(names.length, cap);
  const total = names.reduce((s, [, c]) => s + c.tokens, 0);
  const files = names.reduce((s, [, c]) => s + c.files, 0);
  return { text: `${names.length} ext(s), ${files} file(s), ${total} token(s): ${shown || '(none)'}`
    + `${rest > 0 ? `, +${rest} more name(s) not shown` : ''}`, names: names.length, files, total };
}

/** The disclosure rows' own text. */
function coverageRow() {
  const flat = [...unmapped.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([e, n]) => `${e}(${n})`);
  const into = nameList(ledges.into, 6);
  const outside = nameList(ledges.outside, 4);
  const skipped = nameList(ledges.skipped, 4);
  const prose = nameList(ledges.proseSkip, 4);
  const openedList = [...ledges.opened].sort();
  const openedText = `${openedList.length} file(s)`
    + (openedList.length === 0 ? ''
      : ` (${openedList.slice(0, 4).join(', ')}`
        + `${openedList.length > 4 ? `, +${openedList.length - 4} more name(s) not shown` : ''})`);
  return [
    `  ext coverage       ${mappedFiles.count} file(s) read across ${Object.keys(COMMENT).length} mapped ext(s); `
      + `${unmapped.size} unwalked ext(s): ${flat.slice(0, 12).join(' ') || '(none)'}`
      + `${unmapped.size > 12 ? `, +${unmapped.size - 12} more name(s) not shown` : ''} — reported, not judged`,
    // D211 — the group whose existence the row below could only assert. `0 file(s)` is this repository's current
    // state for the same reason the prefix-skip count was 0: the two files step 8 reads are `.md`, and the table
    // has no `.md` row. The difference is that nothing here depends on that staying true — the counter is filled
    // by the test that skips the file, so a vocabulary row naming one of step 8's ledgers moves this number.
    `  table, prose-skip  ${prose.text} — inside this census's vocabulary and named by step 8 as one of the`
      + ` ${LEDGER_FILES.size} file(s) it reads as its own prose: step 8 scores those citations and this census`
      + ' never opens the file, so a citation there is scored once rather than twice',
    // D210 — the mapped half the path rule skips. The number is the row's own claim to keep: before this unit the
    // line above counted these files as read and this row did not exist, so the only way to see the skip was to
    // notice that a file named nowhere had no bullets. `0 file(s)` is the honest current state of this repository
    // and `(none)` is what a future run must print too, until a vocabulary row lands whose files live under
    // `${EXCLUDE_PREFIX}` — at which point this row carries the number and the coverage row stays right.
    `  table, prefix-skip ${skipped.text} — inside this census's vocabulary but under its own path rule`
      + ` (${[...EXCLUDE_PREFIX].join(', ')}), and not one of the ${LEDGER_FILES.size} file(s) step 8 names as`
      + ' prose — those are counted by the `table, prose-skip` row, never here: a citation in this group is read'
      + ' by neither reader',
    // D212 — measured on this repository, not assumed: both ledgers are `.md`, which `COMMENT` has no row for, so
    // the count this row used to print was 2 while the row above's was 0 — and the sentence next to it claimed the
    // group holds "not one of the 2 file(s) step 8 names as prose". A bare number could not say which of those two
    // fates it described, so the split is printed as two clauses and the files are named: whichever way the
    // extension table moves, the reader sees which of step 8's ledgers this census pulled out of its own count.
    // D214 — that sentence then said "a citation in either group is scored by step 8 alone", and the group THIS row
    // counts is not one of the two it had just named. Measured on a plane written for the purpose (`notes/probe.json`
    // carrying one past-end citation, beside `src/probe.sql`): step 9 printed `.json(1 file(s), 1 token(s))` here and
    // `RESULT: PASS` with `strict offenders 0`, while handing the same bytes to step 8 through its own declaration
    // (`--text notes/probe.json`) printed `strict offenders 1` and the `PAST EOF` class. So a non-declared file in
    // this group is opened by neither reader, and only the files step 8's declaration names have a reader at all. The
    // two fates are now counted separately, because the row's title said "no reader" while its sentence promised one.
    `  prose, no reader   ${into.text} — inside step 8's own cite-target predicate, outside this census's table,`
      + ` and not one of the ${LEDGER_FILES.size} file(s) step 8 names as prose: ${prose.files} of those hold a`
      + ` mapped extension and are named by the \`table, prose-skip\` row above, while ${openedText} have no`
      + ' `COMMENT` row here and are pulled out of the count above. Two fates, counted apart: a citation in one of'
      + ` the ${openedList.length + prose.files} file(s) those two clauses name is scored by step 8 alone, because`
      + ` step 8 declares it, while a citation in the ${into.files} file(s) and ${into.total} token(s) this row`
      + ` counts is opened by neither reader — step 8 opens only the ${LEDGER_FILES.size} file(s) its declaration`
      + ' names, and this census has no `COMMENT` row for these extensions — so those tokens are counted here and'
      + ' judged nowhere',
    `  outside both       ${outside.text} — neither reader's predicate accepts these; their bytes are scanned as`
      + ' text, so a binary file can be listed and contribute nothing',
  ].join('\n');
}

function collect(rx) {
  const rows = [];
  for (const [abs, ext] of walk(PLANE, rx)) {
    const rel = relative(PLANE, abs).replace(/\\/g, '/');
    // D210 — no path filter here: `walk` is where a file is admitted or skipped, and it reports the skips. A second
    // copy of the rule at read time is how the coverage row came to count files this census never opened.
    let lines;
    try { lines = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n'); } catch { continue; }
    lines.forEach((line, i) => {
      if (!COMMENT[ext].some((m) => m.test(line))) return;
      for (const m of line.matchAll(rx)) {
        const name = m[1];
        if (!(/\.[A-Za-z0-9]{1,6}$/.test(name) || name.startsWith('.'))) continue;
        rows.push({ rel, at: i + 1, cite: `${name}:${m[2]}` });
      }
    });
  }
  return rows;
}

const rx = grammar();
const rows = collect(rx);
// Printed before the empty-census refusal, because a census that read nothing is exactly when the operator
// needs to know which extensions were never opened.
console.log(coverageRow());
if (rows.length === 0) {
  console.error(`COMMENT CITATIONS: 0 tokens found in the comment plane of ${PLANE}. A scan that reads`
    + ' nothing is not a green scan — check the extension and skip lists, or the --plane argument, before'
    + ' believing this run.');
  process.exit(2);
}

const dir = join(tmpdir(), 'nexus-comment-cites');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'census.md');
const PLANT_HEAD = [
  '# Comment-plane citation census (generated by scripts/check_comment_citations.mjs)',
  '',
  '## Source comments whose citations the ledger gate would not have read',
  '',
  'One bullet per citation-shaped token found in a comment. Provenance is spelled "at line N" rather than as',
  'a second citation, so the checker scores the claims and not this file\'s own bookkeeping.',
  '',
];
writeFileSync(file, [...PLANT_HEAD, ...rows.map((r) => `- in ${r.rel} at line ${r.at} -> ${r.cite}`)].join('\n'), 'utf8');
// D205 — the plant's own line numbers, keyed to the comment that produced them. Step 8 attributes an offender to
// `<ledger> <section> :<line>`, and on this plane `<ledger>` is this generated file and `<section>` is the one
// heading every bullet shares, so the row a person gets names a census line rather than a source file: measured
// on this disk, the one offender printed as the plant's own path, its shared heading, line 59 and a target whose
// line is empty — and finding its author took a grep over the tree to the untracked reader that wrote it.
// The bullet's text already spells its provenance, so the map is not a second source of truth — it is the same
// `rows` array, read at the line numbers this write call just produced.
const bulletAt = new Map(rows.map((r, i) => [PLANT_HEAD.length + i + 1, r]));

const files = new Set(rows.map((r) => r.rel)).size;
console.log(`  plane censised   ${PLANE}`);
console.log(`  tokens found     ${rows.length} in ${files} file(s) of the comment plane`);
console.log('  untracked reads  the census is a backlog: every bullet here is prose somebody already wrote, so');
console.log('                   the reader is asked to count a cite whose target no commit holds, not to offend');
console.log('                   on it (D203). The fix for those rows is `git add` in the lane that wrote the');
console.log('                   file, which this gate has no authority to do. Every other class still judges.');
console.log(`  scored by        scripts/check_ledger_citations.mjs --text=${file} --untracked-backlog`);

let code = 0, out = '';
try {
  out = execFileSync(process.execPath, [CHECKER, `--text=${file}`, '--untracked-backlog'], { encoding: 'utf8' });
} catch (err) {
  code = err.status ?? 1;
  out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}
// D209 — what gets relayed from the child's report. The first version filtered on a keyword list, and step 8 prints
// its LIMITS paragraph as plain column-0 prose: a keyword match pulled the *middle* of a sentence out and dropped
// its beginning, so a clean plane's report contained the line "does not hold that path and FILE NOT FOUND speaks
// first." — an offender class name in a run that filed no offenders. Measured, not imagined: this harness's own
// D208/P1 arm was written against that fragment and predicted a red that does not exist, which is how the defect
// was found. Now the relay keeps the report's own rows (indented label lines and the `- ` bullets under them) and
// any line that carries a verdict, and when the child refused (exit 2) it relays everything — D159's ruling was
// that a refusal must pass its reason through, and on a refusal the prose IS the reason.
const VERDICT_LINE = /RESULT:|NOT CHECKED|NOT RUN|Error|Cannot find/;
console.log(out.split('\n')
  .filter((l) => code === 2 || /^\s/.test(l) || VERDICT_LINE.test(l))
  .join('\n'));
if (VERBOSE) console.log(out);
// A child that never produced a report has not refuted anything: it failed to run. Collapsing that into the
// offender branch — as the first version did, reporting `RESULT: FAIL … at least one does not` for a step 8
// that could not even load its own import — states a claim about a citation that was never examined.
const reported = /headings seen/.test(out);
if (!reported) {
  console.error(`\nRESULT: NOT RUN — step 8 produced no report (exit ${code}). A reader that crashed is not a`
    + ' citation that failed, and the two must not share a verdict line.');
  process.exit(2);
}
// The exit code is the verdict, but not the only one: this reader also answers to the count the child printed.
// D192 found the belt hanging on a nail that was never in the wall — it read `N offender(s)`, a wording only
// the DEFAULT plane prints, while every run here goes through `--text`, so the match list was empty on every
// plane and `[].every(n => n === 0)` is true for any report at all. Now the count comes from the one line step 8
// prints in every mode, and a report carrying no such count, or two of them, is a refusal: a belt that read no
// number is not a green, and one that read two has lost track of which plane it is judging.
const carriers = [...out.matchAll(/strict offenders\s+(\d+) offender\(s\)/g)];
if (carriers.length !== 1) {
  console.error(`\nRESULT: NOT RUN — step 8 printed ${carriers.length} strict-offender count(s) and this belt`
    + ` answers to exactly one (exit ${code}). Absence is not cleanliness, and ambiguity is not agreement.`);
  process.exit(2);
}
// D205 — name the author. Step 8's offender rows carry `<plant> <section> :<line>`; this map turns that line back
// into the comment the bullet was generated from. The rows are read from the child's own report rather than from
// `rows`, so a cite this census never collected cannot be attributed, and a row this map cannot place is a defect
// reported as one rather than a clean run with an empty block.
const authors = new Map();
let unplaced = 0;
for (const line of out.split('\n')) {
  if (!/^\s+- /.test(line) || !line.includes(`${file} `)) continue;
  const at = line.match(/ :(\d+)\b/);
  if (!at) continue;
  const row = bulletAt.get(Number(at[1]));
  if (row === undefined) { unplaced += 1; continue; }
  const detail = line.slice(line.indexOf(`${file} `) + file.length + 1).replace(/.*? :\d+\s+/, '');
  authors.set(`${row.rel}:${row.at}|${detail}`, { row, detail });
}
const strictCount = Number(carriers[0][1]);
if (authors.size > 0) {
  console.log('');
  console.log(`OFFENDER AUTHORS — the comment behind each offending row above (${authors.size} of ${strictCount} offender(s), ${unplaced} row(s) the plant does not account for):`);
  for (const { row, detail } of authors.values()) {
    console.log(`    - ${row.rel}:${row.at}  wrote the cite ${detail}`);
  }
}
// The vacuity guard, and its two sole witnesses: offenders reported but no author placed is an attribution block
// that read nothing, and a planted line the map cannot place is the plant and the census disagreeing about what
// this run wrote. Either one leaves the operator with a red and no file to open, which is the thing this block
// exists to prevent, so neither is allowed to print PASS.
if (strictCount > 0 && authors.size === 0) {
  console.error(`\nRESULT: NOT RUN — step 8 filed ${strictCount} offender row(s) naming this reader's own plant`
    + ` and none of them matched a bullet this census wrote (${rows.length} bullet(s)). An empty attribution block`
    + ' beside a red is not a green, and it is not a nameless red either.');
  process.exit(2);
}
if (unplaced > 0) {
  console.error(`\nRESULT: NOT RUN — ${unplaced} offender row(s) cited a plant line outside the ${rows.length}`
    + ' bullet(s) this census wrote, so the file the checker and the writer disagree about; the attribution would'
    + ' name the wrong comment.');
  process.exit(2);
}
const clean = code === 0 && strictCount === 0;
console.log(`\nRESULT: ${clean ? 'PASS' : 'FAIL'} — ${rows.length} comment-plane citation(s) across ${files} file(s), `
  + `${clean ? 'all resolving' : 'at least one does not — see the report above'} (step 8 exit ${code})`);
process.exit(clean ? 0 : 1);
