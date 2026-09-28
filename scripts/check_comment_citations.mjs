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
  '--verbose': { kind: 'switch' },
};
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) fail(parsed.reason);
const VERBOSE = parsed.switches.includes('--verbose');
const planeArg = parsed.value['--plane'] ?? null;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check_ledger_citations.mjs');

// Which tree's comments are censused. It defaults to the repository the script is installed in, and can be
// pointed at another directory — a worktree, a subproject, or an empty one — while the resolver stays the
// checker this file slices its grammar from. The reason a real flag exists rather than a constant: the
// "nothing was read" guard below is only trustworthy if the empty case can be reached without editing the
// shipped bytes. `--plane` is also the shape D96 named as the acceptable seam: an interface someone would use
// for a reason, which happens to be testable.
const PLANE = planeArg ? resolve(planeArg) : ROOT;

// Comment marker(s) per extension, tested anywhere on the line so a trailing `# see x.py:NN` counts. The cost
// is that a string containing `--` or `//` can read as a comment: this over-reports rather than hides.
const COMMENT = {
  '.sql': [/--/],
  '.sh': [/(^|\s)#/, /\/\//], '.py': [/(^|\s)#/], '.yml': [/(^|\s)#/], '.yaml': [/(^|\s)#/],
  '.java': [/\/\//, /^\s*\*/, /\/\*/], '.mjs': [/\/\//, /^\s*\*/, /\/\*/], '.cjs': [/\/\//, /^\s*\*/, /\/\*/],
  '.js': [/\/\//, /^\s*\*/, /\/\*/], '.ts': [/\/\//, /^\s*\*/, /\/\*/], '.tsx': [/\/\//, /^\s*\*/, /\/\*/],
};
const SKIP = new Set(['.git', 'node_modules', 'out', 'out_smoke', '__pycache__', '.next', 'target', 'dist',
  'coverage', '.venv', 'vendor', '.qoder', '.specraft', 'build', 'logs']);
// docs/ is step 8's own plane; scoring it from here too would count its citations twice and blame the wrong
// section when one fails.
const EXCLUDE_PREFIX = ['docs/'];

/** The step-8 grammar, read out of the shipped file rather than copied into this one. */
function grammar() {
  const lines = readFileSync(CHECKER, 'utf8').split(/\r?\n/);
  const hit = lines.filter((l) => l.includes('matchAll(') && l.includes('(['));
  if (hit.length !== 1) throw new Error(`step 8's token grammar moved or multiplied: ${hit.length} lines match`);
  const lit = hit[0].match(/matchAll\((\/.*\/g)\)/);
  if (!lit) throw new Error(`cannot read the regex literal out of: ${hit[0].trim()}`);
  const body = lit[1].slice(1, -2);
  console.log(`  grammar sliced   out of scripts/check_ledger_citations.mjs (${body.length} chars, /g)`);
  return new RegExp(body, 'g');
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(join(dir, e.name)); continue; }
    if (!e.isFile()) continue;
    const ext = e.name.slice(e.name.lastIndexOf('.'));
    if (COMMENT[ext]) yield [join(dir, e.name), ext];
  }
}

function collect(rx) {
  const rows = [];
  for (const [abs, ext] of walk(PLANE)) {
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

const rows = collect(grammar());
if (rows.length === 0) {
  console.error(`COMMENT CITATIONS: 0 tokens found in the comment plane of ${PLANE}. A scan that reads`
    + ' nothing is not a green scan — check the extension and skip lists, or the --plane argument, before'
    + ' believing this run.');
  process.exit(2);
}

const dir = join(tmpdir(), 'nexus-comment-cites');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'census.md');
writeFileSync(file, [
  '# Comment-plane citation census (generated by scripts/check_comment_citations.mjs)',
  '',
  '## Source comments whose citations the ledger gate would not have read',
  '',
  'One bullet per citation-shaped token found in a comment. Provenance is spelled "at line N" rather than as',
  'a second citation, so the checker scores the claims and not this file\'s own bookkeeping.',
  '',
  ...rows.map((r) => `- in ${r.rel} at line ${r.at} -> ${r.cite}`),
].join('\n'), 'utf8');

const files = new Set(rows.map((r) => r.rel)).size;
console.log(`  plane censised   ${PLANE}`);
console.log(`  tokens found     ${rows.length} in ${files} file(s) of the comment plane`);
console.log(`  scored by        scripts/check_ledger_citations.mjs --text=${file}`);

let code = 0, out = '';
try {
  out = execFileSync(process.execPath, [CHECKER, `--text=${file}`], { encoding: 'utf8' });
} catch (err) {
  code = err.status ?? 1;
  out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}
// `NOT CHECKED` joins the pattern list because D159's own harness tripped over its absence: step 8 refused a
// plant whose every citation pointed outside the index, step 9 reported `NOT RUN (exit 2)` — correctly — and
// printed nothing explaining it, because the only line the child had written was filtered out here. A guard that
// says "the reader failed" while hiding the reader's sentence about why leaves the operator to re-derive it.
console.log(out.split('\n').filter((l) => /citations|offender|headings|tokens|files cited|NOT FOUND|AMBIGUOUS|PAST|BACKWARDS|ZERO|Error|Cannot find|NOT CHECKED|RESULT:/.test(l)).join('\n'));
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
// The exit code is the verdict, not a phrase in the report: step 8 prints its offender counts differently in
// `--text` mode than in its HEAD-strict default, and a green claimed from wording is a green that can be
// renamed out from under the check. A count that is not zero is still caught here, as a belt to that braces.
const seen = [...out.matchAll(/(\d+)\s+offender\(s\)/g)].map((m) => Number(m[1]));
const clean = code === 0 && seen.every((n) => n === 0);
console.log(`\nRESULT: ${clean ? 'PASS' : 'FAIL'} — ${rows.length} comment-plane citation(s) across ${files} file(s), `
  + `${clean ? 'all resolving' : 'at least one does not — see the report above'} (step 8 exit ${code})`);
process.exit(clean ? 0 : 1);
