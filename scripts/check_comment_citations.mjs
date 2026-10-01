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
const ledges = { into: new Map(), outside: new Map(), openedByStep8: 0 };
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
    const dot = e.name.lastIndexOf('.');
    const ext = dot < 0 ? '(no extension)' : e.name.slice(dot);
    if (!COMMENT[ext]) {
      unmapped.set(ext, (unmapped.get(ext) ?? 0) + 1);
      const rel = relative(PLANE, abs).replace(/\\/g, '/');
      if (LEDGER_FILES.has(rel)) ledges.openedByStep8 += 1;
      else tally(LEDGER_EXT.test(e.name) ? ledges.into : ledges.outside, ext, citeCount(abs, rx));
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
  return [
    `  ext coverage       ${mappedFiles.count} file(s) read across ${Object.keys(COMMENT).length} mapped ext(s); `
      + `${unmapped.size} unwalked ext(s): ${flat.slice(0, 12).join(' ') || '(none)'}`
      + `${unmapped.size > 12 ? `, +${unmapped.size - 12} more name(s) not shown` : ''} — reported, not judged`,
    `  prose, no reader   ${into.text} — inside step 8's own cite-target predicate, outside this census's table,`
      + ` and not one of the ${LEDGER_FILES.size} file(s) step 8 names as prose (it opens ${ledges.openedByStep8} here)`,
    `  outside both       ${outside.text} — neither reader's predicate accepts these; their bytes are scanned as`
      + ' text, so a binary file can be listed and contribute nothing',
  ].join('\n');
}

function collect(rx) {
  const rows = [];
  for (const [abs, ext] of walk(PLANE, rx)) {
    const rel = relative(PLANE, abs).replace(/\\/g, '/');
    if (EXCLUDE_PREFIX.some((p) => rel.startsWith(p))) continue;
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
// `NOT CHECKED` joins the pattern list because D159's own harness tripped over its absence: step 8 refused a
// plant whose every citation pointed outside the index, step 9 reported `NOT RUN (exit 2)` — correctly — and
// printed nothing explaining it, because the only line the child had written was filtered out here. A guard that
// says "the reader failed" while hiding the reader's sentence about why leaves the operator to re-derive it.
console.log(out.split('\n').filter((l) => /citations|offender|headings|tokens|files cited|NOT FOUND|AMBIGUOUS|PAST|BACKWARDS|ZERO|is empty|untracked targets|uncommitted targets|Error|Cannot find|NOT CHECKED|RESULT:/.test(l)).join('\n'));
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
